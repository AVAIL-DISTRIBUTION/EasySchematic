# CLAUDE.md — EasySchematic (форк AVAIL DISTRIBUTION)

## Назначение форка

Это форк [EasySchematic](https://github.com/duremovich/EasySchematic) для
AVAIL DISTRIBUTION. Мы превращаем его в рабочий инструмент AV-проектирования
для наших инженеров:

- собственный API на нашем сервере (вместо Cloudflare Workers upstream);
- закрытая библиотека устройств (наш ассортимент, не публичная community-библиотека);
- вход через Google Workspace;
- хранение проектов на сервере.

Upstream: `upstream` = https://github.com/duremovich/EasySchematic.git.
Наш репозиторий: `origin` = https://github.com/AVAIL-DISTRIBUTION/EasySchematic.git.
PR всегда открываем в `master` нашего форка, **никогда в upstream**
(`gh pr create --repo AVAIL-DISTRIBUTION/EasySchematic --base master`).

## Принятые решения

- **Аутентификация — Google Workspace.** Только аккаунты домена компании.
  Собственных логинов/паролей не заводим.
- **Проекты хранятся на сервере.** Локальное хранение в браузере — только
  как кэш/черновик, источник истины — наш API.
- **Планировки строим внутри EasySchematic.** Не выносим в draw.io или
  другие внешние инструменты.
- **Стабы не генерируем.** Стабы (stubs) на схеме расставляет инженер вручную;
  автоматическая генерация стабов не входит в задачи.

## Правила работы

- **Наши доработки — в отдельных модулях.** Код AVAIL держим в отдельных
  файлах/каталогах (например, `src/avail/`, `api-avail/`, `Dockerfile.avail`,
  `.github/workflows/avail-*.yml`). Правки в файлах upstream — минимальные
  точки подключения, чтобы `git merge upstream/master` проходил без боли.
- **Каждая доработка — с тестами.** Unit-тесты (vitest) рядом с кодом;
  для UI-сценариев — e2e (Playwright) при необходимости.
- **PR с описанием «что сделано и как проверить».** В описании PR два
  обязательных раздела: что изменено и пошаговая проверка.
- Перед PR: `npm run generate-fallback && npm test && npm run lint`.

## Стандарт блоков устройств

Все шаблоны библиотеки устройств соответствуют
[AVAIL Device Block Standard](https://claude.ai/artifact/1yZ4p4xJUjiHVmAx1VrTxH).
Соответствие проверяется линтером `avail_block_lint.py` (добавим в фазе 1
в `tools/avail/`).

## API на нашем сервере (api-avail/)

Upstream API (`api/src`) написан под Cloudflare Workers: Hono, D1 binding
`easyschematic_db`, R2 binding `SCHEMATIC_STORAGE`. Мы запускаем **то же самое
Hono-приложение без изменений** под Node, а всё своё держим в `api-avail/`:

| Файл | Что делает |
|------|------------|
| `src/main.ts` | точка входа: `@hono/node-server`, порт `PORT` (8787), graceful shutdown |
| `src/server.ts` | собирает Workers-style `env` из шимов и переменных окружения, вызывает `app.fetch` из `api/src/index.ts` |
| `src/d1.ts` | шим D1 поверх better-sqlite3: `prepare/bind/first/all/run/raw`, `batch` (одна транзакция), `exec`; файл `DATA_DIR/easyschematic.sqlite`, WAL, foreign keys ON (как в D1) |
| `src/r2.ts` | шим R2 поверх файлов: `get/put/delete/list/head` с http/custom-метаданными; `DATA_DIR/r2/objects/*` + `DATA_DIR/r2/meta/*.json` |
| `src/migrate.ts` | при старте применяет `api/migrations/*.sql` по порядку; учёт в таблице `d1_migrations` (как у wrangler, поэтому подходит дамп из D1) |
| `src/seed.ts` | сид библиотеки из встроенных шаблонов (`src/deviceLibrary.ts`) через `templateToRow` из `api/src/db.ts`, без обращения к easyschematic.live |
| `src/mail.ts` | почта отключена: запросы `fetch` к `api.resend.com` не уходят наружу, в лог пишутся только получатель и тема |

Правки в `api/src` — только минимальные точки подключения с фолбэком на поведение
upstream. Сейчас такая одна: `API_PUBLIC_URL` для Google OAuth `redirect_uri`.

Переменные окружения:

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | где слушать |
| `DATA_DIR` | `./data` | SQLite и файлы R2 — **это и есть всё, что бэкапить** |
| `MIGRATIONS_DIR` | `../api/migrations` | в Docker `/app/migrations` |
| `SEED_LIBRARY` | `if-empty` | `if-empty` / `always` (upsert встроенных шаблонов) / `off` |
| `ADMIN_TOKEN` | — (обязателен, ≥16 символов) | Bearer-токен админа; пустой токен upstream пропустил бы как админа, поэтому без него сервер не стартует |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Google OAuth |
| `API_PUBLIC_URL` | — | публичный адрес API, например `https://api.example.com`; из него строится `redirect_uri` (`…/auth/google/callback`) |
| `SUPPORT_FORWARD_EMAIL` | — | не используется (почта отключена) |

IP клиента upstream берёт из `CF-Connecting-IP` / `X-Forwarded-For`, поэтому API
должен стоять за reverse proxy, который выставляет `X-Forwarded-For`
(иначе rate limit считает всех одним клиентом `unknown`).

### Запуск локально

```bash
(cd api && npm ci --omit=dev)   # hono, postal-mime — api/src берёт их из api/node_modules
cd api-avail && npm ci
ADMIN_TOKEN=local-dev-admin-token npm run dev      # tsx watch, http://localhost:8787
curl localhost:8787/health
curl localhost:8787/templates/summary | head -c 300

npm test            # шимы D1/R2, почта, smoke (сервер, миграции, шаблоны, схемы)
npm run typecheck   # tsc по api-avail и api/src
npm run build       # esbuild → dist/server.mjs (better-sqlite3 остаётся внешним)
```

Фронтенд на локальный API: `VITE_TEMPLATE_API_URL=http://localhost:8787 npm run dev`
в корне репозитория.

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
  на PR и push в `master`.

## План фаз

| Фаза | Содержание |
|------|------------|
| 0 | **Фундамент** — Docker-образ и CI (сделано); перенос API с Cloudflare Workers на наш сервер (Node + SQLite + файловое хранилище); вход через Google Workspace только для нашего домена; ежедневные бэкапы; отключение внешней библиотеки шаблонов |
| 1 | **Библиотека** — закрытая библиотека устройств AVAIL на нашем API; линтер блоков `tools/avail/avail_block_lint.py` |
| 2 | **Классификация** — категории/типы устройств и портов под наш ассортимент |
| 3 | **Хранение** — только хранение проектов: структура клиент → объект → помещение, статусы |
| 4 | **Интеграция Claude** — помощь в проектировании через Claude |
| 5 | **Функционал** — доработки редактора (планировки и пр.) |
