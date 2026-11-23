#!/usr/bin/env bash
# Back up the API data volume: a consistent SQLite snapshot (online backup API, the
# same mechanism as sqlite3's .backup — safe while the API is running) plus the
# schematic files (r2/), in one archive. Keeps BACKUP_KEEP_DAYS days locally and
# optionally uploads to S3.
#
# Usage: ./backup.sh            — e.g. from cron: 30 3 * * * /srv/easyschematic/deploy/avail/backup.sh
# Restore: see README.md.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi
BACKUP_DIR="${BACKUP_DIR:-/srv/easyschematic/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="easyschematic-${STAMP}.tar.gz"
SNAP_DIR=".backup-${STAMP}"

log() { echo "[backup $(date -u +%H:%M:%S)] $*"; }

mkdir -p "$BACKUP_DIR"

# 1. SQLite snapshot inside the volume, via better-sqlite3 in the API image (the image
#    has no sqlite3 CLI). integrity_check runs on the copy before it's archived.
log "snapshot database"
docker compose exec -T api node -e '
  const Database = require("better-sqlite3");
  const fs = require("fs");
  const dir = "/data/" + process.argv[1];
  fs.mkdirSync(dir, { recursive: true });
  const src = new Database("/data/easyschematic.sqlite");
  src.backup(dir + "/easyschematic.sqlite").then(() => {
    src.close();
    const copy = new Database(dir + "/easyschematic.sqlite", { readonly: true });
    const ok = copy.pragma("integrity_check", { simple: true });
    copy.close();
    if (ok !== "ok") { console.error("integrity_check: " + ok); process.exit(1); }
  }).catch((e) => { console.error(e); process.exit(1); });
' "$SNAP_DIR"

# 2. Archive snapshot + r2/ out of the container, then drop the snapshot.
cleanup() { docker compose exec -T api rm -rf "/data/${SNAP_DIR}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
log "archive -> ${BACKUP_DIR}/${ARCHIVE}"
docker compose exec -T api sh -c "cd /data && tar -czf - -C /data/${SNAP_DIR} easyschematic.sqlite \$( [ -d r2 ] && echo '-C /data r2' )" \
  > "${BACKUP_DIR}/${ARCHIVE}.partial"
mv "${BACKUP_DIR}/${ARCHIVE}.partial" "${BACKUP_DIR}/${ARCHIVE}"
tar -tzf "${BACKUP_DIR}/${ARCHIVE}" easyschematic.sqlite >/dev/null
log "archive ok ($(du -h "${BACKUP_DIR}/${ARCHIVE}" | cut -f1))"

# 3. Rotation: local archives older than BACKUP_KEEP_DAYS days.
find "$BACKUP_DIR" -maxdepth 1 -name 'easyschematic-*.tar.gz' -mtime +"$((BACKUP_KEEP_DAYS - 1))" -print -delete \
  | sed 's/^/[backup] removed old: /'

# 4. Optional S3 upload. Retention there is the bucket's lifecycle rule, not this script.
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  log "upload -> ${BACKUP_S3_URI%/}/${ARCHIVE}"
  endpoint=()
  [[ -n "${BACKUP_S3_ENDPOINT:-}" ]] && endpoint=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp ${endpoint[@]+"${endpoint[@]}"} "${BACKUP_DIR}/${ARCHIVE}" "${BACKUP_S3_URI%/}/${ARCHIVE}"
  else
    docker run --rm \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
      -v "${BACKUP_DIR}:/backups:ro" \
      "${AWS_CLI_IMAGE:-amazon/aws-cli:latest}" \
      s3 cp ${endpoint[@]+"${endpoint[@]}"} "/backups/${ARCHIVE}" "${BACKUP_S3_URI%/}/${ARCHIVE}"
  fi
fi

log "done"
