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
  `name`, всё вне списка — `Generic`. Основное написание — как в учётной системе (Wyrestorm,
  Netgear-AV, TV One), написание производителя — в `aliases`. Два уровня: `portfolio: true` (19, портфель AVAIL) и
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
| `src/avail/intake.ts` | форма сбора → карточки каталога (`npm run import:intake`), правила — `docs/avail/intake.md` |
| `src/avail/catalogPorts.ts` | каталог `library/catalog`: порты из library/avail, стенсилов Extron, снимка базы и вариантов (`fill:catalog-ports`) |
| `src/avail/extronVisio.ts`, `extronStencil.ts` | стенсилы Extron Visio: мастер → порты (`parse:extron-visio`), применение к каталогу и сравнение |

Утверждение по источнику портов (шаг 1.11): `npm run approve:catalog [-- --dry-run] [-- --verbose]`
(`api-avail/src/approveCatalog.ts`). Кандидаты — draft из каталога (meta source `avail-catalog`) уровня A по текущему
линтеру. Источник — `src/avail/portsOrigin.ts` по `avail_template_meta.catalog.portsSource`: manufacturer (stencil,
datasheet, library и variant от такого файла) → verified, `approved_via = 'bulk-source'` (миграция 9006 пересобирает
таблицу ради CHECK), `status_reason` «approved by source: ports from <kind> (<документ>)»; community (db, variant от
db, импорт easyschematic.live) и none (нет portsSource) остаются draft. verified, hidden, raw и library/avail не
трогает; повтор ничего не меняет. Отчёт — утверждено по вендорам и источникам, оставлено по причинам (source db,
variant of db, no source, level B / FIX). Библиотека отдаёт у шаблона `availPortsOrigin` и `availLevel`; модератор
видит фильтр Ports (any / manufacturer / community / no source / Review queue = draft + community + уровень B,
запоминается в браузере; `filterByPortsOrigin` в `libraryMode.ts`, точка подключения — `DeviceLibrary.tsx`
`useAvailFilteredTemplates`). На сервере: `./backup.sh`, затем `docker compose exec api npm run approve:catalog -- --dry-run`,
затем без `--dry-run`.

Стандарт v0.8 (8.1): ошибки (E) — только то, что ломает схему или спецификацию: нет портов (шасси со слотами —
не ошибка), нет connectorType, нет категории или она не лист таксономии, нет modelNumber / manufacturer /
deviceType, питание не input (кроме явных выходов). Оформление (секции вне словаря, порядок, подписи, капс, длина,
shortName, searchTerms, шапка, color, schematic=false) и пробелы в данных (нет порта питания) — W. Секция Control —
общая для serial, IR, реле, Digital I/O, tally; нормализатор секции словаря не трогает.

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

Роли (шаг 2.1) — поверх `users.role` upstream, в базе значения upstream, поэтому все проверки upstream работают как
есть; названия и маппинг — `src/avail/roles.ts`:

| Роль | users.role | Права |
|------|-----------|-------|
| Engineer | contributor (по умолчанию для нового пользователя) | схемы, библиотека verified + draft, свои шаблоны, предложение правки блока (submissions upstream) |
| Librarian | moderator | + правка, утверждение, скрытие шаблонов, массовые операции, журнал изменений |
| Admin | admin | + пользователи и роли |

Пользователи — `api-avail/src/users.ts`: `GET /avail/users`, `PUT /avail/users/:id/role` `{role: engineer|librarian|admin}`,
`PUT /avail/users/:id/active` `{active}` (admin или `ADMIN_TOKEN`). Последнего активного админа нельзя понизить или
отключить (409). Служебные аккаунты (email на `.invalid`, например `vendor-responses@avail.invalid`;
`isSystemAccount` в `src/avail/roles.ts`) — в списке `system: true`, на странице Users метка System без смены роли и
Enable/Disable; API отказывает в смене роли и доступа (409). Отключение = `users.banned`: сессии удаляются, запрос с кукой отключённого выполняется анонимно,
вход через Google заканчивается `?error=account_disabled` (`api-avail/src/requestAudit.ts`). `PUT /users/:id/role` и
`/users/:id/ban` upstream перенаправляются на наши маршруты — защита и журнал не обходятся. В редакторе: меню
аккаунта — роль, Users (admin), Audit log (librarian, admin); `src/avail/AdminUi.tsx`, `adminApi.ts`.

