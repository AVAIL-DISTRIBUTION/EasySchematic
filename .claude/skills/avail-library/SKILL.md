---
name: avail-library
description: AVAIL device library reference: the AVAIL Device Block Standard and reference lists, roles, linter levels and standard versions, curated library, catalog (library/catalog), Extron stencils, intake form, imports and CLIs (import:*, apply:*, fill:catalog-ports, approve:catalog, normalize:library, report:*), duplicates, template statuses, users and audit log, library workspace, proposals, overrides, proposals stored as patches (conflicts, Withdraw, bulk Accept / Reject, limits), AI Assistant tokens, the MCP server and its OAuth connector (patch, raw, role-based tools). Use when working on templates, the catalog, library CLIs or these features.
---

# Библиотека AVAIL: стандарт, каталог, импорты, статусы, рабочее окно, переопределения, AI Assistant, MCP

(Перенесено из корневого CLAUDE.md без изменений текста.)

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

## Роли (шаг 2.1)

Роли (шаг 2.1) — поверх `users.role` upstream, в базе значения upstream, поэтому все проверки upstream работают как
есть; названия и маппинг — `src/avail/roles.ts`:

| Роль | users.role | Права |
|------|-----------|-------|
| Engineer | contributor (по умолчанию для нового пользователя) | схемы, библиотека verified + draft, свои шаблоны, предложение правки блока (submissions upstream) |
| AI Assistant | assistant (наше значение; для upstream — обычный пользователь) | вход по токену; чтение библиотеки, данных рабочего окна, журнала и проектов, к которым есть доступ (свои и по ссылке `/shared/:token`); черновики шаблонов, предложения правок, линтер и нормализатор без сохранения. Не может утверждать, скрывать, удалять, сливать дубли, решать «не дубли», менять роли и доступ, массовые действия |
| Librarian | moderator | + правка, утверждение, скрытие шаблонов, массовые операции, журнал изменений |
| Admin | admin | + пользователи и роли |

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

Очередь ревью (шаг 2.3): `npm run report:review-queue [-- --db <снимок>] [-- --out <md>]` (`api-avail/src/reviewQueueCli.ts`,
группировка — `src/avail/reviewQueue.ts`, предлагаемые правила — `api-avail/src/reviewRules.ts`) → `docs/avail/review-queue.md`:
draft каталога, которые не утвердит `approve:catalog` (уровень B; источник db / variant of db / нет), по причине (правило
линтера для B, источник для A) и семейству, с предложением (rule / data / manual). По умолчанию — по `library/catalog`
(что загрузит `import:catalog`, минус утверждаемое); `--db` — по базе с загруженным каталогом. Только читает. Раздел
«Proposed rules» моделирует правила, которые закрыли бы массовые причины без выдумывания данных, — не применяются без
решения. Стандарт v0.9 (3.2): монтаж в помещении и по названию/описанию (`mountedByName`); линтер в базе видит описание
и rackForm каталога (`blockOfRow` в `templateMeta.ts`: `lintRow`, `syncLintLevels`, `relintAll`, `setTemplateStatus`,
`approve:catalog`).

Стандарт v0.10 (правила R1–R3 по очереди ревью): R1 — шасси только со слотами без портов не требует powerDrawW/voltage
(`blockLint.ts`); R2 — voltage из подписи/notes единственного входа питания, если там ровно одно напряжение; R3 — подписи
длиннее 28: Input/Output → In/Out, затем уточнение в скобках → notes (`src/avail/catalogRules.ts`; применяют нормализатор
и `fill:catalog-ports` для всех карточек каталога, поэтому порты, заново скопированные из базы, их сохраняют).

