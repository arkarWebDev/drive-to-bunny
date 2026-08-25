#!/usr/bin/env bash
# Deploys tele-upload-bnb to a VPS over SSH (first run only).
# Usage: ./scripts/deploy.sh user@your-vps-ip /opt/tele-upload-bnb
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: ./scripts/deploy.sh <ssh-target> <remote-dir>"
  exit 1
fi

SSH_TARGET="$1"
REMOTE_DIR="$2"

# 1. Install Node 20 (NodeSource) if missing
ssh "$SSH_TARGET" "command -v node >/dev/null 2>&1 || { \
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && \
  sudo apt-get install -y nodejs; }"

# 2. Create the project directory
ssh "$SSH_TARGET" "sudo mkdir -p '$REMOTE_DIR' && sudo chown \$USER '$REMOTE_DIR'"

# 3. Sync the project (excludes node_modules, .env, .git)
rsync -avz --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude .git \
  ./ "$SSH_TARGET:$REMOTE_DIR/"

# 4. Install deps + PM2 on the server
ssh "$SSH_TARGET" "cd '$REMOTE_DIR' && npm install --omit=dev && \
  (command -v pm2 >/dev/null 2>&1 || sudo npm i -g pm2)"

# 5. Create .env if missing
ssh "$SSH_TARGET" "cd '$REMOTE_DIR' && [ -f .env ] || cp .env.example .env"

echo ""
echo "Done. Now on the VPS:"
echo "  cd $REMOTE_DIR && nano .env   # fill real values"
echo "  pm2 start ecosystem.config.js"
echo "  pm2 save && pm2 startup"
