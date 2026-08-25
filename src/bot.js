const fs = require('fs');
const os = require('os');
const path = require('path');
const { Telegraf } = require('telegraf');
const config = require('./config');
const { processDriveLink, cleanupAllWorkDirs } = require('./pipeline');
const { validateCredentials, listCollections } = require('./bunny');
const { splitTelegramMessage, formatBytes } = require('./utils');

// handlerTimeout: Infinity disables Telegraf's 90s default so long-running
// downloads/uploads/encoding waits are never killed mid-task.
const bot = new Telegraf(config.telegramBotToken, { handlerTimeout: Infinity });
const processingChats = new Set();

const DRIVE_LINK_PATTERN = /drive\.google\.com|^[A-Za-z0-9_-]{25,}$/;

const EXT_LABEL = config.allowedExtensions.map((ext) => `.${ext.toUpperCase()}`).join('/');

const USAGE = [
  'Welcome. Send me a public Google Drive folder link (set to "Anyone with the link") and I will:',
  '',
  '1. List the folder contents (including subfolders)',
  `2. Download only the ${EXT_LABEL} video files`,
  '3. Upload them to Bunny Stream',
  '4. Send you the Bunny embed URLs',
  '',
  'Example link:',
  'https://drive.google.com/drive/folders/1AbCdEf...?usp=sharing',
  '',
  'All downloaded files are deleted automatically afterwards.',
  '',
  'Commands:',
  '/start - show this message',
  '/id - show your Telegram user ID',
  '/collection - show the current Bunny collection',
  '/setcollection <guid> - change the Bunny collection (owner only)',
].join('\n');

function logUser(ctx, event = 'message') {
  const from = ctx.from || {};
  const chat = ctx.chat || {};
  console.log(
    `[${event}] user_id=${from.id} username=${from.username || '-'} ` +
      `name="${from.first_name || ''} ${from.last_name || ''}".trim() ` +
      `chat_id=${chat.id} chat_type=${chat.type || '-'} text="${(ctx.message && ctx.message.text) || ''}"`,
  );
}

function friendlyError(err) {
  const message = String(err && err.message ? err.message : err);
  if (message.includes('INVALID_LINK')) {
    return 'That does not look like a valid Google Drive link.';
  }
  if (message.includes('DRIVE_NOT_FOUND')) {
    return 'Google Drive says the file/folder does not exist or is not public. Make sure sharing is set to "Anyone with the link".';
  }
  if (message.includes('DRIVE_QUOTA')) {
    return 'Google Drive blocked the download (quota exceeded / too many downloads). Try again later.';
  }
  if (message.includes('DRIVE_VIRUS')) {
    return 'Google Drive refuses to download this item because it is flagged as infected.';
  }
  if (message.includes('DRIVE_UNEXPECTED_PAGE') || message.includes('DRIVE_TOO_MANY_REDIRECTS')) {
    return 'Google Drive returned an unexpected page. The folder may be too large, empty, or protected.';
  }
  if (message.includes('FOLDER_EMPTY')) {
    return 'The folder is empty.';
  }
  if (message.includes('FILE_TOO_LARGE')) {
    return 'The file exceeds the configured size limit.';
  }
  if (message.includes('NO_VIDEO_FILES') || message.includes('NO_MOV_FILES')) {
    return `No ${EXT_LABEL} video files were found in the downloaded folder.`;
  }
  if (message.includes('BUNNY_AUTH_FAILED')) {
    return 'Bunny Stream rejected the API key (401). Make sure BUNNY_STREAM_API_KEY is the Stream Library API key, not the Telegram bot token.';
  }
  if (message.includes('BUNNY_UPLOAD_FAILED')) {
    return 'Uploading to Bunny Stream failed. Check your Library ID and API key.';
  }
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|Network Error|getaddrinfo/i.test(message)) {
    return 'Network error while contacting the server. Please try again.';
  }
  const httpMatch = message.match(/status code (\d{3})/);
  if (httpMatch) {
    return `The server responded with an error (HTTP ${httpMatch[1]}). Please try again later.`;
  }
  return `Unexpected error: ${message}`;
}

function isAllowed(ctx) {
  if (config.telegramAllowedUsers.length === 0) return true;
  return config.telegramAllowedUsers.includes(String(ctx.from && ctx.from.id));
}

// Global gate: blocks every update (commands included) from unauthorized
// users when TELEGRAM_ALLOWED_USER_IDS is set.
bot.use((ctx, next) => {
  if (isAllowed(ctx)) return next();
  logUser(ctx, 'blocked');
  return ctx.reply('You are not authorized to use this bot.').catch(() => {});
});

