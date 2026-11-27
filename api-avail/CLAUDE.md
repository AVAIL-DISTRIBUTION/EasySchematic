# api-avail — API AVAIL под Node

(Перенесено из корневого CLAUDE.md без изменений текста; загружается при работе в api-avail/.)

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
| `src/users.ts`, `src/audit.ts`, `src/requestAudit.ts` | пользователи и роли (`/avail/users`), журнал (`/avail/audit`), отключённые пользователи и журнал записей шаблонов вокруг каждого запроса |
| `src/mcp.ts` | удалённый MCP-сервер библиотеки `/mcp` (инструменты поиска, карточки, линтера, черновиков, предложений, журнала) |
| `src/oauth.ts` | OAuth 2.1 коннектора Claude: discovery, регистрация клиента, вход и согласие, токены, подключения в Users |
| `src/accessTokens.ts`, `src/assistant.ts` | токены AI Assistant (выдача, проверка, частота, отзыв) и возможности роли (черновик, линтер, нормализатор) |
| `src/routes.ts`, `src/templateMeta.ts` | статусы шаблонов (`/avail/templates/…/status`), библиотека с фильтром по статусу (`/avail/library/…`), `syncLintLevels` |
| `src/importUpstream.ts`, `src/importCli.ts` | импорт сырья из публичной библиотеки (`npm run import:upstream`) |
| `src/importAvail.ts`, `src/importAvailCli.ts` | загрузка курируемой библиотеки `library/avail` (`npm run import:avail`); в образе — `/app/library`, `AVAIL_LIBRARY_DIR` |
| `src/genericPlan.ts`, `src/genericPlanCli.ts` | Generic-вендор по `docs/avail/generic-plan.json` (`npm run apply:generic-plan [-- --dry-run]`), одна транзакция, `library/avail` не трогает |
| `src/vendorCleanup.ts`, `src/vendorCleanupCli.ts` | чистка библиотеки по `vendor-decisions.json` (`npm run apply:vendor-decisions [-- --dry-run]`), одна транзакция, `library/avail` не трогает; новый «Generic <тип>» — только для типов без Generic, существующие Generic не перезаписываются; отчёт перечисляет итоговые Generic (новые — с исходным шаблоном) |
| `src/vendorResponses.ts`, `src/vendorResponsesCli.ts` | ответы вендоров (`npm run apply:vendor-responses [-- --dry-run]`): удаление по `docs/avail/deleted-templates.json`, данные и заметки, одна транзакция, `library/avail` не трогает |
| `src/normalizeLibrary.ts`, `src/normalizeCli.ts` | автонормализация шаблонов наших вендоров (`npm run normalize:library`) |
| `src/fillCatalogPortsCli.ts`, `src/catalogFiles.ts` | порты каталога `library/catalog` из стенсилов Extron и снимка базы (`npm run fill:catalog-ports`), пишет только файлы и отчёт стенсилов |
| `src/extronVisioCli.ts` | стенсилы Extron → `tools/avail/extron-visio/extron-visio-blocks.json` (`npm run parse:extron-visio`); zip читает `xlsx.ts` (`readZipText`) |
| `src/importCatalog.ts`, `src/importCatalogCli.ts` | каталог уровня B и выше в базу (`npm run import:catalog [-- --min-level A|B]`); в образе — `/app/library/catalog`, `AVAIL_CATALOG_DIR` |
| `src/datasheetListCli.ts`, `src/xlsxWrite.ts` | список даташитов к скачиванию `docs/avail/datasheets-to-download.md` / `.xlsx` (`npm run report:datasheets`); минимальная запись xlsx |
| `src/reviewQueueCli.ts`, `src/reviewRules.ts` | отчёт очереди ревью `docs/avail/review-queue.md` (`npm run report:review-queue`), предлагаемые правила |
| `src/duplicates.ts`, `src/duplicateGuard.ts`, `src/duplicatesCli.ts` | дубликаты: кандидаты из базы, `POST /avail/templates/merge`, 409 при сохранении дубля, отчёт `npm run report:duplicates` |
| `src/notDuplicates.ts` | решения «не дубли» (миграция 9009): отметка и Undo, автоснятие при смене производителя / modelNumber |
| `src/overrides.ts`, `src/exportOverridesCli.ts` | переопределения (миграция 9011): запись при Accept предложения, список и снятие, `npm run export:overrides` → `docs/avail/overrides.json` |
| `src/clearCatalogPrices.ts`, `src/clearCatalogPricesCli.ts` | очистка цен (`unit_cost`) у шаблонов каталога в базе (`npm run clear:catalog-prices [-- --dry-run]`), одна запись в журнале |
| `src/approveCatalog.ts`, `src/approveCatalogCli.ts` | утверждение draft каталога уровня A по источнику портов (`npm run approve:catalog [-- --dry-run]`), миграция 9006 (`approved_via = bulk-source`) |
| `migrations/9xxx_*.sql` | наши миграции, применяются после upstream, учёт в той же `d1_migrations` |
| `package.runtime.json` | `package.json` образа API (`/app`): скрипты для `docker compose exec api npm run …` |
| `src/seed.ts` | сид библиотеки из встроенных шаблонов (`src/deviceLibrary.ts`) через `templateToRow` из `api/src/db.ts`, без обращения к easyschematic.live |
| `src/mail.ts` | почта отключена: запросы `fetch` к `api.resend.com` не уходят наружу, в лог пишутся только получатель и тема |

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
| `AI_TOKEN_RATE_LIMIT` | `120` | запросов в минуту на один токен AI Assistant (сверх — 429) |
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
