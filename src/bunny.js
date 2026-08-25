const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { sleep } = require('./utils');

const API_BASE = 'https://video.bunnycdn.com';
const TUS_ENDPOINT = `${API_BASE}/tusupload`;
const TUS_EXPIRE_SECONDS = 24 * 60 * 60;

// Bunny Stream video status codes (VideoModelStatus)
const STATUS = {
  CREATED: 0,
  UPLOADED: 1,
  PROCESSING: 2,
  TRANSCODING: 3,
  FINISHED: 4,
  ERROR: 5,
  UPLOAD_FAILED: 6,
  JIT_SEGMENTING: 7,
  JIT_PLAYLISTS_CREATED: 8,
};
// Statuses that mean the video is watchable (includes JIT-encoded libraries)
const READY_STATUSES = new Set([
  STATUS.FINISHED,
  STATUS.JIT_SEGMENTING,
  STATUS.JIT_PLAYLISTS_CREATED,
]);

function authHeaders(apiKey, extra = {}) {
  return { AccessKey: apiKey, ...extra };
}

/**
 * Creates a video entry in the Bunny Stream library. Returns the video GUID.
 */
async function createVideo({ apiKey, libraryId, title, collectionId }) {
  const body = { title };
  if (collectionId) body.collectionId = collectionId;
  let data;
  try {
    ({ data } = await axios.post(
      `${API_BASE}/library/${libraryId}/videos`,
      body,
      {
        headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }),
        timeout: 30000,
      },
    ));
  } catch (err) {
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      throw new Error('BUNNY_AUTH_FAILED');
    }
    throw err;
  }
  return data.guid;
}

// ---------------------------------------------------------------------------
// TUS resumable upload (https://video.bunnycdn.com/tusupload)
// Resumable + per-chunk retries: safe for 10 GB files on flaky networks.
// ---------------------------------------------------------------------------

function tusSignature({ libraryId, apiKey, expirationTime, videoId }) {
  return crypto
    .createHash('sha256')
    .update(`${libraryId}${apiKey}${expirationTime}${videoId}`)
    .digest('hex');
}

function tusHeaders({ libraryId, apiKey, expirationTime, videoId }) {
  return {
    AuthorizationSignature: tusSignature({ libraryId, apiKey, expirationTime, videoId }),
    AuthorizationExpire: String(expirationTime),
    LibraryId: String(libraryId),
    VideoId: videoId,
    'Tus-Resumable': '1.0.0',
  };
}

function encodeMetadata(entries) {
  return Object.entries(entries)
    .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
    .join(',');
}

async function createTusUpload({ headers, size, title, filetype }) {
  const response = await axios.post(
    TUS_ENDPOINT,
    null,
    {
      headers: {
        ...headers,
        'Upload-Length': String(size),
        'Upload-Metadata': encodeMetadata({ filetype, title }),
      },
      timeout: 30000,
      validateStatus: (status) => status >= 200 && status < 400,
    },
  );
  const location = response.headers.location;
  if (!location) {
    throw new Error('BUNNY_UPLOAD_FAILED: no upload location returned by TUS endpoint');
  }
  // The endpoint may return a relative path (e.g. /tusupload/<id>).
  return new URL(location, API_BASE).toString();
}

async function getUploadOffset(location, headers) {
  const response = await axios.head(location, {
    headers,
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status < 500,
  });
  const offset = Number(response.headers['upload-offset']);
  if (!Number.isFinite(offset)) {
    throw new Error('BUNNY_UPLOAD_FAILED: no upload-offset returned');
  }
  return offset;
}

/**
 * Uploads a local file with the TUS protocol. Streams the file in chunks
 * (constant memory usage), reports progress via onProgress(offset, size)
 * and resumes after network failures.
 */
