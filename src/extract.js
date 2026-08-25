const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { pipeline } = require('stream/promises');
const { sanitizeFileName } = require('./utils');

/**
 * Streams a zip file from disk and extracts only the video files whose
 * extension is in `extensions` (lowercase, without dot; default ['mov'])
 * into destDir. Other entries are never written to disk, and macOS junk
 * (__MACOSX, ._* resource forks) is skipped.
 *
 * Returns { files: [{ localPath, name }], skippedCount }.
 */
async function extractMovFiles(zipPath, destDir, maxFileBytes = 0, extensions = ['mov']) {
  const allowedExts = new Set(
    extensions.map((ext) => String(ext).toLowerCase().replace(/^\./, '')),
  );
  await fs.promises.mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);

  const found = [];
  const usedNames = new Set();
  let skippedCount = 0;

  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;

    const parts = entry.path.split('/');
    if (parts.includes('__MACOSX')) continue;

    const basename = path.basename(entry.path);
    if (basename.startsWith('._') || basename === '.DS_Store') continue;

    const ext = path.extname(basename).toLowerCase().slice(1);
    if (!allowedExts.has(ext)) continue;

    if (maxFileBytes > 0 && entry.uncompressedSize > maxFileBytes) {
      skippedCount += 1;
      continue;
    }

    let name = sanitizeFileName(basename);
    const lower = name.toLowerCase();
    if (usedNames.has(lower)) {
      name = `dup_${Date.now()}_${name}`;
    }
    usedNames.add(name.toLowerCase());

    const outPath = path.join(destDir, name);
    await pipeline(entry.stream(), fs.createWriteStream(outPath));
    found.push({ localPath: outPath, name });
  }

  return { files: found, skippedCount };
}

module.exports = { extractMovFiles };
