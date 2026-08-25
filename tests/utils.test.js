const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sanitizeFileName,
  uniqueFileName,
  formatBytes,
  splitTelegramMessage,
  isZipFile,
  isMovFile,
  isVideoFile,
  guessVideoExtension,
  mimeForExtension,
  throttle,
} = require('../src/utils');

function tmpFile(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utils-test-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, data);
  return { dir, filePath };
}

test('sanitizeFileName strips unsafe characters and lowercases extension', () => {
  assert.strictEqual(sanitizeFileName('My Video! (Final).MOV'), 'My_Video_Final.mov');
  assert.strictEqual(sanitizeFileName('héllo wörld.mov'), 'he_llo_wo_rld.mov');
  assert.strictEqual(sanitizeFileName('___'), 'file');
  assert.strictEqual(sanitizeFileName('no-ext-mov-file'), 'no-ext-mov-file');
});

test('uniqueFileName dedupes case-insensitively', () => {
  const used = new Set();
  assert.strictEqual(uniqueFileName('a.mov', used), 'a.mov');
  assert.strictEqual(uniqueFileName('a.mov', used), 'a_2.mov');
  assert.strictEqual(uniqueFileName('A.MOV', used), 'A_3.MOV');
});

test('formatBytes renders human sizes', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(1024), '1.00 KB');
  assert.strictEqual(formatBytes(10 * 1024 * 1024 * 1024), '10.00 GB');
  assert.strictEqual(formatBytes(-1), '?');
});

test('splitTelegramMessage splits long text on newlines', () => {
  const big = Array.from({ length: 100 }, (_, i) => `line-${i}`.padEnd(60, 'x')).join('\n');
  const chunks = splitTelegramMessage(big, 1000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000);
  }
});

test('isZipFile detects zip magic bytes', () => {
  const { dir, filePath } = tmpFile('fake.zip', Buffer.from('PK\x03\x04rest'));
  assert.strictEqual(isZipFile(filePath), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isZipFile rejects non-zip files', () => {
  const { dir, filePath } = tmpFile('fake.zip', Buffer.from('not a zip at all'));
  assert.strictEqual(isZipFile(filePath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isMovFile checks ftyp at offset 4', () => {
  const real = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypqt  ')]);
  const { dir: dir1, filePath: file1 } = tmpFile('real.mov', real);
  assert.strictEqual(isMovFile(file1), true);
  fs.rmSync(dir1, { recursive: true, force: true });

  const fake = Buffer.from('ftyp at wrong offset');
  const { dir: dir2, filePath: file2 } = tmpFile('fake.mov', fake);
  assert.strictEqual(isMovFile(file2), false);
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('throttle collapses rapid calls and flushes the last one', async () => {
  let count = 0;
  const fn = throttle(() => {
    count += 1;
  }, 50);
  fn();
  fn();
  fn();
  assert.strictEqual(count, 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(count, 2);
});

test('isVideoFile and guessVideoExtension detect common formats', () => {
  const mov = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypqt  '), Buffer.from('wide')]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]);
  const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI ')]);
  const mkv = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
  const junk = Buffer.from('random bytes that are not video');

  for (const buf of [mov, mp4, avi, mkv]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-test-'));
    const filePath = path.join(dir, 'sample');
    fs.writeFileSync(filePath, buf);
    assert.strictEqual(isVideoFile(filePath), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-test-'));
    const filePath = path.join(dir, 'sample');
    fs.writeFileSync(filePath, junk);
    assert.strictEqual(isVideoFile(filePath), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-test-'));
    const filePath = path.join(dir, 'sample');
    fs.writeFileSync(filePath, mp4);
    assert.strictEqual(guessVideoExtension(filePath), 'mp4');
    fs.writeFileSync(filePath, mov);
    assert.strictEqual(guessVideoExtension(filePath), 'mov');
    fs.writeFileSync(filePath, avi);
    assert.strictEqual(guessVideoExtension(filePath), 'avi');
    fs.writeFileSync(filePath, mkv);
    assert.strictEqual(guessVideoExtension(filePath), 'mkv');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimeForExtension maps known extensions', () => {
  assert.strictEqual(mimeForExtension('mov'), 'video/quicktime');
  assert.strictEqual(mimeForExtension('mp4'), 'video/mp4');
  assert.strictEqual(mimeForExtension('MKV'), 'video/x-matroska');
  assert.strictEqual(mimeForExtension('xyz'), 'application/octet-stream');
});
