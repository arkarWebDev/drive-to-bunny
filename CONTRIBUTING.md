# Contributing

Thanks for your interest in contributing to tele-upload-bnb.

## Setup

```bash
nvm use          # or use Node.js >= 18
npm install
cp .env.example .env
```

You need real credentials (Telegram bot token + Bunny Stream library) to run
the bot end-to-end. Most changes can be developed and verified without them:

```bash
npm run lint     # ESLint
npm test         # dependency-free unit tests (node:test)
```

## Guidelines

- Keep the streaming architecture: downloads, extraction and uploads must
  never load whole files into memory.
- Temp files must always be cleaned up - prefer the pattern already used in
  `src/pipeline.js` (`try`/`finally` + tracked work dirs).
- Do not commit `.env` or any real API keys.
- New behavior should ship with a unit test in `tests/`.
- Follow the existing error-code convention (`INVALID_LINK`,
  `DRIVE_NOT_FOUND`, `BUNNY_UPLOAD_FAILED`, ...) so `friendlyError()` in
  `src/bot.js` can map them to user-friendly messages.

## Submitting changes

1. Open an issue describing the bug or feature first.
2. Fork, create a branch, implement, and push.
3. Make sure `npm run lint` and `npm test` pass.
4. Open a pull request with a clear description.