Стандарт v0.11 (разбор Extron уровня B, `docs/avail/extron-b-review.md`): R4 — тип сигнала по подписи («Relay N» →
contact-closure, выход, секция Relays; eBUS → ebus, Expansion; `signalFromLabel`); R5 — пометки питания по группам
Extron (`powerNote`): пассивные сабвуферы → «passive», `HOST_POWERED` (OCS 100C/W, IPA T RLY4) → «powered by host» /
«bus-powered (eBUS)». Оба — в `catalogRules.ts` (нормализатор и `fill:catalog-ports`); `normalize:library` применяет R4
и к verified с портами сообщества — изменённый verified → draft с причиной (`SIGNAL_RULE_REASON`). Линтер: «HDBaseT/DTP/XTP
must be hdbaset» не для Pass-Through / over в подписи и не для ir / serial. Стенсил: из мастеров с одним артикулом
побеждает нарисованный для меньшего числа изделий (`indexStencils`). R6 — переопределения (`docs/avail/overrides.json`: решения инженеров по портам и принятые предложения; `applyOverrideRule`),
применяются раньше R2–R5 и ещё раз после них. Слоты шасси из документа —
`_avail.slotsSource = "document: <URL>"`, цитата — `_avail.slotsNote` (Cable Cubby F55).

Стандарт v0.12 (3.3) — жизненный цикл продукта (`src/avail/lifecycle.ts`): `upcoming` (`availableFrom`: `2027-Q3`,
`2027-09`…), `active` (по умолчанию), `eol` (`eolDate`, необязательно). Хранение: карточка каталога — `_avail.lifecycle` /
`availableFrom` / `eolDate` (проверяет `avail:check-library`); форма сбора — колонки Lifecycle (Active / Upcoming / EoL)
и Lifecycle date; база — `avail_template_meta.lifecycle` / `available_from` / `eol_date` (миграция 9012). `import:catalog`
ставит жизненный цикл файла новой карточке и когда он изменился в файле с прошлого импорта, иначе в базе остаётся
выставленное библиотекарем (в отчёте — «Lifecycle set from the catalog»). Линтер: «estimated from <аналог>» в notes порта или
`_avail.notes` / `_avail.note` — W, кроме upcoming (у него значения по аналогу уровень не понижают); в базе линтер видит
жизненный цикл через `blockOfRow` (`LIFECYCLE_SELECT`). `POST /avail/templates/lifecycle/batch` `{ids, lifecycle,
availableFrom?, eolDate?}` (librarian, admin; ≤ 500): журнал (action `lifecycle`), уровень пересчитывается сразу,
verified ниже A → draft (`demoted`). `GET /templates` отдаёт `availLifecycle` у upcoming / eol, рабочее окно —
`avail.lifecycle` / `availableFrom` / `eolDate`. В редакторе: значок «Upcoming · 2027-Q3» / «EoL» у шаблона в библиотеке и
над блоком (`AvailLifecycleBadge`, `blockLifecycle` в `libraryMode.ts`), предупреждение в Reports (`AvailLifecycleNotice`
внутри `AvailUnverifiedNotice`); в рабочем окне — фильтр Lifecycle, колонка, массовое действие Set lifecycle; MCP —
фильтр `lifecycle` в `search_templates`, `lifecycle` в элементах и в `get_template`.

Выбор из справочников в Device Editor (сборка AVAIL; `src/avail/referenceLists.ts` — модель, `ListPicker.tsx` — поле):
Category — листья `avail-taxonomy.json` с поиском, по группам верхнего уровня, «BoQ only» для `schematic=false`;
Manufacturer — `avail-vendors.json` (портфель, поддерживаемые, Generic), синоним при вводе подставляет основное имя.
Выбрать можно только значение из списка; текущее значение не из списка остаётся с пометкой «not in the list». Save to
library не сохраняет новое значение не из списка (`listFieldErrors`); тип устройства подставляет категорию по
`deviceTypeDefaults` (`categoryForDeviceType`). Тот же выбор категории — в массовом Change category рабочего окна.

