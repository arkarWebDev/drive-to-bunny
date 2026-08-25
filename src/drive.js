const axios = require('axios');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const UC_BASE = 'https://drive.google.com/uc';
const FOLDER_VIEW_BASE = 'https://drive.google.com/embeddedfolderview';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_CONFIRM_ATTEMPTS = 3;

/**
 * Extracts the Google Drive file/folder ID from a user-provided link
 * or a raw ID. Throws Error('INVALID_LINK') when nothing matches.
 */
function extractDriveId(input) {
  const text = String(input || '').trim();
  const patterns = [
    /drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?id=)([A-Za-z0-9_-]{15,})(?![A-Za-z0-9_-])/i,
    /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{15,})(?![A-Za-z0-9_-])/i,
    /drive\.google\.com\/(?:uc|file\/u\/\d+\/d)\?[^"' ]*id=([A-Za-z0-9_-]{15,})(?![A-Za-z0-9_-])/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  if (/^[A-Za-z0-9_-]{25,}$/.test(text)) return text;
  throw new Error('INVALID_LINK');
}

function streamToText(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Builds the "download anyway" URL from Google's interstitial page.
 * Handles both the modern form style
 * (action="https://drive.usercontent.google.com/download" + hidden
 * id/confirm/uuid inputs) and the legacy URL-param style
 * (uc?export=download&confirm=...&uuid=...).
 * Returns null when no confirm token can be extracted.
 */
function buildConfirmUrl(html, driveId) {
  const formAction = (
    html.match(/action="(https?:\/\/[^"]+)"[^>]*method="get"/i) || []
  )[1];

  if (formAction) {
    const inputValue = (name) =>
      (html.match(new RegExp(`name="${name}"\\s+value="([^"]*)"`)) || [])[1];
    const id = inputValue('id') || driveId;
    const confirm = inputValue('confirm');
    const uuid = inputValue('uuid');
    const exportValue = inputValue('export') || 'download';

    if (confirm) {
      const params = new URLSearchParams({ id, export: exportValue, confirm });
      if (uuid) params.set('uuid', uuid);
      return `${formAction}?${params.toString()}`;
    }
  }

  const confirm = (html.match(/[?&]confirm=([A-Za-z0-9_-]+)/) || [])[1];
  if (confirm) {
    const uuid = (html.match(/[?&]uuid=([A-Za-z0-9_-]+)/) || [])[1];
    let url = `${UC_BASE}?export=download&id=${driveId}&confirm=${confirm}`;
    if (uuid) url += `&uuid=${uuid}`;
    return url;
  }

  return null;
}

function detectDriveError(html) {
  if (/quotaExceeded|too many users|exceeded the (?:quota|download)|Rate limit/i.test(html)) {
    return new Error('DRIVE_QUOTA');
  }
  // Only match the actual "infected file" refusal. Google's benign
  // "too large to scan for viruses" interstitial contains the word
  // "virus" too and must be allowed through to the confirm-token flow.
  if (/infected with a virus|only the owner is allowed to download/i.test(html)) {
    return new Error('DRIVE_VIRUS');
  }
  if (
    /couldn'?t find|not found|no longer available|does not exist|Sorry, the file you have requested/i.test(
      html,
    )
  ) {
    return new Error('DRIVE_NOT_FOUND');
  }
  return null;
}

/**
 * Lists one folder level via the embedded folder view (no API key needed).
 * Returns null when the ID is not a public folder, [] for an empty folder,
 * or [{ id, name, isFolder }].
 */
async function listFolderEntries(folderId) {
  const response = await axios.get(`${FOLDER_VIEW_BASE}?id=${folderId}`, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 60000,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const html =
    typeof response.data === 'string'
      ? response.data
      : await streamToText(response.data);

  if (!html.includes('flip-entries')) return null;

  const ids = [...html.matchAll(/id="entry-([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const hrefs = [
    ...html.matchAll(/<a href="(https:\/\/drive\.google\.com\/(?:file\/d\/|drive\/folders\/)[^"]+)"/g),
  ].map((m) => m[1]);
  const titles = [
    ...html.matchAll(/class="flip-entry-title">([\s\S]*?)<\/div>/g),
  ].map((m) => decodeEntities(m[1].trim()));

  return ids.map((id, i) => ({
    id,
    name: titles[i] || '',
    isFolder: /\/drive\/folders\//.test(hrefs[i] || ''),
  }));
}

/**
 * Recursively walks a public folder and returns every file entry as
 * { id, name }. onFound(total) is called as files are discovered.
 */
async function walkFolder(folderId, onFound = () => {}) {
  const files = [];
  const stack = [folderId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    const entries = await listFolderEntries(currentId);
    if (entries === null) continue;

    for (const entry of entries) {
      if (entry.isFolder) {
        stack.push(entry.id);
      } else {
        files.push({ id: entry.id, name: entry.name });
        onFound(files.length);
      }
    }
  }

  return files;
}

async function requestAsStream(url) {
  return axios.get(url, {
    responseType: 'stream',
    maxRedirects: 5,
    timeout: 0,
    validateStatus: (status) => status >= 200 && status < 400,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    },
  });
}

/**
 * Downloads a single public Drive file into destPath, following Google's
 * "confirm download" HTML interstitial when present.
 * maxFileBytes > 0 skips the download when the declared content-length
 * exceeds it. onProgress(received, total) is called as bytes arrive.
 * Returns { skipped }.
 */
async function downloadFromDrive(
  driveId,
  destPath,
  { maxFileBytes = 0, onProgress = () => {} } = {},
) {
  let url = `${UC_BASE}?export=download&id=${driveId}`;

  for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await requestAsStream(url);
    } catch (err) {
      if (err.response && err.response.status === 404) {
        throw new Error('DRIVE_NOT_FOUND');
      }
      throw err;
    }

    const contentType = String(response.headers['content-type'] || '');

    if (contentType.includes('text/html')) {
      const html = await streamToText(response.data);
      const driveError = detectDriveError(html);
      if (driveError) throw driveError;

      const confirmUrl = buildConfirmUrl(html, driveId);
      if (!confirmUrl) {
        throw new Error('DRIVE_UNEXPECTED_PAGE');
      }
      url = confirmUrl;
      continue;
    }

    const declaredSize = Number(response.headers['content-length'] || 0);
    if (maxFileBytes > 0 && declaredSize > maxFileBytes) {
      response.data.destroy();
      return { skipped: true };
    }

    let received = 0;
    response.data.on('data', (chunk) => {
      received += chunk.length;
      onProgress(received, declaredSize);
    });

    await pipeline(response.data, fs.createWriteStream(destPath));
    return { skipped: false };
  }

  throw new Error('DRIVE_TOO_MANY_REDIRECTS');
}

module.exports = { extractDriveId, listFolderEntries, walkFolder, downloadFromDrive };
