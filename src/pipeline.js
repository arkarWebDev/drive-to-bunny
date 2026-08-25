const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const { extractDriveId, walkFolder, downloadFromDrive } = require('./drive');
const { extractMovFiles } = require('./extract');
const {
  createVideo,
  uploadVideoFile,
  embedUrl,
} = require('./bunny');
const {
  isZipFile,
  isVideoFile,
  guessVideoExtension,
  mimeForExtension,
  sanitizeFileName,
  uniqueFileName,
  formatBytes,
  throttle,
} = require('./utils');

// Every active temp dir is tracked so it can be force-cleaned on
// shutdown / crash, even if the per-run `finally` never executes.
const activeWorkDirs = new Set();

async function cleanupWorkDir(workDir) {
  try {
    // Node's rm retries internally on EBUSY/EMFILE/ENOTEMPTY.
    await fs.promises.rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 2000,
    });
    return { ok: true, message: '' };
  } catch (err) {
    console.error(`[cleanup] failed to remove ${workDir}: ${err.code || ''} ${err.message}`);
    try {
      const remaining = await fs.promises.readdir(workDir);
      console.error(`[cleanup] remaining entries: ${remaining.join(', ') || '(none)'}`);
    } catch {
      // Directory already gone or unreadable.
    }
    return { ok: false, message: `${err.code || 'ERROR'} ${err.message}` };
  }
}

// Background retry schedule for stubborn temp dirs (self-healing even if
// the immediate attempt fails).
function scheduleDeferredCleanup(workDir) {
  for (const delayMs of [30000, 120000, 600000]) {
    setTimeout(() => {
      cleanupWorkDir(workDir)
        .then((result) => {
          if (result.ok) console.log(`[cleanup] deferred removal succeeded: ${workDir}`);
        })
        .catch(() => {});
    }, delayMs);
  }
}

async function cleanupAllWorkDirs() {
  const dirs = [...activeWorkDirs];
  activeWorkDirs.clear();
  const results = await Promise.allSettled(dirs.map((dir) => cleanupWorkDir(dir)));
  return results;
}

/**
 * Full workflow:
 *   link -> list folder -> download .MOV files -> Bunny Stream -> URLs
 * Falls back to single-file / ZIP handling when the link is not a folder.
 * The temp working directory is always removed - on success AND on any
 * error inside the flow.
 *
 * onStatus(message) is called for progress updates.
 * Returns { driveId, videos, skippedCount, ignoredCount, totalBytes } where
 * videos is [{ name, videoId, embedUrl }].
 */
