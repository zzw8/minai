#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${MINAI_REPO:-https://github.com/zzw8/minai.git}"
APP_DIR="${MINAI_DIR:-/www/wwwroot/minai}"
PORT="${MINAI_PORT:-3000}"
SERVICE_NAME="${MINAI_SERVICE:-minai}"
PYTHON_BIN="${MINAI_PYTHON:-/usr/bin/python3}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root: sudo bash scripts/install.sh"
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y git curl python3 ca-certificates
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required."
  exit 1
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "python3 is required at $PYTHON_BIN."
  exit 1
fi

mkdir -p "$(dirname "$APP_DIR")"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
elif [ -e "$APP_DIR" ] && [ "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
  echo "$APP_DIR already exists and is not an empty git checkout."
  echo "Set MINAI_DIR to another path or move the existing directory first."
  exit 1
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
fi

if grep -q '^PORT=' .env; then
  sed -i "s/^PORT=.*/PORT=$PORT/" .env
else
  printf '\nPORT=%s\n' "$PORT" >> .env
fi

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE
[Unit]
Description=MinAI lightweight AI website
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${PYTHON_BIN} ${APP_DIR}/server.py
Restart=always
RestartSec=3
Environment=PORT=${PORT}

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo
echo "MinAI has been installed."
echo "App directory: $APP_DIR"
echo "Service: $SERVICE_NAME"
echo "Local URL: http://127.0.0.1:$PORT"
echo
echo "Next steps:"
echo "1. Edit $APP_DIR/.env and set API_BASE_URL / API_KEY / AI_MODEL."
echo "2. Configure aaPanel/Nginx reverse proxy to http://127.0.0.1:$PORT."
echo "3. Open /admin to create the first administrator."