async function uploadVideoFile({
  apiKey,
  libraryId,
  videoId,
  localPath,
  title,
  filetype = 'video/quicktime',
  retries,
  chunkSizeMb = 8,
  onProgress = () => {},
}) {
  const size = (await fs.promises.stat(localPath)).size;
  const chunkSize = chunkSizeMb * 1024 * 1024;

  const expirationTime = Math.floor(Date.now() / 1000) + TUS_EXPIRE_SECONDS;
  const headers = tusHeaders({ libraryId, apiKey, expirationTime, videoId });

  let location;
  try {
    location = await createTusUpload({ headers, size, title, filetype });
  } catch (err) {
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      throw new Error('BUNNY_AUTH_FAILED');
    }
    const detail = err.response ? `HTTP ${err.response.status}` : err.message;
    throw new Error(`BUNNY_UPLOAD_FAILED: ${detail}`);
  }

  let offset = 0;
  try {
    const serverOffset = await getUploadOffset(location, headers);
    if (serverOffset > 0) offset = serverOffset;
  } catch {
    // Fresh upload, start from 0.
  }
  onProgress(offset, size);

  let consecutiveFailures = 0;
  while (offset < size) {
    const end = Math.min(offset + chunkSize, size);
    const chunk = fs.createReadStream(localPath, { start: offset, end: end - 1 });

    try {
      await axios.patch(location, chunk, {
        headers: {
          ...headers,
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': String(offset),
          'Content-Length': end - offset,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 0,
        validateStatus: (status) => status >= 200 && status < 300,
      });
      offset = end;
      consecutiveFailures = 0;
      onProgress(offset, size);
    } catch (err) {
      consecutiveFailures += 1;

      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        throw new Error('BUNNY_AUTH_FAILED');
      }

      // Re-sync with the server: a chunk may have partially landed.
      try {
        const serverOffset = await getUploadOffset(location, headers);
        if (serverOffset > offset) offset = serverOffset;
      } catch {
        // Server unreachable; keep the current offset and retry.
      }

      if (consecutiveFailures > retries) {
        const detail = err.response ? `HTTP ${err.response.status}` : err.message;
        const error = new Error(`BUNNY_UPLOAD_FAILED: ${detail}`);
        error.cause = err;
        throw error;
      }

      await sleep(Math.min(1000 * 2 ** consecutiveFailures, 30000));
    }
  }
}

/**
 * Polls the video until Bunny finishes processing it.
 * Calls onProgress(videoModel) with the live video data (encodeProgress).
 * Throws on encode failure, upload failure or timeout.
 */
async function waitForVideoReady({
  apiKey,
  libraryId,
  videoId,
  pollIntervalMs,
  timeoutMs,
  onProgress = () => {},
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data } = await axios.get(
      `${API_BASE}/library/${libraryId}/videos/${videoId}`,
      { headers: authHeaders(apiKey), timeout: 30000 },
    );

    onProgress(data);

    if (READY_STATUSES.has(data.status)) return data;
    if (data.status === STATUS.ERROR) throw new Error('BUNNY_ENCODE_FAILED');
    if (data.status === STATUS.UPLOAD_FAILED) {
      throw new Error('BUNNY_UPLOAD_FAILED');
    }

    await sleep(pollIntervalMs);
  }

  throw new Error('BUNNY_PROCESSING_TIMEOUT');
}

/**
 * Fetches playback data (HLS playlist URL etc.) for a finished video.
 * Never throws - falls back to the embed URL only.
 */
async function getVideoPlayData({ apiKey, libraryId, videoId }) {
  try {
    const { data } = await axios.get(
      `${API_BASE}/library/${libraryId}/videos/${videoId}/play`,
      { headers: authHeaders(apiKey), timeout: 30000 },
    );
    return {
      playlistUrl: data.videoPlaylistUrl || null,
      thumbnailUrl: data.thumbnailUrl || null,
    };
  } catch {
    return { playlistUrl: null, thumbnailUrl: null };
  }
}

function embedUrl(libraryId, videoId) {
  return `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`;
}

/**
 * Lists the collections of the library. Returns [{ guid, name }].
 */
async function listCollections({ apiKey, libraryId }) {
  const { data } = await axios.get(
    `${API_BASE}/library/${libraryId}/collections`,
    { headers: authHeaders(apiKey), timeout: 30000 },
  );
  return (data.items || []).map((item) => ({ guid: item.guid, name: item.name }));
}

/**
 * Startup sanity check: verifies the API key can read the library.
 * Returns { ok, status, message } and never throws.
 */
async function validateCredentials({ apiKey, libraryId }) {
  try {
    await axios.get(`${API_BASE}/library/${libraryId}`, {
      headers: authHeaders(apiKey),
      timeout: 30000,
    });
    return { ok: true };
  } catch (err) {
    const status = err.response && err.response.status;
    const message =
      (err.response && err.response.data && err.response.data.Message) || err.message;
    return { ok: false, status, message };
  }
}

module.exports = {
  createVideo,
  uploadVideoFile,
  waitForVideoReady,
  getVideoPlayData,
  embedUrl,
  listCollections,
  validateCredentials,
};