Контроль дубликатов (шаг 2.4; `src/avail/duplicates.ts`, API — `api-avail/src/duplicates.ts`, `duplicateGuard.ts`):
пара — дубль, если (a) производитель + modelNumber совпадают (регистр, пробелы, пунктуация не важны) или (b) совпадает
нормализованная модель (label без производителя, его синонимов из avail-vendors.json и сокращений вроде A&H, без
пунктуации, регистра и слов варианта — цвет, MM/SM, регион, LinkLicense…) — **и** вариант тот же (поле `variant` каталога
+ слова варианта в label); различие только в варианте — это варианты, не дубли. Hidden не участвуют. Основной блок группы:
verified > draft > raw; каталог / library > сообщество; порты из документа > база > нет; уровень; число портов.
- `npm run report:duplicates [-- --db <sqlite>] [-- --out <md>]` → `docs/avail/duplicates.md` и `.xlsx` (в образе — рядом
  с базой: `-- --out /data/duplicates.md`). Только читает.
- Сервер: `POST /templates`, `PUT /templates/:id` (если меняются производитель или modelNumber — существующие дубли
  остаются редактируемыми) и `POST /submissions/:id/approve` (с правками библиотекаря) при совпадении производитель +
  modelNumber с другим шаблоном (не hidden, тот же вариант) → 409 `{ error, duplicateOf: {id, label}, link:
  "/library?template=<id>" }`; ответ отдаёт внутренний маршрут приложения, поэтому CORS работает. Другой вариант — разрешён.
- `POST /avail/templates/merge` `{primary, ids}` (librarian/admin, ≤ 500): остальные → hidden, `status_reason` «duplicate of
  <primary>», запись в журнал (`after.duplicateOf`). В рабочем окне: фильтр «Possible duplicates», колонка «Duplicate of»
  (группа вместе, основной первым), действие «Merge into…» (выбор основного, предложенный — основной группы);
  `/library?template=<id>` открывает шаблон. После массового действия выделение сбрасывается (неудачные пакеты остаются).
- «Не дубли» (`api-avail/src/notDuplicates.ts`, миграция 9009 `avail_not_duplicates`, попарно `id_a < id_b` с комментарием,
  автором, временем и производителем + modelNumber обоих на момент решения): `POST /avail/templates/not-duplicates`
  `{ids: 2..50, comment}` (librarian/admin, комментарий обязателен) помечает каждую пару выборки; `POST
  /avail/templates/not-duplicates/undo` `{a, b}` снимает. Помеченная пара не считается дублем в группах (`duplicateGroups(…,
  notDuplicates)`; группа держится через третий шаблон, если его пары не помечены), в `report:duplicates` (число пар — в
  отчёте) и в проверке 409 (`findDuplicate`). Сменился производитель или modelNumber (по ключам: регистр и пунктуация не
  в счёт) или шаблон удалён — решение снимается автоматически (`dropStaleNotDuplicates` в `syncLintLevels`: после каждой
  записи API, при старте и после CLI). Журнал — action `not-duplicate`, запись на каждый шаблон пары (отметка, Undo,
  автоснятие от `system`). В рабочем окне: массовое действие «Not duplicates» (выбраны 2+ шаблона одной группы) и в
  панели деталей — блок группы с «Not duplicates…», «Marked as not a duplicate of <шаблон>» с комментарием, кто и когда,
  Undo. `GET /avail/workspace/templates` отдаёт у шаблона `avail.notDuplicates`.
