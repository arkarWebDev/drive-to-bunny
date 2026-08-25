require('dotenv').config();

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

module.exports = config;