bot.start((ctx) => {
  logUser(ctx, 'start');
  const userId = ctx.from && ctx.from.id;
  const welcome = `Your Telegram user ID is: ${userId}\n\n${USAGE}`;
  return ctx.reply(welcome);
});

bot.help((ctx) => {
  logUser(ctx, 'help');
  return ctx.reply(USAGE);
});

bot.command('id', (ctx) => {
  logUser(ctx, 'id');
  const userId = ctx.from && ctx.from.id;
  return ctx.reply(`Your Telegram user ID is: ${userId}`);
});

function htmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

bot.command('collection', async (ctx) => {
  logUser(ctx, 'collection');
  const current = config.bunnyStreamCollectionId || '(none)';
  let extra = '';
  try {
    const collections = await listCollections({
      apiKey: config.bunnyStreamApiKey,
      libraryId: config.bunnyStreamLibraryId,
    });
    if (collections.length === 0) {
      extra = '\n\nYour library has no collections.';
    } else {
      extra =
        '\n\nCollections in your library:\n' +
        collections.map((c) => `- ${htmlEscape(c.name)}: <code>${htmlEscape(c.guid)}</code>`).join('\n');
    }
  } catch {
    extra = '\n\n(could not fetch collection list)';
  }
  return ctx.reply(`Current collection: <b>${htmlEscape(current)}</b>${extra}`, {
    parse_mode: 'HTML',
  });
});

bot.command('setcollection', async (ctx) => {
  logUser(ctx, 'setcollection');
  if (config.telegramAllowedUsers.length === 0) {
    return ctx.reply(
      'This command is disabled while TELEGRAM_ALLOWED_USER_IDS is empty. ' +
        'Add your user ID to .env to enable it.',
    );
  }

  const arg = ((ctx.message.text || '').split(/\s+/)[1] || '').trim();
  if (!arg) {
    return ctx.reply('Usage: /setcollection <collection-guid>\n/setcollection none - clear the collection');
  }

  let value = arg;
  if (arg.toLowerCase() === 'none') {
    value = '';
  } else {
    try {
      const collections = await listCollections({
        apiKey: config.bunnyStreamApiKey,
        libraryId: config.bunnyStreamLibraryId,
      });
      const found = collections.some((c) => c.guid === value);
      if (!found) {
        return ctx.reply(
          `Collection <code>${htmlEscape(value)}</code> was not found in your library. ` +
            'Use /collection to list valid GUIDs.',
          { parse_mode: 'HTML' },
        );
      }
    } catch (err) {
      console.error('[setcollection] validation failed:', err.message);
      return ctx.reply('Could not validate the collection against Bunny Stream. Nothing changed.');
    }
  }

  config.setCollectionId(value);
  return ctx.reply(
    value
      ? `Collection set to <code>${htmlEscape(value)}</code> and saved to .env. New uploads will use it.`
      : 'Collection cleared and saved to .env. New uploads will use no collection.',
    { parse_mode: 'HTML' },
  );
});

// Non-text updates: point the user back to link messages.
bot.on(
  ['photo', 'document', 'audio', 'video', 'voice', 'sticker', 'contact', 'location'],
  (ctx) => {
    if (ctx.chat.type === 'private') {
      return ctx.reply('I only accept Google Drive folder links as text messages.').catch(() => {});
    }
    return undefined;
  },
);

