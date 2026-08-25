const crypto = require('crypto');
const fs = require('fs');

function sanitizeFileName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const ext = (name.match(/\.[^.]+$/) || [''])[0];
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return `${cleaned || 'file'}${ext.toLowerCase()}`;
}

function uniqueFileName(name, usedSet) {
  const lower = name.toLowerCase();
  if (!usedSet.has(lower)) {
    usedSet.add(lower);
    return name;
  }
  const base = name.replace(/\.[^.]+$/, '');
  const ext = (name.match(/\.[^.]+$/) || [''])[0];
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}${ext}`;
    if (!usedSet.has(candidate.toLowerCase())) {
      usedSet.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throttle(fn, intervalMs) {
  let lastRun = 0;
  let timer = null;
  let pendingArgs = null;
  return (...args) => {
    pendingArgs = args;
    const now = Date.now();
    const wait = intervalMs - (now - lastRun);
    if (wait <= 0) {
      lastRun = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        if (pendingArgs) fn(...pendingArgs);
      }, wait);
    }
  };
}

function uniqueRunId() {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function isZipFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    return (
      buf.equals(Buffer.from('PK\x03\x04')) || buf.equals(Buffer.from('PK\x05\x06'))
    );
  } finally {
    fs.closeSync(fd);
  }
}

function isMovFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    const read = fs.readSync(fd, buf, 0, 12, 0);
    if (read < 8) return false;
    return buf.subarray(4, 8).toString('ascii') === 'ftyp';
  } finally {
    fs.closeSync(fd);
  }
}

function isVideoFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    const read = fs.readSync(fd, buf, 0, 12, 0);
    if (read < 8) return false;
    if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return true; // mov/mp4/m4v/3gp
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF') return true; // avi
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return true; // EBML: mkv/webm
    }
    if (buf.subarray(0, 4).toString('ascii') === 'OggS') return true; // ogg/ogv
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function guessVideoExtension(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = buf.subarray(8, 12).toString('ascii');
      if (/^(isom|iso2|mp41|mp42|avc1|dash|M4V)$/i.test(brand)) {
        return brand === 'M4V' ? 'm4v' : 'mp4';
      }
      return 'mov';
    }
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF') return 'avi';
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return 'mkv';
    }
    if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
    return 'video';
  } finally {
    fs.closeSync(fd);
  }
}

function mimeForExtension(ext) {
  const map = {
    mov: 'video/quicktime',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    wmv: 'video/x-ms-wmv',
    ts: 'video/mp2t',
    '3gp': 'video/3gpp',
    ogg: 'video/ogg',
  };
  return map[String(ext).toLowerCase()] || 'application/octet-stream';
}

function splitTelegramMessage(text, limit = 4000) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit) {
      if (current) chunks.push(current);
      current = line.length > limit ? line.slice(0, limit) : line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  sanitizeFileName,
  uniqueFileName,
  formatBytes,
  sleep,
  throttle,
  uniqueRunId,
  isZipFile,
  isMovFile,
  isVideoFile,
  guessVideoExtension,
  mimeForExtension,
  splitTelegramMessage,
};