- Ошибка 409 при сохранении (Save to library, Normalize в панели, Accept предложения, Not duplicates): название
  существующего шаблона в тексте — ссылка на его карточку `/library?template=<id>` (`src/avail/apiError.ts`,
  `ErrorText.tsx`; в рабочем окне карточка открывается на месте).

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
Вкладка Proposals: `/submissions/pending`, сравнение «было → стало» в форме хранения (`storedForm`: пустые значения и данные
рабочего окна не в счёт) — любые изменённые поля, порты (по id, иначе по подписи) со всеми изменёнными полями и слоты.
Предложение update, которое ничего не меняет (как сохранила бы его библиотека), отклоняется сервером: 400 «The proposal changes
nothing…» (`api-avail/src/proposalGuard.ts`; редактор, MCP, API).
линтер предложенной версии; Accept → `/submissions/:id/approve` (правка записывается, уровень и статус — по обычным
правилам), Reject с комментарием → `/:id/reject`. Решение пишется в журнал отдельной записью (action `proposal`:
accepted / rejected, комментарий, автор; `requestAudit.ts` `readProposalDecision`), сама правка — как обычное updated.

Предложения как правки (шаг 2.9; `api-avail/src/proposals.ts`, миграция 9014 `avail_proposals`, логика —
`src/avail/templatePatch.ts`: `patchFromEdit`, `patchConflicts`, `applyPatchResolved`, `patchScope`):
- Предложение хранит правку (patch: поля верхнего уровня, порты по id — update / add / remove) и шаблон, от которого
  построено (версия и форма хранения). `submissions.data` upstream по-прежнему полный шаблон, но при Accept он не
  пишется: `server.ts` (`prepareApprove`) применяет правку к текущему шаблону и передаёт upstream результат в `data`.
  Изменилось с тех пор то же поле или порт (и не в предложенное значение) — 409 `{error, conflicts: [{key, label, base,
  current, proposed}]}`; Accept с `resolutions: {<key>: "current" | "proposed"}` выбирает сторону. Правку записывают и
  upstream `POST /submissions` (редактор, API — `beginSubmissionPatch`), и `POST /avail/proposals` `{templateId, patch |
  data, comment}` (MCP `propose_change`). Предложения без строки в `avail_proposals` (созданные до 9014) принимаются
  как раньше — целым шаблоном, во вкладке Proposals помечены.
- Переопределения при Accept — только по полям и портам правки (`endProposalOverrides` с `patchScope`).
- Комментарий со ссылкой на документ (PDF, data sheet / spec — `documentLink`) при правке портов делает его источником
  портов: `catalog.portsSource = {kind: datasheet, from: <URL>}`, и `datasheetUrl`, если его не было (журнал — updated).
- Вкладка Proposals: «сейчас → станет» по правке поверх текущего шаблона, таблица конфликтов «при создании / сейчас /
  предложено» с выбором, выбор нескольких и массовые Accept / Reject (конфликтные остаются, отчёт). `GET
  /avail/proposals/pending` — правка, изменения и конфликты. Автор отзывает своё: `POST /avail/proposals/:id/withdraw`
  (статус `withdrawn`, журнал `proposal` withdrawn; в редакторе — Withdraw у своих предложений).
- Лимит `POST /avail/proposals`: 30 в час и 30 ожидающих (как upstream); librarian и admin через коннектор (токен) — 200.

Переопределения (шаг 2.7; `src/avail/overrides.ts` — чистая логика, `api-avail/src/overrides.ts`, миграция 9011
`avail_overrides`): принятое предложение правки не теряется при импорте.
- Accept предложения update (вкладка Proposals или `POST /submissions/:id/approve` по API): `server.ts` читает шаблон до
  upstream (`beginProposalOverrides`) и после (`endProposalOverrides`) и записывает каждое изменённое поле (`kind field`:
  значение, `base` — что было) и порт (`kind port`, по подписи «как было» или id: `op set` — изменённые поля порта,
  `add`, `remove`). Комментарий — `submitter_note` предложения (источник данных) + «Review note: …» библиотекаря,
  `source` — «proposal <id> by <email>», `accepted_by`. Повторная правка того же поля/порта заменяет запись (поля порта
  сливаются, исходный `base` сохраняется). Журнал — action `override` (added / removed).