Журнал изменений — таблица `avail_audit_log` (миграция 9007; `api-avail/src/audit.ts`): кто (email, `admin-token`,
`system`, `cli:<команда>`), когда, что (user / template + id и название), действие (role, access, created, updated,
deleted, status), было → стало (JSON, у updated — только изменённые поля). Пишут: смена роли и доступа; смена статуса
(Review, Approve, автоматическое понижение verified); любая запись шаблона через маршруты upstream
(`server.ts` снимает шаблоны до и после запроса; приписываются шаблоны из пути запроса и новые). Запуски CLI, пишущие в базу
(`import:*`, `apply:*`, `normalize:library`, `approve:catalog`) — одна сводная запись на запуск (entity `run`, actor
`system`): команда и аргументы, коммит образа (`AVAIL_COMMIT` из build-arg `SOURCE_COMMIT`, локально — git), итоговые
счётчики (created / updated / hidden / approved / deleted и свои; `api-avail/src/runCounts.ts`); `--dry-run` не пишется,
по шаблонам CLI записей не пишет. `GET /avail/audit [?entity=user|template|run&entityId=&actor=&before=&limit=]` —
librarian и admin.

Рабочее окно библиотеки (шаг 2.2) — отдельная страница **`/library`** (librarian и admin; остальным — сообщение
и ссылка в редактор), пункт «Library workspace» в меню аккаунта. `src/avail/LibraryWorkspace.tsx` (страница),
`workspaceModel.ts` (строки, линтер с контекстом слотов всей библиотеки, ключи правил линтера, фильтры и сохранённые
фильтры, колонки, сводка массовых действий, сравнение предложений), `workspaceApi.ts`, `xlsxWrite.ts` (xlsx без
зависимостей), `ProposeUi.tsx`. Вкладка Templates: таблица всех шаблонов с виртуализацией (строки фиксированной высоты),
колонки настраиваются (запоминаются в браузере); фильтры комбинируются — vendor, category (дерево: группа или лист),
device type, status, level, ports origin (manufacturer / community / none), ports source, правило линтера, изменён с даты,
как и кем утверждён, поиск; сохранённые фильтры (Review queue, Drafts to fix, Unverified, Approved without document check —
verified + порты из базы сообщества + bulk, My edits, Hidden + свои в браузере). Массовые действия над выделением:
Approve / Move to draft / Hide / Unhide (`POST /avail/templates/status/batch`, сервер проверяет уровень A), Change
category (`POST /avail/templates/category/batch`), Export to xlsx; выборка больше 500 отправляется пачками по 500 (лимит API;
`src/avail/workspaceBulk.ts`, прогресс «Batch N of M», упавшая пачка не останавливает остальные, один общий отчёт); перед выполнением — сводка «что изменится / уже так /
будет отказано», после — отчёт; всё пишется в журнал. Панель деталей: карточка, порты по секциям, линтер, история из
журнала (`GET /avail/audit?entity=template&entityId=`), ссылки на сайт и даташит; Edit (новая вкладка
`/?availEdit=<id>` → Device Editor в сессии Edit, `AvailEditFromUrl` в `AdminUi.tsx`), Normalize (изменения и
Save to library), Approve, Hide. Данные — `GET /avail/workspace/templates` (`api-avail/src/workspace.ts`): все статусы,
уровень, причина статуса, обновлён, кто/как/когда утвердил (`avail_template_meta.approved_by`, миграция 9008 —
заполнена из журнала), источник портов и даташит (`catalog`), авторы правок (журнал); ETag по версии библиотеки и журналу.
Предложения: в Device Editor у engineer для блока из шаблона библиотеки — «Propose change» (комментарий → upstream
`POST /submissions` action update с изменённой копией), там же — его прошлые предложения с решением и комментарием.
Вкладка Proposals: `/submissions/pending`, сравнение «было → стало» по полям, портам (по id, иначе по подписи) и слотам,
линтер предложенной версии; Accept → `/submissions/:id/approve` (правка записывается, уровень и статус — по обычным
правилам), Reject с комментарием → `/:id/reject`. Решение пишется в журнал отдельной записью (action `proposal`:
accepted / rejected, комментарий, автор; `requestAudit.ts` `readProposalDecision`), сама правка — как обычное updated.