bot.on('text', async (ctx) => {
  logUser(ctx, 'text');

  const text = ctx.message.text.trim();

  const linkMatches = text.match(/https?:\/\/[^\s]+/gi) || [];
  if (linkMatches.length > 1) {
    return ctx.reply('Please send one link at a time.');
  }

  if (!DRIVE_LINK_PATTERN.test(text)) {
    const isPrivate = ctx.chat.type === 'private';
    const looksLikeLinkAttempt =
      /https?:\/\/|drive\.|google\.|dropbox|mega\.|^[A-Za-z0-9_-]{25,}$/i.test(text);
    if (isPrivate || looksLikeLinkAttempt) {
      return ctx.reply(
        'That is not a valid Google Drive link.\n\n' +
          'Send a public folder link, e.g.:\n' +
          'https://drive.google.com/drive/folders/1AbCdEf...?usp=sharing',
      );
    }
    return;
  }

  const chatId = ctx.chat.id;
  if (processingChats.has(chatId)) {
    return ctx.reply('A previous task is still running for this chat. Please wait.');
  }
  processingChats.add(chatId);

  const statusMessage = await ctx.reply('Starting task...');
  const setStatus = async (statusText) => {
    try {
      await ctx.telegram.editMessageText(
        chatId,
        statusMessage.message_id,
        undefined,
        statusText,
      );
    } catch {
      // Editing can fail if the message was deleted; ignore and continue.
    }
  };

  try {
    const { videos, skippedCount, ignoredCount, totalBytes, workDir, cleanedUp, cleanupError } =
      await processDriveLink(text, setStatus);

    const lines = [
      `<b>Upload complete</b> - ${videos.length} video${videos.length === 1 ? '' : 's'}`,
      `Total size: ${formatBytes(totalBytes)}`,
      '',
    ];
    videos.forEach((video, i) => {
      lines.push(`${i + 1}. <b>${video.name}</b>`);
      lines.push(`<code>${video.embedUrl}</code>`);
      lines.push('');
    });
    const notes = [];
    if (ignoredCount > 0) notes.push(`${ignoredCount} non-${EXT_LABEL} ignored`);
    if (skippedCount > 0) notes.push(`${skippedCount} skipped (size limit)`);
    if (notes.length > 0) lines.push(`<i>${notes.join(' | ')}</i>`);
    lines.push('<i>Videos encode automatically in the background.</i>');
    lines.push('');
    if (cleanedUp) {
      lines.push(`<i>Temp files cleaned up: <code>${workDir}</code></i>`);
    } else {
      lines.push(
        `<i>Warning: could not fully remove temp dir (<code>${cleanupError}</code>). ` +
          'Automatic retries are scheduled.</i>',
      );
    }

    for (const chunk of splitTelegramMessage(lines.join('\n'))) {
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('[pipeline error]', err);
    await ctx.reply(`Failed: ${friendlyError(err)}`);
  } finally {
    processingChats.delete(chatId);
  }
});

bot.catch((err, ctx) => {
  console.error('[bot error]', err);
  ctx.reply(`Failed: ${friendlyError(err)}`).catch(() => {});
});

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Prevents two bot instances polling the same token (which also caused
// one instance's startup sweep to delete the other's in-progress files).
function acquireInstanceLock() {
  const crypto = require('crypto');
  const hash = crypto
    .createHash('sha1')
    .update(config.telegramBotToken)
    .digest('hex')
    .slice(0, 12);
  const lockPath = path.join(os.tmpdir(), `tele-upload-bnb-${hash}.lock`);
  try {
    const existing = Number(fs.readFileSync(lockPath, 'utf8'));
    if (Number.isInteger(existing) && isPidAlive(existing)) {
      console.error(`Another bot instance is already running (PID ${existing}). Exiting.`);
      process.exit(1);
    }
  } catch {
    // No lock or unreadable: proceed.
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return () => {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Ignore.
    }
  };
}

const releaseInstanceLock = acquireInstanceLock();

// Removes temp dirs left behind by previous runs (killed/crashed bot).
// Skips dirs owned by a live process and dirs modified recently, so an
// active task in another instance can never be deleted.
function sweepStaleWorkDirs() {
  const FRESH_MS = 10 * 60 * 1000;
  const now = Date.now();
  try {
    const entries = fs.readdirSync(os.tmpdir());
    for (const name of entries) {
      if (!name.startsWith('gdrive-mov-')) continue;
      const full = path.join(os.tmpdir(), name);

      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < FRESH_MS) continue;

      try {
        const pid = Number(fs.readFileSync(path.join(full, 'owner.pid'), 'utf8'));
        if (Number.isInteger(pid) && isPidAlive(pid)) {
          console.log(`[cleanup] skipping active temp dir owned by PID ${pid}: ${full}`);
          continue;
        }
      } catch {
        // No owner marker: old-style dir, fall through to deletion.
      }

      try {
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`[cleanup] removed stale temp dir: ${full}`);
      } catch (err) {
        console.error(`[cleanup] failed to remove ${full}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[cleanup] startup sweep failed:', err.message);
  }
}

async function shutdown(signal) {
  console.log(`Received ${signal}, cleaning up temp files before exit...`);
  await cleanupAllWorkDirs();
  releaseInstanceLock();
  await bot.stop(signal);
  process.exit(0);
}

process.on('uncaughtException', async (err) => {
  console.error('[fatal] uncaught exception:', err);
  await cleanupAllWorkDirs();
  releaseInstanceLock();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
  await cleanupAllWorkDirs();
  releaseInstanceLock();
  process.exit(1);
});

sweepStaleWorkDirs();

bot
  .launch()
  .then(async () => {
    console.log('Bot is running. Send a Google Drive folder link.');
    const check = await validateCredentials({
      apiKey: config.bunnyStreamApiKey,
      libraryId: config.bunnyStreamLibraryId,
    });
    if (check.ok) {
      console.log('Bunny Stream credentials OK.');
    } else {
      console.error(
        `[warn] Bunny Stream credential check failed (HTTP ${check.status || '?'}): ${check.message} - uploads will fail.`,
      );
    }
  })
  .catch((err) => {
    console.error('Failed to start bot:', err.message);
    process.exit(1);
  });