- Действуют записи базы без `removed_at` плюс записи `docs/avail/overrides.json`, которых база не знает (`overridesInForce`,
  `mergeOverrides`). Шаблон — по id, производитель + modelNumber или label. Решения инженеров по портам (бывший
  `port-decisions.json`) — записи файла с `source: "port decision"`.
- `import:catalog` накладывает переопределения на карточку (уровень — с ними; хеш строки учитывает переопределения);
  если файл каталога сменил переопределённое значение (не равно ни `base`, ни переопределению; без `base` — любое
  отличие), значение остаётся, а в отчёте — «catalog changed a field overridden by proposal …: поле — catalog X, kept
  Y». `fill:catalog-ports` (файл + таблица снимка `--db`) и `normalize:library` (R6 в `applyCatalogRules` до и после
  R2–R5; у verified с R4 — тоже) их сохраняют.
- `npm run export:overrides [-- --db <sqlite>] [-- --out <json>]` (`exportOverridesCli.ts`) → `docs/avail/overrides.json`
  (на сервере `-- --out /data/overrides.json`, файл — в репозиторий PR-ом): действующие записи, отсортированные, без id.
- `GET /avail/templates/:id/overrides` (librarian, admin, AI Assistant) → `{overrides: [{key, kind, text, source, comment,
  acceptedBy, acceptedAt, fromFile}]}`; `POST /avail/templates/:id/overrides/remove` `{key: "db:<id>" | "file:<n>"}`
  (librarian, admin): запись помечается `removed_at` (для записи файла — добавляется удалённая строка), значение шаблона
  остаётся, следующий импорт может его заменить. В панели деталей рабочего окна — блок Overrides: что, источник,
  комментарий, кто и когда, «Remove override».

AI Assistant и токены (шаг 2.5; `api-avail/src/accessTokens.ts`, `assistant.ts`, миграция 9010):
- Токен — `Authorization: Bearer avail_ai_…`, без Google. Выдаёт admin в Users (строка пользователя с ролью AI Assistant →
  Tokens → имя и срок, обязательный, не больше 366 дней; кнопки 30 / 90 дней / 1 год); значение показывается один раз, в базе —
  SHA-256 (`avail_access_tokens.token_hash`) и последние 4 символа (`hint`). Список — создан кем и когда, срок, последнее
  использование, состояние (Active / Expired / Revoked), Revoke. API: `GET|POST /avail/users/:id/tokens`, `POST
  /avail/tokens/:id/revoke` (admin).
- Сервер (`server.ts` → `resolveAccessToken`) проверяет токен до всего остального и подменяет заголовок на внутреннюю сессию
  (строка `sessions` со сроком токена, `avail_access_tokens.session_id`), поэтому проверки upstream работают как для обычного
  пользователя. 401 с текстом: неизвестный токен, отозван (дата), истёк (дата), пользователь отключён, пользователь больше не AI
  Assistant. 429 с `Retry-After` — больше `AI_TOKEN_RATE_LIMIT` запросов в минуту на токен (по умолчанию 120, счётчик в памяти).
  Ответы отдаёт внутренний маршрут приложения — CORS работает.
- Отключение пользователя отзывает все его токены; смена роли с AI Assistant — тоже (причина в `revoked_reason`).
- Служебный пользователь `claude@avail.invalid` (id `avail-ai-assistant`, миграция 9010) — роль AI Assistant, в Users метка System
  (роль и доступ не меняются), токены выдавать можно.
- Журнал: всё, что сделано по токену, пишется от пользователя токена, в колонке `avail_audit_log.token` — имя токена
  (`requestContext` в `audit.ts`, AsyncLocalStorage на время запроса); каждый запрос на запись по токену — запись `request`
  (метод, путь, статус); выдача и отзыв — `token` (entity user). В журнале и истории шаблона: «actor (token “имя”)».
