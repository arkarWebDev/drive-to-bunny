const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractMovFiles } = require('../src/extract');
const { makeZip } = require('./helpers');

test('extractMovFiles keeps only .MOV and skips junk entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-test-'));
  const outDir = path.join(dir, 'out');

  const zip = makeZip([
    { name: 'videos/01. welcome.MOV', data: Buffer.from('video-one-content') },
    { name: 'videos/photo.JPG', data: Buffer.from('jpeg') },
    { name: 'videos/note.txt', data: Buffer.from('txt') },
    { name: '__MACOSX/._01. welcome.MOV', data: Buffer.from('resource-fork') },
    { name: '.DS_Store', data: Buffer.from('store') },
  ]);
  const zipPath = path.join(dir, 'bundle.zip');
  fs.writeFileSync(zipPath, zip);

  const result = await extractMovFiles(zipPath, outDir, 0, ['mov']);

  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(result.files[0].name, '01._welcome.mov');
  assert.strictEqual(
    fs.readFileSync(result.files[0].localPath, 'utf8'),
    'video-one-content',
  );

  const outFiles = fs.readdirSync(outDir);
  assert.deepStrictEqual(outFiles, ['01._welcome.mov']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractMovFiles respects maxFileBytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-test-'));
  const outDir = path.join(dir, 'out');

  const zip = makeZip([
    { name: 'small.mov', data: Buffer.alloc(10, 'a') },
    { name: 'big.mov', data: Buffer.alloc(5000, 'b') },
  ]);
  const zipPath = path.join(dir, 'bundle.zip');
  fs.writeFileSync(zipPath, zip);

  const result = await extractMovFiles(zipPath, outDir, 1000, ['mov']);

  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(result.files[0].name, 'small.mov');
  assert.strictEqual(result.skippedCount, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractMovFiles honors the allowed extensions list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-test-'));
  const outDir = path.join(dir, 'out');

  const zip = makeZip([
    { name: 'a.mp4', data: Buffer.from('mp4-data') },
    { name: 'b.m4v', data: Buffer.from('m4v-data') },
    { name: 'c.mov', data: Buffer.from('mov-data') },
    { name: 'd.avi', data: Buffer.from('avi-data') },
  ]);
  const zipPath = path.join(dir, 'bundle.zip');
  fs.writeFileSync(zipPath, zip);

  const result = await extractMovFiles(zipPath, outDir, 0, ['mp4', 'm4v']);

  assert.strictEqual(result.files.length, 2);
  assert.deepStrictEqual(
    result.files.map((f) => f.name).sort(),
    ['a.mp4', 'b.m4v'],
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