Первого админа назначают в базе:
`docker compose exec api node -e "require('better-sqlite3')('/data/easyschematic.sqlite').prepare('UPDATE users SET role=? WHERE email=?').run('admin','<email>')"`
(пользователь должен один раз войти).

Импорт сырья (`api-avail/src/importUpstream.ts`, CLI `npm run import:upstream`): тянет
публичный `GET /templates` с api.easyschematic.live, пропускает то, что по
`vendor-decisions.json` не берём (вне keep/rename/generic, вне scope, без производителя;
бренды из generic — только как «Generic <тип>» и только если такого Generic ещё нет), приводит `manufacturer` к
каноническому имени, ставит `category` по `deviceTypeDefaults`, считает `lint_level`,
пишет со статусом `raw`. Один шаблон на пару производитель+модель (`modelNumber`, иначе
`label`); `verified`/`draft` не трогает, `hidden` обновляет, оставляя скрытым; повторный
запуск ничего не меняет. Локальные улучшения переживают повторный импорт: пока шаблон в
источнике не менялся (`source_hash` в `avail_template_meta`; для строк, импортированных до
хешей, — локальная версия выше версии источника), строка не перезаписывается. На сервере: `docker compose exec api npm run import:upstream`
(`-- --dry-run` — только отчёт).

Автонормализатор (`src/avail/normalize.ts`, чистая функция `normalizeBlock(template) →
{template, changes}`): секции → словарь стандарта (по имени или по типу сигнала и
направлению) и порядок секций, `manufacturer`/`label`/`shortName`, подписи из капса,
`bidirectional` для LAN/Dante/AVB/serial/GPIO/шин, `category` по `deviceTypeDefaults` (валидную
BoQ-категорию `schematic=false` не трогает), шапка `auxiliaryData` → одна строка `{{deviceType}}`,
удаление `color`; v2: направление видео/аналогового аудио/акустики/IR из подписи вместо
`bidirectional` (стандарт 4.3), секции для speaker-level input, fiber, DMX/MIDI, фирменных шин
(gigaACE, SLink, DX, dSNAKE, DCP, YDIF, fibreACE). Логика секций — `src/avail/sections.ts`
(её же использует линтер для подсказки «use "<секция>"»). Ничего не выдумывает: неоднозначное
не меняет, а пишет в `changes` с `manual: true`. CLI `npm run normalize:library [-- --dry-run]`
(`api-avail/src/normalizeLibrary.ts`) прогоняет шаблоны наших вендоров со статусом raw/draft и
записывает те, у кого стало меньше E+W при не меньшем уровне; статус не меняет. Отчёт —
переходы уровней, топ причин и разбивка нерешённых секций по «signalType + direction».

