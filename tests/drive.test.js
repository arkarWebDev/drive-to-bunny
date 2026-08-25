const { test } = require('node:test');
const assert = require('node:assert');
const { extractDriveId } = require('../src/drive');

test('extractDriveId parses folder share links', () => {
  const id = '1ppXrgCYAAiIMIbYNo5daO-K70jrH6KMH';
  assert.strictEqual(
    extractDriveId(`https://drive.google.com/drive/folders/${id}?usp=sharing`),
    id,
  );
  assert.strictEqual(extractDriveId(`https://drive.google.com/drive/u/1/folders/${id}`), id);
});

test('extractDriveId parses file links', () => {
  const id = '1AKrgq2xWR7XltKkwrxKe7uPYnmEODuK9';
  assert.strictEqual(extractDriveId(`https://drive.google.com/file/d/${id}/view?usp=sharing`), id);
  assert.strictEqual(extractDriveId(`https://drive.google.com/uc?id=${id}&export=download`), id);
});

test('extractDriveId accepts a raw ID', () => {
  const id = '1ppXrgCYAAiIMIbYNo5daO-K70jrH6KMH';
  assert.strictEqual(extractDriveId(id), id);
});

test('extractDriveId rejects invalid input', () => {
  assert.throws(() => extractDriveId('https://example.com/some-page'), /INVALID_LINK/);
  assert.throws(() => extractDriveId('https://docs.google.com/document/d/abc/edit'), /INVALID_LINK/);
  assert.throws(() => extractDriveId('hello world'), /INVALID_LINK/);
});