- Возможности роли: `POST /avail/templates/draft` (новый шаблон в статусе draft, meta source `ai-assistant`, проверка дублей
  409 как у `POST /templates`), `POST /avail/lint` и `POST /avail/normalize` `{template}` — результат без сохранения (любой
  вошедший); предложения — `POST /submissions` upstream; `GET /avail/audit` и `GET /avail/workspace/templates` открыты для роли.

Удалённый MCP-сервер (шаг 2.6; `api-avail/src/mcp.ts`): `POST /mcp` (на сервере `https://sch.avail-int.com/api/mcp`),
Streamable HTTP без сессий — каждый POST — JSON-RPC (или пакет), ответ JSON; уведомления — 202; GET/DELETE — 405 (SSE нет);
версии протокола 2025-06-18 / 2025-03-26 / 2024-11-05; `MCP-Protocol-Version` вне списка — 400; чужой `Origin` (не из
`ALLOWED_ORIGINS`) — 403. Вход — только токен AI Assistant (без токена — 401 с `WWW-Authenticate`, сессия по cookie не
подходит). Инструменты вызывают наши маршруты от пользователя токена (`server.ts` передаёт `call` → `serve`), поэтому права
роли, проверка дублей (409 → `isError` с `duplicate_of` и ссылкой) и журнал — как в интерфейсе: `search_templates` (фильтры
рабочего окна: vendor, category, device_type, status, level, ports_source = origin, lint_rule — часть сообщения линтера,
lifecycle, text; offset/limit; hidden — только при status=hidden), `get_template` (карточка, жизненный цикл, порты по секциям, линтер, источник портов,
ссылки на сайт, даташит и `/library?template=`, дубли, история из журнала, `raw` — шаблон как хранится, с id портов, и `availLifecycle`), `lint_template`, `normalize_template` (без
сохранения), `create_draft_template` (`POST /avail/templates/draft`), `propose_change` (`POST /submissions` update;
комментарий обязателен; `patch` — только изменённые поля верхнего уровня, `null` убирает поле, порты по id: `{update, add,
remove}`, остальное берётся из текущего шаблона, `src/avail/templatePatch.ts`; полный `template` тоже принимается — чего в нём
нет, удаляется; ответ и запись журнала `proposed` перечисляют изменения), `review_queue`, `possible_duplicates`, `audit_log`. Строки рабочего окна кэшируются по ETag
`GET /avail/workspace/templates`. Журнал: создающие вызовы — `created` (черновик) и `proposed` (предложение, entity template)
от пользователя токена с его именем; чтение и сам `/mcp` не журналируются (запись `request` — только для остальных
запросов по токену). Ссылки — от `API_PUBLIC_URL` без пути. Текст записей журнала — `src/avail/auditText.ts` (чистый,
для API и редактора). Подключение в claude.ai и Claude Code — `deploy/avail/README.md`.

OAuth для коннектора (шаг 2.8; `api-avail/src/oauth.ts`, миграция 9013, клиент `src/avail/ClaudeAccessUi.tsx`):
- `/mcp` принимает и `Bearer avail_oa_…` — токен OAuth 2.1 по спецификации авторизации MCP: discovery
  `/.well-known/oauth-protected-resource[/…]` и `/.well-known/oauth-authorization-server[/…]` (издатель — `API_PUBLIC_URL`;
  401 без токена отдаёт `resource_metadata`), динамическая регистрация `/oauth/register` (redirect — https или loopback),
  `/oauth/authorize` (не вошёл — `/auth/google/start?returnTo=` на тот же запрос; вошёл — страница согласия; PKCE S256
  обязателен), `/oauth/token` (код, refresh с ротацией; доступ 1 ч, refresh 30 дней), `/oauth/revoke`.