v3 (шаг 1.7): секция Sync (genlock, word clock, timecode); HDBaseT `bidirectional` = «configurable
input/output»; разъём из сигнала, где однозначно; переименование семейств слотов и `slotFamilies` по
справочнику `docs/avail/slot-families.json`; категория платы/шасси по семейству; категории по смыслу
по id — `docs/avail/category-plan.json`. Решённые изменения (семейства, категории, notes)
записываются, если не ухудшают шаблон. Линтер с контекстом библиотеки (`slotLibraryContext`)
предупреждает о слоте без плат и плате без шасси; уровни в базе пересчитывает `relintAll` (старт API
и CLI); плата питается от шасси. Отчёт normalize:library — семейства без плат (список наполнения).
Слот принимает `slotFamily` + `slotFamilies` (тип `SlotDefinition`/`InstalledSlot`, хелперы
`src/avail/slotFamilies.ts`; точки подключения — `templateApi.getCardsByFamily`, `DeviceEditor`,
`mcpBridge`, `mcp/validation`, `deviceSwap`, `store`, `api/src/validate.ts`).

Решения инженеров по worklist (шаг 1.8a): `npm run apply:worklist [-- --dry-run] [-- --file <xlsx>]`
(`api-avail/src/applyWorklist.ts`, разбор — `worklistSolutions.ts`, чтение xlsx без зависимостей —
`xlsx.ts`; файл по умолчанию `tools/avail/incoming/Library_worklist_engineers_solutions.xlsx`, в образе
`/app/incoming`). Структурированное (`поле = значение`, «Old» → «New», порты, добавленные порты)
применяется, свободный текст — в отчёт «вручную», «ложное срабатывание» не меняет шаблон и
проверяется линтером; статусы не меняются; повторный запуск — без изменений. `npm run -s
export:vendor-requests` — CSV «нет данных» по вендорам для писем. После решений apply:worklist применяет
доработки `tools/avail/incoming/worklist-followups.json` (`api-avail/src/worklistFollowups.ts`, встроены в бандл):
`portNote` (пометки питания 3.1 по группам ложных срабатываний: bus-powered, passive, PoE, phantom, battery,
powered by host), `set` (slotFamily платы по шасси, артикул, poeDrawW = максимум класса только в пустое поле),
`splitPort` (комбо-порт → порты с общим `exclusiveGroup`), `addSlots` (QSFP по даташиту); `notDone` — решения на
шаг 1.8 (платы Yamaha PY, стойки Chief), выводятся в отчёт. SD-карты и кабель AOC скрыты через `library/hidden.json`. Источники инженеров —
`tools/avail/sources/` (extron-blocks-v4.csv, biamp-blocks.csv).

`npm run export:worklist` (`api-avail/src/worklist.ts`) — CSV для инженеров: шаблоны наших вендоров
B и FIX с топ-3 замечаниями, по вендорам. Способ утверждения (`approved_via` review/bulk,
`approved_at`, миграция 9004) показывается в карточке Review.

Ответы вендоров (шаг 1.8b): `npm run apply:vendor-responses [-- --dry-run] [-- --file <json>]`
(`api-avail/src/vendorResponses.ts`; файл по умолчанию `tools/avail/incoming/vendor-responses.json`, в образе
`AVAIL_VENDOR_RESPONSES_FILE=/app/incoming/vendor-responses.json`). `delete` — шаблон удаляется целиком
(templates + avail_template_meta; template_notes каскадом), id удалённых — в `docs/avail/deleted-templates.json`
(vendor, model, reason), их не загружает `import:upstream`. `update` — поля `set` пишутся как в файле
(только размеры, вес, мощность, PoE, напряжение, referenceUrl, modelNumber; неподходящее — в отчёт),
`note` — заметка модератора upstream (`template_notes`, автор — системный пользователь
`avail-vendor-responses`, заблокирован), видна в карточке Review. Статусы не меняются, уровни пересчитываются.
Шаблон из `library/avail` в файле — остановка без записи, код выхода 1. Повтор — без изменений.

