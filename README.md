# drive-to-bunny

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![CI](https://github.com/arkarWebDev/drive-to-bunny/actions/workflows/ci.yml/badge.svg)](https://github.com/arkarWebDev/drive-to-bunny/actions)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A Telegram bot that mirrors **video files from public Google Drive folders to
Bunny Stream** (`.MOV` by default, any extension configurable). Paste a share
link, get back embed URLs - the rest is automatic and memory-safe, even for
10 GB videos.

## What it does

```
share link -> list folder tree -> download video files -> TUS upload to Bunny Stream -> embed URLs
```

1. Receives a public Google Drive folder link (or a single file / ZIP link)
2. Lists the folder tree via Google's embedded folder view - **no Google API
   key needed**
3. Downloads **only the configured video extensions** (default `.MOV`),
   streamed to disk
4. Uploads them to **Bunny Stream** with the resumable TUS protocol
5. Replies with a formatted report: embed URL per video, total size, cleanup
   confirmation
6. Deletes all temp files in every outcome - success, error, crash, restart

## Features

- Zero-credential Drive access (works with any "Anyone with the link" folder)
- Streams everything - RAM usage is constant regardless of file size
- Resumable multi-GB uploads with per-chunk retries (Bunny TUS endpoint)
- Live progress updates in Telegram (download %, upload %, file sizes)
- Configurable video extensions (default `.MOV`; add `.MP4`, `.MKV`, ... via env)
- Nested folders supported
- Robust temp cleanup: `finally` blocks, signal handlers, crash handlers,
  and a startup sweep with live-PID detection
- Single-instance lock, per-chat task guard, friendly error messages
- Optional allow-list of Telegram user IDs

## Requirements

- Node.js >= 18 (`.nvmrc` pins 20)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Bunny Stream](https://bunny.net/stream/) video library (Library ID + API key)

## Quick start

```bash
npm install
cp .env.example .env   # fill in the values (see below)
npm start
```

Then send a folder link to your bot in Telegram:

```
https://drive.google.com/drive/folders/1AbCdEf...?usp=sharing
```

## Configuration

All configuration lives in `.env` (copy from `.env.example`):

| Variable                    | Required | Description                                    |
| --------------------------- | -------- | ---------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`        | yes      | Bot token from @BotFather                      |
| `BUNNY_STREAM_LIBRARY_ID`   | yes      | Bunny Stream Video Library ID (number)         |
| `BUNNY_STREAM_API_KEY`      | yes      | Library API key (Stream -> Library -> API Keys)|
| `TELEGRAM_ALLOWED_USER_IDS` | no       | Comma-separated user IDs; empty = open to all  |
| `BUNNY_STREAM_COLLECTION_ID`| no       | Collection GUID to add videos to               |
| `ALLOWED_EXTENSIONS`        | no       | Video extensions to accept (default `mov`)     |
| `MAX_UPLOAD_RETRIES`        | no       | Chunk retry count before aborting (default 5)  |
| `MAX_FILE_SIZE_MB`          | no       | Skip files above this size; 0 = unlimited      |
| `TUS_CHUNK_SIZE_MB`         | no       | TUS upload chunk size (default 8)              |

## How it works

### Google Drive (no API key)

- **Listing**: `drive.google.com/embeddedfolderview?id=<folderId>`, parsed
  recursively for subfolders.
- **Downloading**: `drive.google.com/uc?export=download&id=<fileId>` with
  handling for Google's "confirm download" interstitial (form action +
  hidden `confirm`/`uuid` inputs) and clear errors for quota/virus/404 cases.

### Bunny Stream

1. `POST /library/{id}/videos` - creates the video, returns its GUID
2. TUS upload to `POST /tusupload` with signature
   `SHA256(libraryId + apiKey + expire + videoId)`, then `PATCH` chunks with
   `Upload-Offset` resync - interrupted uploads resume, they don't restart
3. The bot replies immediately with
   `https://iframe.mediadelivery.net/embed/<libraryId>/<videoId>` - Bunny
   encodes in the background

## Deployment (VPS)

The bot uses Telegram long polling - it only makes outbound HTTPS connections,
so **no inbound ports need to be opened** on the VPS.

Requirements on the server: Ubuntu/Debian, Node.js >= 18 (20 recommended),
and enough disk for the largest video in flight (~2x `MAX_FILE_SIZE_MB`).

### One-shot deploy script

```bash
./scripts/deploy.sh user@your-vps-ip /opt/tele-upload-bnb
```

It installs Node 20 if needed, syncs the project via rsync (`.env` and
`node_modules` are never uploaded), installs dependencies, and sets up PM2.

Then on the VPS:

```bash
cd /opt/tele-upload-bnb
nano .env                            # fill real values
pm2 start ecosystem.config.js        # start in production mode
pm2 save && pm2 startup              # survive reboots
```

### Useful PM2 commands

```bash
pm2 logs tele-upload-bnb             # live logs
pm2 status                           # process status
pm2 restart tele-upload-bnb          # restart after code changes
```

## Project structure

```
src/
  bot.js       # Telegraf bot: auth gate, edge cases, reports, lifecycle
  config.js    # .env loading + validation
  drive.js     # Drive link parsing, folder listing, file downloads
  extract.js   # streaming ZIP extraction (extension filter) for ZIP links
  bunny.js     # Bunny Stream API: create, TUS upload, credential check
  pipeline.js  # workflow orchestration + guaranteed temp cleanup
  utils.js     # helpers: sanitize, throttle, formats, file signatures
tests/         # dependency-free unit tests (node:test)
```

## Development

```bash
npm run lint   # ESLint
npm test       # unit tests, no external services required
npm run dev    # auto-restart on file changes
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. CI runs lint + tests on
Node 18, 20 and 22.

## Security

- Never commit `.env` - real API keys must stay out of git.
- `TELEGRAM_ALLOWED_USER_IDS` is recommended for any public bot deployment.
- Rotate your Bunny API key if it ever leaks.

## License

[MIT](LICENSE)
