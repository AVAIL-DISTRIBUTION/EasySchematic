# Развёртывание EasySchematic (AVAIL)

Стек: **Caddy** (HTTPS) → **app** (фронтенд) и **api** (Node + SQLite + файлы). Всё живёт
на одном домене, API доступен по пути `/api`:

```
https://sch.avail-int.com/       → app  (ghcr.io/avail-distribution/easyschematic)
https://sch.avail-int.com/api/*  → api  (ghcr.io/avail-distribution/easyschematic-api), префикс /api срезается
```

Basic auth нет: доступ ограничен входом через Google Workspace (`GOOGLE_ALLOWED_DOMAIN`),
вход по почте отключён (`DISABLE_MAGIC_LINK=1`).

## Первый запуск

1. **Google OAuth client** (Google Cloud Console → APIs & Services → Credentials →
   Create OAuth client → Web application). Тип consent screen — *Internal*, тогда войти
   могут только аккаунты нашего Workspace ещё на стороне Google.
   - Authorized redirect URI: `https://sch.avail-int.com/api/auth/google/callback`
2. **Repository variables** в GitHub (Settings → Secrets and variables → Actions →
   Variables), чтобы фронтенд собрался с нашими адресами:
   - `VITE_TEMPLATE_API_URL` = `https://sch.avail-int.com/api`
   - `VITE_AUTH_GOOGLE_ONLY` = `1`
   - `VITE_DEVICES_URL` — по желанию (сайт базы устройств; без переменной ссылка ведёт на upstream)

   После изменения переменных нужно пересобрать образ: push в master или
   Actions → AVAIL image → Run workflow.
3. **На сервере** (Docker + compose plugin, DNS домена смотрит на сервер, открыты 80 и 443):
   ```bash
   git clone https://github.com/AVAIL-DISTRIBUTION/EasySchematic.git /srv/easyschematic
   cd /srv/easyschematic/deploy/avail
   cp .env.example .env && chmod 600 .env && nano .env     # секреты и адреса
   # если пакеты в GHCR приватные:
   echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
   docker compose up -d
   docker compose logs -f api      # миграции, сид библиотеки, "listening on"
   ```
4. Проверка: `curl https://sch.avail-int.com/api/health` → `{"ok":true}`; открыть сайт и
   войти рабочим аккаунтом. Аккаунт не из домена получит сообщение об отказе.

## Обновление

```bash
./update.sh          # docker compose pull + up -d
```
Чтобы закрепить версию, укажите в `.env` `IMAGE_TAG=sha-<commit>` (оба образа собираются
из одного коммита).

## Импорт сырья в библиотеку

Шаблоны публичной библиотеки easyschematic.live загружаются в нашу со статусом `raw`:
производитель приводится к справочнику вендоров, категория ставится по типу устройства,
считается уровень по стандарту. `verified` и `draft` импорт не трогает; повторный запуск
ничего не дублирует.

```bash
docker compose exec api npm run import:upstream -- --dry-run   # только отчёт, без записи
docker compose exec api npm run import:upstream                # импорт
```
Импорт пишет в ту же базу, что и работающий API (том `/data`); перед первым импортом
стоит сделать бэкап (`./backup.sh`).

## Бэкапы

`backup.sh` делает консистентный снимок SQLite (online backup API, тот же механизм, что
у `sqlite3 .backup`; API можно не останавливать), проверяет его `integrity_check` и
складывает вместе с файлами схем (`r2/`) в `BACKUP_DIR/easyschematic-<UTC-время>.tar.gz`.
Локально хранятся `BACKUP_KEEP_DAYS` дней (14). Если задан `BACKUP_S3_URI`, архив
дополнительно загружается в S3 (или совместимое хранилище через `BACKUP_S3_ENDPOINT`):
через `aws`, если он установлен, иначе через контейнер `amazon/aws-cli`. Срок хранения в
S3 задаётся lifecycle-правилом бакета.

Ежедневно в 03:30 UTC (`crontab -e`):
```
30 3 * * * /srv/easyschematic/deploy/avail/backup.sh >> /var/log/easyschematic-backup.log 2>&1
```

### Восстановление

```bash
cd /srv/easyschematic/deploy/avail
docker compose stop api
docker run --rm -v easyschematic_api-data:/data -v /srv/easyschematic/backups:/b alpine sh -c '
  rm -rf /data/easyschematic.sqlite /data/easyschematic.sqlite-wal /data/easyschematic.sqlite-shm /data/r2 &&
  tar -xzf /b/easyschematic-YYYYMMDD-HHMMSS.tar.gz -C /data &&
  chown -R 1000:1000 /data'
docker compose start api
```
(`easyschematic_api-data` — имя тома: проект `easyschematic` + том `api-data`;
uid 1000 — пользователь `node` в образе API.)

## Переменные

Все переменные с пояснениями — в [.env.example](.env.example). Секреты: `ADMIN_TOKEN`,
`GOOGLE_CLIENT_SECRET`, `AWS_SECRET_ACCESS_KEY`. В контейнер API передаются только его
переменные, ключи S3 туда не попадают.