Каталог (шаг 1.9): `library/catalog/<vendor>/*.json` — карточки Extron и Biamp по артикулам (1789, из
`avail-products-extron-biamp.xlsx`), `index.json` — список; имя файла = `slug(label)` (при совпадении
slug — с `-<артикул>`), `id` = `avail-<vendor>-<артикул>`. `_avail` — не схема upstream: вариант,
альт. артикул, `slotFamilies` шасси, `cardFamilies`, описание, `portsSource` (откуда порты:
library / db / variant / datasheet), `portsMissing` (чего нет в даташите). Карточку (габариты,
питание, категория) не перезаписываем — данные каталога авторитетнее. Порты:
`npm run fill:catalog-ports [-- --dry-run] [-- --db <снимок.sqlite>]` (в `api-avail`;
`src/avail/catalogPorts.ts`, CLI `fillCatalogPortsCli.ts`) — library/avail, затем снимок базы по
производителю + артикулу и по названию модели (verified > draft > raw, затем уровень), затем от
описанного варианта (label без варианта в скобках или цвета в конце); пишет только файлы, порты из
даташита не трогает; снимок — `tools/avail/incoming/db/easyschematic.sqlite` (не в git). Остаток —
по даташитам вручную (`portsSource.kind = "datasheet"`), после — повторный fill разносит по
вариантам. `avail:check-library` проверяет каталог: форма, имена, уникальность, `index.json`;
уровень любой (FIX допустим), в отчёте — уровни по вендорам. `npm run import:catalog
[-- --dry-run] [-- --verbose] [-- --min-level A|B]` (`api-avail/src/importCatalog.ts`, миграция 9005): в базу
уровень `--min-level` и выше (по умолчанию B: A и B идут как draft, FIX остаётся в каталоге), в отчёте —
сколько загружено A и B; совпадение — прежняя загрузка (source `avail-catalog`), id, производитель + артикул;
найден — обновить (raw/draft → draft, hidden остаётся, verified — если данные не изменились и уровень A), нет —
draft; `_avail` и `rackForm` — в `avail_template_meta.catalog`; library/avail не трогает,
deleted-templates.json соблюдает (записи с `partNumber` удаляет из базы — Biamp SQT-1);
другие шаблоны той же модели (label без варианта/цвета) со статусом raw скрывает с причиной
«superseded by catalog», verified/draft только перечисляет в отчёте;
`import:upstream` строки каталога не перезаписывает.

Стенсилы Extron (шаг 1.10): Visio-стенсилы Extron Engineering Drawings (логические блоки, 124 .vssx)
кладём в `tools/avail/incoming/extron-visio/` (не в git, 22 МБ). `npm run parse:extron-visio [-- --dir …]`
(в `api-avail`; `src/avail/extronVisio.ts`, CLI `extronVisioCli.ts`) → `tools/avail/extron-visio/extron-visio-blocks.json`
(в git, мастер на строку): part number — из `Part #` (имя мастера бывает скопировано с другого изделия), порты —
по текстам: подпись у левого/правого края, разъём в скобках под ней, номер входа слева; точки подключения не
используются (у части мастеров их нет или они внутри фигуры). Таблицы: разъём (`[F TYPE A]` → hdmi / usb-a по
сигналу, `[N POLE CS]` → phoenix + «N-pole captive screw» в notes…), сигнал по подписи, направление (видео/аудио —
по стороне, если подпись не говорит In/Out; serial/LAN/USB — bidirectional; power — input, кроме PWR insert/OUT),
секция по стандарту. Склейки: L/R-строки → один стерео-порт; номера над/под общим разъёмом → «Audio In 1-2»;
строка под нумерованным портом берёт его номер («Audio In 1», «RS-232/IR (In 7)»); функции одного разъёма
(RS-232 / CONTROL / IR) получают общий разъём; номера без подписей у шасси — позиции слотов (`modularSlots`).
Неизвестная подпись или разъём, пин-уровень (C/T/+V) → `issues`, такой мастер не применяется.
`fill:catalog-ports` читает этот файл (`--stencils`): между library и снимком базы — чистый мастер с тем же
артикулом (или `altPartNumber`), `portsSource.kind = "stencil"`; из порта сообщества с тем же сигналом и
направлением берутся notes и разъём, которого стенсил не рисует; порт питания без разъёма при AC — iec; сервисные
порты (Configuration, «(Front)») карточка сохраняет — логическая схема их не рисует. Стенсил не понижает уровень
(в базу идёт только A): если с ним уровень ниже, остаются порты сообщества, карточка — в «kept». Порты library и
datasheet только сравниваются. Затем нормализатор (берутся только порты) и линтер. Отчёт —
`tools/avail/extron-visio/report.md`: filled / replaced (с расхождениями по сигналу и направлению) / compared /
kept / skipped (проблемы мастера и топ причин) / слоты шасси / не найдено в стенсилах (по типам и категориям),
уровни до → после. Повторный запуск ничего не меняет.
Правило питания Extron (`withExtronDcPower`, все автоматические порты Extron, кроме library и datasheet): voltage
«12V DC» / «12 VDC» и нет входа питания → порт «12V DC In» (power, input, phoenix); вход питания без разъёма →
phoenix; notes «2-pole captive screw — Extron convention, verify». Шасси Extron (`_avail.slotFamilies`) без слотов:
слоты вариантов той же модели (без региона, AC, цвета), если они совпадают, иначе число из описания («for 4 AAP
Modules»), иначе причина в `_avail.portsMissing`; откуда слоты — `_avail.slotsSource`; собственные разъёмы шасси
остаются портами. Линтер: шасси только со слотами — не «no ports», но слот без `slotFamily` — W.

