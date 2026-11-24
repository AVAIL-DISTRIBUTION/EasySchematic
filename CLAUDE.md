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
- **UI и пользовательские сообщения — только английский; локализация — отдельной фазой.**
  Это касается интерфейса, баннеров, сообщений линтера, CLI и логов. Строки держим целыми
  фразами (без склейки из кусков), чтобы потом вынести их в переводы. Документация в
  `docs/avail/` и этот файл могут быть на русском.
- Перед PR: `npm run generate-fallback && npm test && npm run lint` (и `npm run avail:check-library`).

## Стандарт блоков устройств

Все шаблоны библиотеки устройств соответствуют стандарту
[`docs/avail/device-block-standard.md`](docs/avail/device-block-standard.md)
(AVAIL Device Block Standard). Источник истины — этот файл в репозитории;
стандарт меняем PR-ом вместе с линтером.

Справочники — тоже источник истины, меняются PR-ом:

- `docs/avail/avail-taxonomy.json` — категории учётной системы (Odoo) + Other / Generic;
  `category` шаблона = путь листовой категории, на схеме — только `schematic=true`;
  `deviceTypeDefaults` — категория по умолчанию для типа устройства (`null` — без категории);
- `docs/avail/avail-vendors.json` — вендоры и их синонимы; `manufacturer` = каноническое
  `name`, всё вне списка — `Generic`. Два уровня: `portfolio: true` (19, портфель AVAIL) и
  `portfolio: false` (11 поддерживаемых вне портфеля); линтер принимает оба;
- `docs/avail/vendor-decisions.json` — решения о вендорах (keep / rename / scope / generic,
  остальное удаляется); правила — `src/avail/vendorDecisions.ts`, применяет
  `npm run apply:vendor-decisions`, их же соблюдает `import:upstream`.

Соответствие проверяет линтер — уровень блока A / B / FIX, ошибки (E) и
рекомендации (W):

| Файл | Что это |
|------|---------|
| `src/avail/blockLint.ts` | **единственная** реализация: чистая функция `lintBlock(template) → {level, errors, warnings}`; без зависимостей от браузера и Node — для фронтенда и API |
| `src/avail/library.ts` | справочники: `findCategory`, `defaultCategoryFor`, `findVendor`, `normalizeManufacturer` |
| `src/avail/blockLintCli.ts` | CLI: `npm run avail:lint -- <файл.json> [--verbose]` |
| `src/avail/libraryFiles.ts`, `checkLibraryCli.ts` | курируемая библиотека: имя файла, уровень A, дубли; CI `npm run avail:check-library` |
| `tools/avail/avail_block_lint.py` | архив: Python-версия v0.2 (до справочников), не поддерживается |
| `tools/avail/fixtures/engineer-blocks.json` | 22 блока, отобранные инженерами (тестовые данные) |
| `tools/avail/incoming/avail-biamp-templates.json` | 4 шаблона Biamp из пилота (исходник) |
| `src/avail/vendorDecisions.ts` | правила решений о вендорах: `VendorRules.classify`, `genericTemplate` («Generic <тип>»), `completeness` |

Питание по шине (стандарт 3.1): устройство с питанием по USB или PoE без порта питания
проходит линтер, если в notes питающего порта написано «bus-powered (USB)» или «PoE».

### Курируемая библиотека

`library/avail/*.json` — по одному шаблону на файл, имя по производителю и модели латиницей
(`extron-dtp3-t-203.json` = `slug(label)`), поле `id` — id шаблона в базе (для блоков
инженеров — их upstream-id, чтобы схемы со ссылкой на шаблон получили проверенную версию).
Каждый файл обязан быть на уровне A: CI (`avail-api-test.yml`) и `npm test` падают иначе.
`library/avail-pending/` — шаблоны, которым не хватает официальных данных (CI их уровень не
требует, `import:avail` не грузит). `library/hidden.json` — шаблоны, которые держим скрытыми.
Физику и referenceUrl берём только с официальных страниц производителя.

`npm run import:avail [-- --dry-run]` (`api-avail/src/importAvail.ts`): новые → draft;
файл не изменился (sha-256 в `avail_template_meta.source_hash`) → не трогаем, что бы ни
случилось с шаблоном в редакторе; файл изменился → данные из файла, verified → draft с
причиной; hidden остаётся hidden. Совпадение: по `source=avail-library` + id файла, по id,
по производитель+модель. На свежей базе CLI сначала сидит встроенную библиотеку, как сервер.

Тесты — `src/__tests__/availBlockLint.test.ts`.

### Статусы шаблонов

