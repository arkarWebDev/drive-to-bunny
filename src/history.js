const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'data', 'history.db');

let db = null;

function init(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      link TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      video_count INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      video_id TEXT NOT NULL,
      embed_url TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_chat ON runs(chat_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_run ON videos(run_id);
  `);
  return db;
}

/**
 * Persists one task run. videos: [{ name, videoId, embedUrl }].
 */
function recordRun({ chatId, link, status, videos = [], totalBytes = 0, error = '' }) {
  if (!db) init();
  const insertRun = db.prepare(
    'INSERT INTO runs (chat_id, link, status, video_count, total_bytes, error) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertVideo = db.prepare(
    'INSERT INTO videos (run_id, name, video_id, embed_url) VALUES (?, ?, ?, ?)',
  );
  const tx = db.transaction(() => {
    const info = insertRun.run(
      String(chatId),
      String(link),
      status,
      videos.length,
      totalBytes,
      error,
    );
    for (const video of videos) {
      insertVideo.run(info.lastInsertRowid, video.name, video.videoId, video.embedUrl);
    }
  });
  tx();
}

/**
 * Returns the most recent runs for a chat, newest first, each with
 * its uploaded videos.
 */
function getRecentRuns(chatId, limit = 10) {
  if (!db) init();
  const runs = db
    .prepare('SELECT * FROM runs WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
    .all(String(chatId), limit);
  const videoStmt = db.prepare(
    'SELECT name, video_id, embed_url FROM videos WHERE run_id = ? ORDER BY id',
  );
  return runs.map((run) => ({ ...run, videos: videoStmt.all(run.id) }));
}

module.exports = { init, recordRun, getRecentRuns };