Форма сбора (шаг 1.10, [`docs/avail/intake.md`](docs/avail/intake.md)): шаблон
`tools/avail/intake/avail-intake-template.xlsx` (листы Instructions / Products / Lists) и правила — источник
истины формата; промпт для ИИ-ассистента — `tools/avail/intake/avail-intake-ai-prompt.md`. `npm run import:intake --
<файл.xlsx> [--dry-run]` (в `api-avail`; логика — `src/avail/intake.ts`, CLI `importIntakeCli.ts`) проверяет строки
(обязательные колонки, значения из списков по справочникам, числа без единиц, http-ссылки, уникальность артикулов,
габариты для Rack form), отчёт E/W по строкам; корректные строки пишет в `library/catalog/<vendor>/*.json` и
`index.json` (id `avail-<vendor>-<артикул>`, `_avail`: status awaiting-ports, variant, source, datasheetUrl, note,
intakeFile). Существующую карточку обновляет непустыми ячейками (пустые не стирают), порты и слоты не трогает;
прежний `_avail.source` остаётся, источник формы — `intakeSource`. Код выхода 1 при строках с ошибками. Списки листа
Lists сверяет тест `api-avail/test/intake.test.ts` (справочник меняется PR-ом вместе с шаблоном).

**Приоритет источников данных** (каталог и библиотека): документ производителя (даташит, руководство,
A&E-спецификация) > карточка каталога (`library/catalog`) > шаблон из базы. Карточка главнее базы
(`fill:catalog-ports` копирует из базы только порты), но если карточка расходится с документом
производителя (например, PoE: в карточке 802.3af Class 3 / 15.4 Вт, в даташите 802.3at Class 4 / 30 Вт),
поле карточки исправляется по документу; источник (цитата и URL) и прежнее значение — в
`_avail.notes`, у порта PoE — в notes. Опубликованное производителем число мощности пишется как есть
(30 Вт), таблица классов (25.5 Вт) — только когда числа в документе нет.

**Соглашения по портам Biamp** (утверждены, шаг 1.9): фирменные шины (DIWAC, APart, Impera NEB,
Devio-линк) — `signalType: "custom"`, название шины в подписи или в начале notes; выходы табличек
приватности Qt — `tally` (output, Control); расширительные линки Parlé XEX — `avb` (как в TCM-XA).
Неполный блок не пишется: если документ не называет разъёмы основных сигналов, портов нет, причина —
в `_avail.portsMissing`. Пометки «проверить Thru по панели» остаются в `portsMissing` у блоков с портами.