Таблица `avail_template_meta` (наши миграции `api-avail/migrations/9001–9003`; таблицы
upstream не меняем): `template_id` → `status` (`verified` / `draft` / `raw` / `hidden`),
`source`, `upstream_id`, `lint_level` (A / B / FIX), `linted_version`, `updated_by`,
`updated_at`, `status_reason`, `status_changed_at`, `source_hash`. Шаблон без строки — `raw`; при старте API каждый шаблон получает строку.

`lint_level` пересчитывается при каждом сохранении шаблона любым маршрутом (upstream
`PUT /templates/:id`, `POST /templates`, одобрение заявки): upstream увеличивает
`templates.version`, а после каждого успешного запроса на запись `server.ts` вызывает
`syncLintLevels` — перелинтовка шаблонов, у которых `linted_version ≠ version`.
**Устаревший verified:** если после сохранения уровень ниже A, статус автоматически
становится `draft`, причина и время — в `status_reason` / `status_changed_at` (миграция 9003),
API отдаёт их как `statusReason` / `statusChangedAt`. Ручная смена статуса причину сбрасывает.

| Статус | Что значит |
|--------|------------|
| `verified` | проверен AVAIL (уровень A), для проектов заказчику |
| `draft` | инженер дорабатывает |
| `raw` | сырьё (импорт), не проверено |
| `hidden` | не показывается в библиотеке |

API (`api-avail/src/routes.ts`): `GET /avail/templates/status[?status=…]`,
`GET /avail/templates/:id/status` — без авторизации, как `GET /templates`;
`PUT /avail/templates/:id/status` `{"status": …}` — модератор/админ или `ADMIN_TOKEN`,
пересчитывает `lint_level`, пишет `updated_by`; `verified` — только при уровне A, иначе
400 с `level`, `errors`, `warnings`. Смена статуса сдвигает ETag библиотеки.

Библиотека отфильтрована по статусу: `server.ts` отдаёт `GET /templates` и
`GET /templates/summary` нашими маршрутами `/avail/library/…` — по умолчанию `verified` +
`draft`, `?include=raw` добавляет `raw`, `?include=hidden` — только модератору/админу (иначе
403). У каждого шаблона поле `availStatus`, в ответе заголовок `X-Avail-Library: 1`.
`GET /templates/:id` не фильтруется (схемы ссылаются и на raw-шаблоны).

Редактор (`src/avail/libraryMode.ts`, `LibraryUi.tsx`, `useAvail.ts`) включает режим AVAIL
сам, увидев `X-Avail-Library`; с API upstream всё как в upstream. В режиме AVAIL:
переключатель Show unverified (запоминается в браузере), список без встроенной
библиотеки-подложки (поиск по id для существующих схем её сохраняет), группировка по
таксономии (группа → подкатегория, только `schematic=true`, остальное — Uncategorized),
значки Draft / Unverified / Hidden у шаблонов и блоков на схеме (в экспорт не попадают),
предупреждение в отчётах о блоках из непроверенных шаблонов, для модератора — карточка
Review (порты по секциям, карточка устройства, линтер, чек-лист инженера, причина
автосмены статуса; Move to draft / Hide / Verify) и кнопка **Edit**: открывает Device
Editor upstream на временной копии шаблона из базы (`src/avail/templateEdit.ts`), в редакторе
— живой линтер и Save to library (`PUT /templates/:id`); после сохранения уровень и статус
пересчитываются, копия со схемы убирается.

Роли — механизм upstream: `users.role` (`contributor` / `moderator` / `admin`),
`PUT /users/:id/role` (только сессия админа). Первого админа назначают в базе:
`docker compose exec api node -e "require('better-sqlite3')('/data/easyschematic.sqlite').prepare('UPDATE users SET role=? WHERE email=?').run('admin','<email>')"`
(пользователь должен один раз войти).

Импорт сырья (`api-avail/src/importUpstream.ts`, CLI `npm run import:upstream`): тянет
публичный `GET /templates` с api.easyschematic.live, пропускает то, что по
`vendor-decisions.json` не берём (вне keep/rename/generic, вне scope, без производителя;
бренды из generic — только как «Generic <тип>» и только если такого Generic ещё нет), приводит `manufacturer` к
каноническому имени, ставит `category` по `deviceTypeDefaults`, считает `lint_level`,
пишет со статусом `raw`. Один шаблон на пару производитель+модель (`modelNumber`, иначе
`label`); `verified`/`draft` не трогает, `hidden` обновляет, оставляя скрытым; повторный
запуск ничего не меняет. На сервере: `docker compose exec api npm run import:upstream`
(`-- --dry-run` — только отчёт).

