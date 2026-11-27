---
name: avail-server-ops
description: Build, deploy and server operations of AVAIL Schematic: Docker images, GHCR workflows, deploy/avail (compose, Caddy, backups), first admin, build-time variables. Use for deploy, CI image or production server tasks.
---

# Сборка, деплой и сервер

(Перенесено из корневого CLAUDE.md без изменений текста.)

Первого админа назначают в базе:
`docker compose exec api node -e "require('better-sqlite3')('/data/easyschematic.sqlite').prepare('UPDATE users SET role=? WHERE email=?').run('admin','<email>')"`
(пользователь должен один раз войти).

## Сборка и деплой

- `Dockerfile.avail` — образ фронтенда: `npm run generate-fallback && npx vite build`,
  отдача через nginx. `tsc -b` в Docker не запускается: `.dockerignore`
  исключает `api/src` и `devices`, и проверка типов там падает. Типы
  проверяет CI (`npm run build` в `ci.yml`).
- `Dockerfile.api-avail` — образ API: esbuild-бандл `api-avail` + `api/src` +
  встроенная библиотека, рантайм `node:22-bookworm-slim`, данные в томе `/data`.
  Свой контекст сборки — `Dockerfile.api-avail.dockerignore` (allow-list), потому что
  корневой `.dockerignore` исключает `api/src` и `api/migrations`.
  ```bash
  docker run -d -p 8787:8787 -v es-data:/data \
    -e ADMIN_TOKEN=… -e GOOGLE_CLIENT_ID=… -e GOOGLE_CLIENT_SECRET=… \
    -e API_PUBLIC_URL=https://api.example.com \
    ghcr.io/avail-distribution/easyschematic-api:latest
  ```
- `.github/workflows/avail-image.yml` — на push в `master` собирает образы
  для `linux/arm64` и публикует в GHCR с тегами `latest` и `sha-<commit>`:
  `ghcr.io/avail-distribution/easyschematic` (фронтенд) и
  `ghcr.io/avail-distribution/easyschematic-api` (API).
- `.github/workflows/avail-api-test.yml` — typecheck, тесты и сборка `api-avail`
  на PR и push в `master`; job `avail-dist` — сборка AVAIL и `avail:check-dist`.
- Адреса фронтенда вшиваются при сборке (`import.meta.env`): build-args
  `VITE_TEMPLATE_API_URL`, `VITE_DEVICES_URL`, `VITE_AUTH_GOOGLE_ONLY`, `VITE_DOCS_URL`
  (плюс `VITE_AVAIL=1` и `SOURCE_COMMIT` — задаёт сам workflow) в
  `Dockerfile.avail`, в CI берутся из repository variables (`vars.*`). Пустое значение
  = дефолт приложения. В коде наши адреса не хардкодим. `VITE_DEVICES_URL` в сборке AVAIL пустой.
- Сборка AVAIL не ведёт на сервисы upstream (devices / api / docs.easyschematic.live, почта
  поддержки): адреса upstream — в `src/avail/upstream.ts` за константой `AVAIL_BUILD`
  (`import.meta.env.VITE_AVAIL`; Vite подставляет её при сборке, и ветки upstream выпадают из
  бандла); лендинг заменяется пустым модулем, строка про docs в приветственной заметке
  `defaultSchematic.json` убирается, `_headers` и `sitemap.xml` не попадают в dist, `robots.txt` —
  Disallow (`vite.avail.ts`). Разрешена одна ссылка — сайт upstream на странице About.
  `npm run avail:check-dist [-- <dist>]` (`src/avail/distCheck.ts`) проверяет dist; его запускают
  `Dockerfile.avail` после `vite build` и job `avail-dist` в `avail-api-test.yml` на PR.
- `deploy/avail/` — продакшен на сервере: `docker-compose.yml` (caddy + app + api на
  образах из GHCR), `Caddyfile` (`handle_path /api/*` → api, остальное → app, без basic
  auth), `.env.example`, `update.sh` (pull + up -d), `backup.sh` (снимок SQLite + `r2/`,
  ротация 14 дней, опционально S3). Подробности — `deploy/avail/README.md`.
  Схема: фронтенд и API на одном домене, API под `/api`
  (`https://sch.avail-int.com`, `https://sch.avail-int.com/api`).