Стандарт v0.7 (3.2): габариты и вес обязательны для того, что стоит в шкафу (в т.ч. любой `rackForm`);
для монтируемого в помещении (`ROOM_MOUNTED_CATEGORIES` / `ROOM_MOUNTED_TYPES` в `blockLint.ts`) —
нет. Блок без портов и слотов — ошибка «no ports».

Generic-вендор приводится к проверенному набору планом `docs/avail/generic-plan.json`
(`npm run apply:generic-plan [-- --dry-run]`, `api-avail/src/genericPlan.ts`): переименования в
«Generic <тип или назначение>» без брендов, смена deviceType/категории (сетевые переходники и
SD-карты — BoQ-категории), удаление брендового под Generic и дублей. Generic Mini PC, LED Cabinet,
Audio DSP, Camera, Conference System — в `library/avail`. `import:upstream` не возвращает
удалённые планом id и не перезаписывает строки, записанные чистками (meta source
`vendor-decisions` / `generic-plan`).

В редакторе шаблона (Edit) есть Normalize: список изменений нормализатора и линтер после них,
сохранение нормализованной версии. Массовое утверждение: в библиотеке модератор включает
Select, отмечает шаблоны и жмёт Approve; `POST /avail/templates/status/batch` проверяет
уровень A по каждому и возвращает не прошедшие с причинами.

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
| `src/approveCatalog.ts`, `src/approveCatalogCli.ts` | утверждение draft каталога уровня A по источнику портов (`npm run approve:catalog [-- --dry-run]`), миграция 9006 (`approved_via = bulk-source`) |
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
| `src/components/DeviceLibrary.tsx` | AVAIL: `AvailLibraryToggle`, `AvailCategoryTree`, `AvailTemplateExtras`, перезагрузка по смене статусов, фильтр по источнику портов (`useAvailFilteredTemplates`) |
| `src/components/DeviceNode.tsx` | `AvailBlockBadge` — значок статуса над блоком |
| `src/components/DeviceEditor.tsx` | `AvailTemplateEditBar` — живой линтер и Save to library в режиме Edit (без сессии Edit не рендерится) |
| `src/components/ReportsDialog.tsx` | `AvailUnverifiedNotice` — предупреждение о блоках из непроверенных шаблонов |
| `src/components/LoginDialog.tsx` | `VITE_AUTH_GOOGLE_ONLY=1` → только кнопка Google (логика в `src/avail/auth.ts`) |
| `src/main.tsx` | монтирует `src/avail/AuthErrorNotice.tsx` — показывает причину отказа во входе |
| `src/components/UserMenuButton.tsx` | `AvailAccountMenuItems` (роль, Users, Audit log) и `AvailAdminDialogs` |
| `vite.config.ts` `navigateFallbackDenylist` | service worker не отдаёт SPA на навигации в `/api/` (иначе OAuth start/callback попадают в `index.html`) |
| `vite.config.ts` `availBrandingPlugin`, `AVAIL_MANIFEST`, `SOURCE_COMMIT` | `VITE_AVAIL=1` → `index.html` и PWA-манифест AVAIL Schematic (`vite.avail.ts`); хеш сборки из `SOURCE_COMMIT` (в Docker нет `.git`) |
| `src/main.tsx` | `VITE_AVAIL=1` → `AuthGate` вместо лендинга |
| `src/main.tsx` | `VITE_AVAIL=1` и путь `/library` → `src/avail/LibraryWorkspace.tsx` (рабочее окно библиотеки) внутри `AuthGate` |
| `src/App.tsx` | заголовок вкладки `appDocumentTitle`, без `PendingSubmissionBanner` |
| `src/components/MenuBar.tsx` | бренд в шапке, Help/About AVAIL, без Show Owned Gear |
| `src/components/DeviceLibrary.tsx` | без Owned Gear, ширина панели (`useLibraryWidth`) |
| `src/components/DeviceEditor.tsx` | без Submit to Community (`availSaveActions`), подсказка цвета группы |
| `src/components/ImportDevicesDialog.tsx`, `UserMenuButton.tsx` | без Add & Submit, ссылок на docs/devices.easyschematic.live |
| `src/store.ts` | `newSchematic` → `availNewSchematicDefaults`; первый визит — пустой лист (`skipDemoSchematic`); цвет шапки — `templateHeaderColor` |