async function processDriveLink(link, onStatus = () => {}) {
  const driveId = extractDriveId(link);
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `gdrive-mov-${driveId.slice(0, 12)}-`),
  );
  activeWorkDirs.add(workDir);
  // Owner marker so other processes' startup sweeps never delete this dir.
  await fs.promises
    .writeFile(path.join(workDir, 'owner.pid'), String(process.pid))
    .catch(() => {});
  const downloadDir = path.join(workDir, 'downloaded');

  let cleanedUp = false;
  let cleanupError = '';
  let result = null;

  try {
    onStatus('[1/3] Listing Google Drive folder contents...');
    const folderFiles = await walkFolder(driveId, (count) => {
      onStatus(`[1/3] Listing folder... ${count} file(s) found so far`);
    });

    let localFiles = [];
    let skippedCount = 0;
    let ignoredCount = 0;
    let totalBytes = 0;

    if (folderFiles !== null) {
      if (folderFiles.length === 0) throw new Error('FOLDER_EMPTY');

      const allowedExts = new Set(config.allowedExtensions);
      const videoFiles = folderFiles.filter((f) =>
        allowedExts.has(path.extname(f.name).toLowerCase().slice(1)),
      );
      ignoredCount = folderFiles.length - videoFiles.length;
      if (videoFiles.length === 0) throw new Error('NO_VIDEO_FILES');

      await fs.promises.mkdir(downloadDir, { recursive: true });
      const usedNames = new Set();

      for (let i = 0; i < videoFiles.length; i += 1) {
        const file = videoFiles[i];
        const progress = `${i + 1}/${videoFiles.length}`;
        const reportDownload = throttle((received, total) => {
          const pct = total > 0 ? ` - ${Math.round((received / total) * 100)}%` : '';
          onStatus(
            `[2/3] Downloading ${progress}: ${file.name} (${formatBytes(received)}${total > 0 ? ` / ${formatBytes(total)}` : ''}${pct})`,
          );
        }, 3000);
        const name = uniqueFileName(sanitizeFileName(file.name), usedNames);
        const destPath = path.join(downloadDir, name);
        const result = await downloadFromDrive(file.id, destPath, {
          maxFileBytes: config.maxFileBytes,
          onProgress: reportDownload,
        });
        if (result.skipped) {
          skippedCount += 1;
          await fs.promises.rm(destPath, { force: true }).catch(() => {});
          continue;
        }
        totalBytes += (await fs.promises.stat(destPath)).size;
        localFiles.push({ localPath: destPath, name });
      }
    } else {
      // Not a public folder: try a single file (or a shared ZIP).
      onStatus('[2/3] Downloading file...');
      const payloadPath = path.join(workDir, 'payload.bin');
      const result = await downloadFromDrive(driveId, payloadPath, {
        maxFileBytes: config.maxFileBytes,
      });
      if (result.skipped) throw new Error('FILE_TOO_LARGE');

      await fs.promises.mkdir(downloadDir, { recursive: true });
      if (isZipFile(payloadPath)) {
        onStatus('[2/3] Extracting ZIP and filtering video files...');
        const extracted = await extractMovFiles(
          payloadPath,
          downloadDir,
          config.maxFileBytes,
          config.allowedExtensions,
        );
        localFiles = extracted.files;
        skippedCount = extracted.skippedCount;
      } else if (isVideoFile(payloadPath)) {
        const ext = guessVideoExtension(payloadPath);
        const name = `single_video.${ext}`;
        const newPath = path.join(downloadDir, name);
        await fs.promises.rename(payloadPath, newPath);
        localFiles = [{ localPath: newPath, name }];
      } else {
        throw new Error('NO_VIDEO_FILES');
      }
      for (const f of localFiles) {
        totalBytes += (await fs.promises.stat(f.localPath)).size;
      }
    }

    if (localFiles.length === 0) throw new Error('NO_VIDEO_FILES');

    const videos = [];
    for (let i = 0; i < localFiles.length; i += 1) {
      const file = localFiles[i];
      const progress = `${i + 1}/${localFiles.length}`;

      onStatus(`[3/3] Creating Bunny Stream video ${progress}: ${file.name}`);
      const videoId = await createVideo({
        apiKey: config.bunnyStreamApiKey,
        libraryId: config.bunnyStreamLibraryId,
        title: file.name,
        collectionId: config.bunnyStreamCollectionId || undefined,
      });

      const reportUpload = throttle((offset, total) => {
        const pct = total > 0 ? Math.round((offset / total) * 100) : 0;
        onStatus(
          `[3/3] Uploading ${progress}: ${file.name} (${pct}% - ${formatBytes(offset)} / ${formatBytes(total)})`,
        );
      }, 3000);
      await uploadVideoFile({
        apiKey: config.bunnyStreamApiKey,
        libraryId: config.bunnyStreamLibraryId,
        videoId,
        localPath: file.localPath,
        title: file.name,
        filetype: mimeForExtension(path.extname(file.name).slice(1)),
        retries: config.maxUploadRetries,
        chunkSizeMb: config.tusChunkSizeMb,
        onProgress: reportUpload,
      });

      videos.push({
        name: file.name,
        videoId,
        embedUrl: embedUrl(config.bunnyStreamLibraryId, videoId),
      });
    }

    result = {
      driveId,
      videos,
      skippedCount,
      ignoredCount,
      totalBytes,
      workDir,
    };
    return result;
  } finally {
    onStatus('Cleaning up temporary files...');
    const cleanupResult = await cleanupWorkDir(workDir);
    cleanedUp = cleanupResult.ok;
    cleanupError = cleanupResult.message;
    if (!cleanedUp) {
      scheduleDeferredCleanup(workDir);
    }
    activeWorkDirs.delete(workDir);
    if (result) {
      result.cleanedUp = cleanedUp;
      result.cleanupError = cleanupError;
    }
  }
}

module.exports = { processDriveLink, cleanupAllWorkDirs };
