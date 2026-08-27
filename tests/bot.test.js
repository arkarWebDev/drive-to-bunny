const { test } = require('node:test');
const assert = require('node:assert');
const { Telegram } = require('telegraf');
const config = require('../src/config');
const { bot } = require('../src/bot');

// Telegraf creates a NEW Telegram client per update, so we patch the
// prototype - every client (including bot.telegram) then records calls
// into `calls` instead of hitting the network.
const calls = [];
const originalCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function callApiMock(method, data) {
  calls.push({ method, data });
  return {
    ok: true,
    result: {
      id: 1,
      is_bot: true,
      first_name: 'bot',
      username: 'test_bot',
      message_id: calls.length,
      from: { id: 1, is_bot: true, first_name: 'bot' },
      chat: { id: data.chat_id },
      date: Math.floor(Date.now() / 1000),
      text: '',
    },
  };
};
test.after(() => {
  Telegram.prototype.callApi = originalCallApi;
});

// Use the first allowed user so the auth middleware passes even when
// TELEGRAM_ALLOWED_USER_IDS is configured.
const ALLOWED_ID = config.telegramAllowedUsers[0] || '2030310668';

function makeUpdate(text) {
  const firstWord = text.split(/\s+/)[0];
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 1,
      from: {
        id: Number(ALLOWED_ID),
        is_bot: false,
        first_name: 'Test',
        username: 'testuser',
      },
      chat: { id: Number(ALLOWED_ID), type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(text.startsWith('/')
        ? { entities: [{ type: 'bot_command', offset: 0, length: firstWord.length }] }
        : {}),
    },
  };
}

async function handle(text) {
  calls.length = 0;
  await bot.handleUpdate(makeUpdate(text));
  return calls;
}

test('queue command replies exactly once', async () => {
  const out = await handle('/queue');
  const replies = out.filter((c) => c.method === 'sendMessage');
  assert.strictEqual(replies.length, 1, JSON.stringify(replies));
  assert.ok(replies[0].data.text.includes('Queue status'));
});

test('unknown command gets an unknown-command reply', async () => {
  const out = await handle('/abcd');
  const replies = out.filter((c) => c.method === 'sendMessage');
  assert.strictEqual(replies.length, 1);
  assert.ok(replies[0].data.text.includes('Unknown command: /abcd'));
});

test('history command replies exactly once', async () => {
  const out = await handle('/history');
  const replies = out.filter((c) => c.method === 'sendMessage');
  assert.strictEqual(replies.length, 1, JSON.stringify(replies));
  const text = replies[0].data.text;
  assert.ok(text.includes('No history yet.') || text.includes('Recent uploads'), text);
});

test('id command replies exactly once', async () => {
  const out = await handle('/id');
  const replies = out.filter((c) => c.method === 'sendMessage');
  assert.strictEqual(replies.length, 1);
  assert.ok(replies[0].data.text.includes('Telegram user ID'));
});

test('start command replies with usage', async () => {
  const out = await handle('/start');
  const replies = out.filter((c) => c.method === 'sendMessage');
  assert.strictEqual(replies.length, 1);
  assert.ok(replies[0].data.text.includes('Telegram user ID'));
});