- Подключаться могут вошедшие через Google пользователи домена `GOOGLE_ALLOWED_DOMAIN`, не отключённые, не служебные и не
  AI Assistant. Токен превращается во внутреннюю сессию пользователя (как токены AI Assistant), поэтому роль и права —
  его; журнал — от него, в колонке `token` — «via Claude» (`auditActor`: «email via Claude»). Инструменты MCP по роли
  (`toolsFor`): engineer — чтение (`/templates?include=raw`), линтер, нормализатор, `propose_change`; librarian, admin,
  AI Assistant — все. Статические токены `avail_ai_…` работают как прежде.
- Users: колонка Claude access (`GET /avail/users/:id/oauth`, `POST /avail/oauth/grants/:id/revoke`, admin);
  отключение пользователя отзывает подключения. Caddy проксирует корневые `/.well-known/oauth-*` в API.
- Предпросмотры линтера учитывают жизненный цикл, как сохранение: `/avail/lint` и `/avail/normalize` (и MCP) — `_avail` /
  `availLifecycle` шаблона, иначе сохранённые по id (с заметками каталога, `storedAvail`); панель Normalize и Proposals —
  `lintAsStored` (`withLifecycle` в `lifecycle.ts`).

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

Соглашение о разъёме питания Wyrestorm (решение 2026-11-27, `src/avail/wyrestormPower.ts`, применяет `fill:catalog-ports`
ко всем карточкам Wyrestorm, кроме library; источник — spec sheets EX-100-H2, RXV-35-4K, NHD-400, NHD-500-IW-TX): только
где документ разъём не называет, по корпусу (`wyrestormBody`) — настольная / полочная коробка (rackForm shelf-only) с DC →
`barrel` (locking DC, threaded bushing), напряжение — блока питания (voltage карточки); настенная (`-IW`, `-UK`, `-US`; in-wall,
wall plate, gang в названии / описании) → `phoenix` 2-pin; стоечная (full / half) с сетевым входом → `iec`. Коробка или
настенная с PoH / PoC без порта питания получает «<V>V DC In» (локальный блок — альтернатива). notes порта — «Wyrestorm
convention: … — verify». Камеры, бары, панели, сетевые устройства не на стойке — не трогает. Отчёт —
`docs/avail/wyrestorm-intake.md`.

Форма сбора (шаг 1.10, [`docs/avail/intake.md`](docs/avail/intake.md)): шаблон
`tools/avail/intake/avail-intake-template.xlsx` (листы Instructions / Products / Kits / Lists) и правила — источник
истины формата; промпт для ИИ-ассистента — `tools/avail/intake/avail-intake-ai-prompt.md`. `npm run import:intake --
<файл.xlsx> [--dry-run]` (в `api-avail`; логика — `src/avail/intake.ts`, CLI `importIntakeCli.ts`) проверяет строки
(обязательные колонки, значения из списков по справочникам, числа без единиц, http-ссылки, уникальность артикулов,
габариты для Rack form), отчёт E/W по строкам; корректные строки пишет в `library/catalog/<vendor>/*.json` и
`index.json` (id `avail-<vendor>-<артикул>`, `_avail`: status awaiting-ports, variant, source, datasheetUrl, note,
intakeFile). Существующую карточку обновляет непустыми ячейками (пустые не стирают), порты и слоты не трогает;
прежний `_avail.source` остаётся, источник формы — `intakeSource`. Код выхода 1 при строках с ошибками. Списки листа
Lists сверяет тест `api-avail/test/intake.test.ts` (справочник меняется PR-ом вместе с шаблоном). Проверенная форма
(колонки ревью Decision / Reason / Data gaps): только строки Keep; Keep без Reference URL или габаритов — предупреждение.
MSRP в каталог не пишется (репозиторий публичный). Model с другим написанием вендора пишется с каноническим именем.
Комплекты — лист Kits и правило пары …-TX / …-RX (Alt part number = артикул комплекта) → `docs/avail/kits.json` и
`_avail.kit.kitPartNumbers` компонентов (`kitsOfIntake`, `mergeKits`); артикул комплекта в Alt part number не остаётся.

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
