require('dotenv').config();

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '..', '.env');

const required = {
  TELEGRAM_BOT_TOKEN: 'Telegram bot token from @BotFather',
  BUNNY_STREAM_LIBRARY_ID: 'Bunny Stream Video Library ID (number)',
  BUNNY_STREAM_API_KEY: 'Bunny Stream Library API key',
};

const missing = Object.keys(required).filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables:\n${missing
      .map((key) => `  - ${key} (${required[key]})`)
      .join('\n')}\nCopy .env.example to .env and fill in the values.`,
  );
}

if (!/^\d+$/.test(process.env.BUNNY_STREAM_LIBRARY_ID)) {
  throw new Error(
    'BUNNY_STREAM_LIBRARY_ID must be a number (find it in bunny.net -> Stream -> Library).',
  );
}

if (/^\d+:[A-Za-z0-9_-]{20,}$/.test(process.env.BUNNY_STREAM_API_KEY || '')) {
  throw new Error(
    'BUNNY_STREAM_API_KEY looks like a Telegram bot token. ' +
      'Use the Bunny Stream Library API key instead ' +
      '(bunny.net -> Stream -> Library -> API Keys).',
  );
}

const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramAllowedUsers: (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  bunnyStreamLibraryId: process.env.BUNNY_STREAM_LIBRARY_ID,
  bunnyStreamApiKey: process.env.BUNNY_STREAM_API_KEY,
  bunnyStreamCollectionId: process.env.BUNNY_STREAM_COLLECTION_ID || '',
  bunnyStreamPollIntervalMs: Number(process.env.BUNNY_STREAM_POLL_INTERVAL_MS || 10000),
  bunnyStreamPollTimeoutMs: Number(
    process.env.BUNNY_STREAM_POLL_TIMEOUT_MS || 3 * 60 * 60 * 1000,
  ),

  maxUploadRetries: Number(process.env.MAX_UPLOAD_RETRIES || 5),
  maxFileBytes: Number(process.env.MAX_FILE_SIZE_MB || 0) * 1024 * 1024,
  tusChunkSizeMb: Number(process.env.TUS_CHUNK_SIZE_MB || 8),

  allowedExtensions: (process.env.ALLOWED_EXTENSIONS || 'mov')
    .split(',')
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean),
};

/**
 * Changes the Bunny Stream collection ID at runtime AND persists it to
 * .env so it survives bot restarts. Empty string clears the collection.
 * Returns the new value.
 */
function setCollectionId(guid) {
  const value = String(guid || '').trim();

  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    // No .env file: nothing to persist.
  }

  const lines = content.split('\n');
  const idx = lines.findIndex((line) => line.startsWith('BUNNY_STREAM_COLLECTION_ID='));
  const newLine = `BUNNY_STREAM_COLLECTION_ID=${value}`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }
  fs.writeFileSync(ENV_PATH, `${lines.join('\n')}\n`);

  config.bunnyStreamCollectionId = value;
  return value;
}

config.setCollectionId = setCollectionId;

module.exports = config;
