const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../src/history');

test('history records and returns runs with videos', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-')), 'h.db');
  history.init(dbPath);

  history.recordRun({
    chatId: '111',
    link: 'https://drive.google.com/drive/folders/abc?usp=sharing',
    status: 'success',
    videos: [
      { name: 'a.mov', videoId: 'guid-1', embedUrl: 'https://iframe.mediadelivery.net/embed/1/guid-1' },
      { name: 'b.mov', videoId: 'guid-2', embedUrl: 'https://iframe.mediadelivery.net/embed/1/guid-2' },
    ],
    totalBytes: 1000,
  });

  history.recordRun({
    chatId: '111',
    link: 'https://drive.google.com/drive/folders/xyz?usp=sharing',
    status: 'failed',
    totalBytes: 0,
    error: 'No video files were found',
  });

  history.recordRun({
    chatId: '222',
    link: 'https://drive.google.com/drive/folders/other?usp=sharing',
    status: 'success',
    videos: [{ name: 'c.mov', videoId: 'guid-3', embedUrl: 'https://iframe.mediadelivery.net/embed/1/guid-3' }],
    totalBytes: 500,
  });

  const runs = history.getRecentRuns('111', 10);
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(runs[0].status, 'failed');
  assert.strictEqual(runs[0].error, 'No video files were found');
  assert.strictEqual(runs[1].status, 'success');
  assert.strictEqual(runs[1].video_count, 2);
  assert.strictEqual(runs[1].videos.length, 2);
  assert.strictEqual(runs[1].videos[0].name, 'a.mov');
  assert.strictEqual(runs[1].videos[1].embed_url, 'https://iframe.mediadelivery.net/embed/1/guid-2');

  // Other chats are isolated.
  const other = history.getRecentRuns('222', 10);
  assert.strictEqual(other.length, 1);
  assert.strictEqual(other[0].videos[0].video_id, 'guid-3');
});