Наш фронтенд-код — в `src/avail/`, тесты — `src/__tests__/avail*.test.ts`.

### Интерфейс AVAIL (`VITE_AVAIL=1`)

Флаг сборки (`src/avail/brand.ts` `isAvailBuild`; в `Dockerfile.avail` по умолчанию `1`). Без флага
каждая точка подключения ведёт себя как upstream.

- **Вход вместо лендинга** — `src/avail/AuthGate.tsx`, логика `session.ts` (`decideGate`): не вошёл →
  сразу `/auth/google/start?returnTo=<текущий адрес>`; свой экран — при `?error=` от API, при возврате
  от Google без сессии в течение минуты (защита от петли) и при недоступном API.
- **Брендинг** — «AVAIL Schematic», логотип `public/avail/` (из брендбука AVAIL), About с
  «Based on EasySchematic by duremovich (AGPL-3.0)» и ссылками на upstream и исходники коммита сборки
  (`BrandUi.tsx`); Help — только About и `VITE_DOCS_URL`, если задан (`menus.ts`).
- **Без облака upstream** — нет Owned Gear, Submit to Community, Add & Submit, ссылок на
  `*.easyschematic.live`, демо-листа «Welcome to EasySchematic».
- **Умолчания новой схемы** (`schematicDefaults.ts`) — палитра сигналов (видео `#AA00AA`, Ethernet
  `#0055CC`, Dante/AVB/AES67 `#007700`, USB `#333333`, аналог и speaker-level `#CC6600`, fiber серый
  пунктир), штамп (строка Company сверху: AVAIL DISTRIBUTION, FZCO; Engineer — вошедший пользователь;
  дата — сегодня), A3 альбомный. PoE — свойство порта, не тип сигнала: линии PoE синие, как Ethernet.
- **Цвет шапки по группе таксономии** (`headerColors.ts` `GROUP_HEADER_COLORS`): пресет > шаблон >
  группа > умолчания проекта/приложения; только пути «Группа / Категория», «Other» без цвета.
- **Ширина библиотеки** — перетаскивание правого края (200–560 px, не больше половины окна,
  двойной клик — 280), в localStorage на пользователя (`libraryWidth.ts`, `LibraryResize.tsx`).

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
  `VITE_TEMPLATE_API_URL`, `VITE_DEVICES_URL`, `VITE_AUTH_GOOGLE_ONLY`, `VITE_DOCS_URL`
  (плюс `VITE_AVAIL=1` и `SOURCE_COMMIT` — задаёт сам workflow) в
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
| 1 | **Библиотека** — закрытая библиотека устройств AVAIL на нашем API; линтер блоков `src/avail/blockLint.ts`; справочники категорий и вендоров, статусы шаблонов, импорт сырья из easyschematic.live; фильтр библиотеки по статусу, ревью модератора, автонормализатор (сделано); курируемая библиотека `library/avail` (23 шаблона уровня A), редактирование шаблонов из ревью, английский интерфейс; решения о вендорах и чистка библиотеки (сделано); каталог Extron/Biamp `library/catalog` — порты и загрузка уровня A (шаг 1.9) |
| 2 | **Классификация** — категории/типы устройств и портов под наш ассортимент |
| 3 | **Хранение** — только хранение проектов: структура клиент → объект → помещение, статусы |
| 4 | **Интеграция Claude** — помощь в проектировании через Claude |
| 5 | **Функционал** — доработки редактора (планировки и пр.) |