Автонормализатор (`src/avail/normalize.ts`, чистая функция `normalizeBlock(template) →
{template, changes}`): секции → словарь стандарта (по имени или по типу сигнала и
направлению) и порядок секций, `manufacturer`/`label`/`shortName`, подписи из капса,
`bidirectional` для LAN/Dante/AVB/serial/GPIO/шин, `category` по `deviceTypeDefaults`,
шапка `auxiliaryData` → одна строка `{{deviceType}}`, удаление `color`. Ничего не
выдумывает: неоднозначное не меняет, а пишет в `changes` с `manual: true`. CLI
`npm run normalize:library [-- --dry-run]` (`api-avail/src/normalizeLibrary.ts`) прогоняет
шаблоны наших вендоров со статусом raw/draft и записывает только те, у кого вырос уровень;
статус не меняет.

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
| `src/migrate.ts` | при старте применяет `api/migrations/*.sql`, затем наши `api-avail/migrations/*.sql` по порядку; учёт в таблице `d1_migrations` (как у wrangler, поэтому подходит дамп из D1) |
| `src/routes.ts`, `src/templateMeta.ts` | статусы шаблонов (`/avail/templates/…/status`), библиотека с фильтром по статусу (`/avail/library/…`), `syncLintLevels` |
| `src/importUpstream.ts`, `src/importCli.ts` | импорт сырья из публичной библиотеки (`npm run import:upstream`) |
| `src/importAvail.ts`, `src/importAvailCli.ts` | загрузка курируемой библиотеки `library/avail` (`npm run import:avail`); в образе — `/app/library`, `AVAIL_LIBRARY_DIR` |
| `src/vendorCleanup.ts`, `src/vendorCleanupCli.ts` | чистка библиотеки по `vendor-decisions.json` (`npm run apply:vendor-decisions [-- --dry-run]`), одна транзакция, `library/avail` не трогает |
| `src/normalizeLibrary.ts`, `src/normalizeCli.ts` | автонормализация шаблонов наших вендоров (`npm run normalize:library`) |
| `migrations/9xxx_*.sql` | наши миграции, применяются после upstream, учёт в той же `d1_migrations` |
| `package.runtime.json` | `package.json` образа API (`/app`): скрипты для `docker compose exec api npm run …` |
| `src/seed.ts` | сид библиотеки из встроенных шаблонов (`src/deviceLibrary.ts`) через `templateToRow` из `api/src/db.ts`, без обращения к easyschematic.live |
| `src/mail.ts` | почта отключена: запросы `fetch` к `api.resend.com` не уходят наружу, в лог пишутся только получатель и тема |

Правки в upstream-файлах — только минимальные точки подключения, каждая без
переменной ведёт себя как upstream. Сейчас это:

| Где | Точка подключения |
|-----|-------------------|
| `api/src/index.ts` `googleRedirectUri()` | `API_PUBLIC_URL` → Google OAuth `redirect_uri` |
| `api/src/index.ts` `configuredOrigins()` / `corsOrigin()` / `isAllowedOrigin()` | `ALLOWED_ORIGINS` → credentialed CORS и проверка `returnTo` |
| `api/src/index.ts` `googleAllowedDomains()` + `/auth/google/callback` | `GOOGLE_ALLOWED_DOMAIN` → вход только при `hd` из списка (и `email_verified`), отказ `?error=domain_not_allowed`; подсказка `hd=` в `/auth/google/start` |
| `api/src/index.ts` `magicLinkGate` | `DISABLE_MAGIC_LINK=1` → `/auth/login`, `/auth/verify` отвечают 403 |
| `api/src/index.ts` `maxSchematicsPerUser()` | `MAX_SCHEMATICS_PER_USER` → лимит схем на пользователя (`0` = без лимита) |
| `api/src/auth.ts` `Env.Bindings` | типы этих переменных |
| `api/src/index.ts` `export { app }` | экземпляр Hono-приложения: `api-avail` регистрирует на нём свои маршруты `/avail/…` (за теми же CORS, сессией и заголовками) |
| `src/templateApi.ts` | AVAIL: `GET /templates` с `libraryQuery()` и сессией, `noteLibraryResponse`, без встроенной подложки в списке, `invalidateTemplates()` |
| `src/components/DeviceLibrary.tsx` | AVAIL: `AvailLibraryToggle`, `AvailCategoryTree`, `AvailTemplateExtras`, перезагрузка по смене статусов |
| `src/components/DeviceNode.tsx` | `AvailBlockBadge` — значок статуса над блоком |
| `src/components/DeviceEditor.tsx` | `AvailTemplateEditBar` — живой линтер и Save to library в режиме Edit (без сессии Edit не рендерится) |
| `src/components/ReportsDialog.tsx` | `AvailUnverifiedNotice` — предупреждение о блоках из непроверенных шаблонов |
| `src/components/LoginDialog.tsx` | `VITE_AUTH_GOOGLE_ONLY=1` → только кнопка Google (логика в `src/avail/auth.ts`) |
| `src/main.tsx` | монтирует `src/avail/AuthErrorNotice.tsx` — показывает причину отказа во входе |
| `vite.config.ts` `navigateFallbackDenylist` | service worker не отдаёт SPA на навигации в `/api/` (иначе OAuth start/callback попадают в `index.html`) |

