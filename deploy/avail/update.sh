#!/usr/bin/env bash
# Pull the latest images from GHCR and restart what changed.
# Usage: ./update.sh            (uses IMAGE_TAG from .env, default latest)
set -euo pipefail
cd "$(dirname "$0")"

docker compose pull
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
docker compose ps