Наш фронтенд-код — в `src/avail/`, тесты — `src/__tests__/avail*.test.ts`.

Переменные окружения:

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | где слушать |
| `DATA_DIR` | `./data` | SQLite и файлы R2 — **это и есть всё, что бэкапить** |
| `MIGRATIONS_DIR` | `../api/migrations` | в Docker `/app/migrations` |
| `AVAIL_MIGRATIONS_DIR` | `api-avail/migrations` | наши миграции (9xxx); в Docker `/app/migrations-avail` |
| `SEED_LIBRARY` | `if-empty` | `if-empty` / `always` (upsert встроенных шаблонов) / `off` |
| `ADMIN_TOKEN` | — (обязателен, ≥16 символов) | Bearer-токен админа; пустой токен upstream пропустил бы как админа, поэтому без него сервер не стартует |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Google OAuth |
| `API_PUBLIC_URL` | — | публичный адрес API, например `https://sch.avail-int.com/api`; из него строится `redirect_uri` (`…/auth/google/callback`) |
| `ALLOWED_ORIGINS` | — (как upstream: `*.easyschematic.live` + loopback) | origin через запятую; **заменяет** список upstream для CORS с cookie и для `returnTo` |
| `GOOGLE_ALLOWED_DOMAIN` | — (любой аккаунт Google) | домен(ы) Workspace через запятую; вход только при совпадении claim `hd` |
| `DISABLE_MAGIC_LINK` | — (вход по почте включён) | `1` — вход по почте отключён (403). Без него ограничение домена обходится через magic-link, сервер пишет предупреждение |
| `MAX_SCHEMATICS_PER_USER` | — (как upstream: 10) | сколько схем может сохранить пользователь; `0` — без лимита (в `deploy/avail` — `0`); нецелое или отрицательное значение = 10 |
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
curl localhost:8787/avail/templates/status | head -c 300
npm run import:upstream -- --dry-run   # отчёт импорта без записи (DATA_DIR как у сервера)

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
- Адреса фронтенда вшиваются при сборке (`import.meta.env`): build-args
  `VITE_TEMPLATE_API_URL`, `VITE_DEVICES_URL`, `VITE_AUTH_GOOGLE_ONLY` в
  `Dockerfile.avail`, в CI берутся из repository variables (`vars.*`). Пустое значение
  = дефолт приложения. В коде наши адреса не хардкодим.
- `deploy/avail/` — продакшен на сервере: `docker-compose.yml` (caddy + app + api на
  образах из GHCR), `Caddyfile` (`handle_path /api/*` → api, остальное → app, без basic
  auth), `.env.example`, `update.sh` (pull + up -d), `backup.sh` (снимок SQLite + `r2/`,
  ротация 14 дней, опционально S3). Подробности — `deploy/avail/README.md`.
  Схема: фронтенд и API на одном домене, API под `/api`
  (`https://sch.avail-int.com`, `https://sch.avail-int.com/api`).

## План фаз

| Фаза | Содержание |
|------|------------|
| 0 | **Фундамент** — Docker-образ и CI (сделано); перенос API с Cloudflare Workers на наш сервер (Node + SQLite + файловое хранилище) (сделано); вход через Google Workspace только для нашего домена (сделано); ежедневные бэкапы (`deploy/avail/backup.sh` готов, cron ставится на сервере); отключение внешней библиотеки шаблонов |
| 1 | **Библиотека** — закрытая библиотека устройств AVAIL на нашем API; линтер блоков `src/avail/blockLint.ts`; справочники категорий и вендоров, статусы шаблонов, импорт сырья из easyschematic.live; фильтр библиотеки по статусу, ревью модератора, автонормализатор (сделано); курируемая библиотека `library/avail` (23 шаблона уровня A), редактирование шаблонов из ревью, английский интерфейс; решения о вендорах и чистка библиотеки (сделано) |
| 2 | **Классификация** — категории/типы устройств и портов под наш ассортимент |
| 3 | **Хранение** — только хранение проектов: структура клиент → объект → помещение, статусы |
| 4 | **Интеграция Claude** — помощь в проектировании через Claude |
| 5 | **Функционал** — доработки редактора (планировки и пр.) |
