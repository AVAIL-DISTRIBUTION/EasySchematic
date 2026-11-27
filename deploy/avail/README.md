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
   - `VITE_DEVICES_URL` — не задаётся: в сборке AVAIL нет ссылок на сайт базы устройств upstream
     (workflow передаёт пустое значение; предложения и рабочее окно `/library` — наши)
   - `VITE_DOCS_URL` — по желанию (наша документация для Help → Documentation; без переменной пункта нет)

   `VITE_AVAIL=1` (интерфейс AVAIL: вход вместо лендинга, брендинг, умолчания) и `SOURCE_COMMIT`
   (коммит для About и ссылки на исходники, требование AGPL) workflow передаёт сам.

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

После импорта — автонормализация шаблонов наших вендоров (raw/draft): записываются только
шаблоны, у которых вырос уровень по стандарту, статус не меняется.

```bash
docker compose exec api npm run normalize:library -- --dry-run   # отчёт: FIX→B по вендорам, топ причин
docker compose exec api npm run normalize:library                # запись
```

Курируемая библиотека AVAIL (`library/avail/*.json` из репозитория, едет в образе API в
`/app/library`): загружается со статусом draft, `verified` ставит только модератор в
интерфейсе. Неизменившиеся файлы не трогаются (повторный запуск — без изменений); шаблон
verified, чей файл изменился, обновляется и уходит в draft с причиной. `library/hidden.json`
скрывает дубли (сейчас — второй Shure AD4Q).

```bash
docker compose exec api npm run import:avail -- --dry-run   # отчёт по каждому файлу, без записи
docker compose exec api npm run import:avail                # запись
```

После `./update.sh` (новый образ = новая версия библиотеки) — повторить `import:avail`.

### Чистка по решениям о вендорах

`docs/avail/vendor-decisions.json` решает, каких производителей библиотека держит: переименовывает
к основному написанию (как в учётной системе: WyreStorm → Wyrestorm, NETGEAR → Netgear-AV; подпись,
начинающаяся со старого написания, тоже), оставляет у Sony только системные камеры и у Netgear-AV только AV Line,
сводит бренды из списка generic в «Generic <тип>» (только для типов, где Generic ещё нет; существующие Generic не перезаписываются), удаляет остальных и
шаблоны без производителя (строки `templates` и `avail_template_meta`). Шаблоны `library/avail`
не трогаются; сохранённые схемы открываются (блок хранит свои данные). Всё в одной транзакции.

```bash
./backup.sh                                                            # обязательно перед записью
docker compose exec api npm run import:avail                           # чтобы library/avail был в базе
docker compose exec api npm run apply:vendor-decisions -- --dry-run    # отчёт без записи + итоговые Generic (NEW ← исходный шаблон)
docker compose exec api npm run apply:vendor-decisions                 # запись
```

Откат — восстановление из бэкапа. Повторный `import:upstream` удалённое не возвращает и не
затирает то, что записали нормализатор и чистки: пока шаблон в источнике не менялся
(`avail_template_meta.source_hash`), локальная строка остаётся как есть.

### Шаг 1.9: каталог Extron и Biamp (library/catalog)

Порты каталога заполняются в репозитории (`fill:catalog-ports` по снимку базы из бэкапа), на
сервер приезжают с новым образом. В базу попадают файлы уровня B и выше (A и B — как draft), FIX
остаётся в каталоге; только уровень A — `-- --min-level A`. В отчёте — сколько загружено A и B.

```bash
./backup.sh                                                       # обязательно первым; откат — восстановление из бэкапа
./update.sh                                                       # новый образ: каталог в /app/library/catalog, миграция 9005
docker compose exec api npm run import:catalog -- --dry-run       # создано / обновлено / ниже B / library/avail / удалено (SQT-1), A и B
docker compose exec api npm run import:catalog
docker compose exec api npm run import:catalog -- --dry-run       # повтор: «inserted 0, updated 0»
```

**Цены.** Репозиторий публичный, цен в каталоге нет, `import:catalog` их не пишет. Цены, которые оставила в базе
прежняя загрузка каталога, очищаются отдельно (одна сводная запись в журнале, статусы не меняются):

```bash
./backup.sh
docker compose exec api npm run clear:catalog-prices -- --dry-run   # сколько шаблонов каталога с ценой, по вендорам
docker compose exec api npm run clear:catalog-prices
```

Найденные по производителю + артикулу шаблоны обновляются (raw → draft, verified остаётся verified,
если данные не изменились и файл на уровне A, иначе draft с причиной), остальные создаются как draft. `library/avail`
не трогается; Biamp SQT-1 удаляется (`docs/avail/deleted-templates.json`). Другие шаблоны той же
модели (цветовой вариант или базовая модель: Desono C-IC6 для C-IC6 Black/White) со статусом raw
скрываются (hidden, причина «superseded by catalog (<файл>)»); verified и draft не трогаются, только
перечисляются в отчёте. Схемы со ссылкой на скрытый шаблон продолжают работать.

Снимок базы для `fill:catalog-ports` — из того же бэкапа: распаковать `easyschematic-*.tar.gz` в
`tools/avail/incoming/db/` (в git и в образ не попадает).

### Шаг 1.8b: ответы вендоров

```bash
./backup.sh                                                              # обязательно первым; откат — восстановление из бэкапа
./update.sh                                                              # новый образ (vendor-responses.json в /app/incoming)
docker compose exec api npm run apply:vendor-responses -- --dry-run      # удалено по вендорам, обновлено, уровни до/после
docker compose exec api npm run apply:vendor-responses
docker compose exec api npm run apply:vendor-responses -- --dry-run      # повтор: «Deleted: 0 … updated: 0»
```

Если в файле есть шаблон из `library/avail`, команда останавливается без записи (STOPPED, код 1).

### Шаг 1.8a: решения инженеров по worklist

```bash
./backup.sh                                                              # обязательно первым
./update.sh                                                              # новый образ (файл решений в /app/incoming)
docker compose exec api npm run apply:worklist -- --dry-run              # решения + доработки (follow-ups), ложные, уровни по вендорам
docker compose exec api npm run apply:worklist
docker compose exec api npm run import:avail -- --dry-run                # скрыть SD-карты и кабель AOC (library/hidden.json)
docker compose exec api npm run import:avail
docker compose exec api npm run normalize:library -- --dry-run
docker compose exec api npm run normalize:library
docker compose exec -T api npm run -s export:vendor-requests > vendor-requests.csv   # письма вендорам
docker compose exec -T api npm run -s export:worklist > worklist.csv     # обновлённый список работы
```

### Шаг 1.7: нормализатор v3, Sony, слоты

```bash
./backup.sh                                                          # обязательно первым
./update.sh                                                          # новый образ (миграция 9004)
docker compose exec api npm run import:avail                         # скрыть сетевые переходники, Quantum Ultra II
docker compose exec api npm run apply:vendor-decisions -- --dry-run  # решения по всем шаблонам Sony
docker compose exec api npm run apply:vendor-decisions
docker compose exec api npm run normalize:library -- --dry-run       # уровни, пары, семейства без плат
docker compose exec api npm run normalize:library
docker compose exec -T api npm run -s export:worklist > worklist.csv # список ручной работы для инженеров
```

### Generic-вендор и нормализатор v2

`docs/avail/generic-plan.json` приводит Generic к проверенному набору (переименования без брендов,
дубли и брендовое под Generic — удаляются). Три пересобранных Generic (Audio DSP, Camera,
Conference System) приходят из `library/avail` через `import:avail`.

```bash
./backup.sh                                                          # обязательно перед записью
docker compose exec api npm run import:avail                         # пересобранные Generic, Netgear-AV M4250
docker compose exec api npm run apply:vendor-decisions -- --dry-run  # написания учётной системы: WyreStorm → Wyrestorm, NETGEAR → Netgear-AV
docker compose exec api npm run apply:vendor-decisions
docker compose exec api npm run apply:generic-plan -- --dry-run      # отчёт: переименования, удаления
docker compose exec api npm run apply:generic-plan
docker compose exec api npm run normalize:library -- --dry-run       # уровни до/после, разбивка нерешённых секций
docker compose exec api npm run normalize:library
```

## Роли: модераторы и админы

Роли: **Engineer** (по умолчанию для нового пользователя), **Librarian** (правка, утверждение, скрытие
шаблонов, журнал изменений), **Admin** (плюс пользователи и роли). В базе это `users.role` upstream —
`contributor` / `moderator` / `admin`; пользователь появляется в базе после первого входа.

Первый админ — прямо в базе:
```bash
docker compose exec api node -e "require('better-sqlite3')('/data/easyschematic.sqlite').prepare('UPDATE users SET role=? WHERE email=?').run('admin','boss@avail-int.com')"
```
Дальше роли и доступ — в редакторе: меню аккаунта → **Users** (только админ): смена роли, Disable / Enable.
Последнего активного админа понизить или отключить нельзя. Отключённый пользователь сразу выходит из системы
и не может войти снова. Все смены ролей и доступа, правки и статусы шаблонов — в **Audit log** (librarian и admin).
Из консоли (Bearer — `ADMIN_TOKEN`):
```bash
curl -s https://sch.avail-int.com/api/avail/users -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s -X PUT https://sch.avail-int.com/api/avail/users/<id>/role -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'Content-Type: application/json' -d '{"role":"librarian"}'
```
Роль действует сразу; в открытом редакторе — после перезагрузки страницы.

## Коннектор Claude по OAuth (рекомендуется)

С шага 2.8 коннектор входит **через OAuth**. Каждый инженер подключается своим Google-аккаунтом Workspace
(только `GOOGLE_ALLOWED_DOMAIN`, то есть avail-int.com). Claude работает от его имени: с его ролью и правами
(engineer, librarian, admin). В журнале всё пишется от этого пользователя с пометкой «via Claude». Статические
токены AI Assistant (раздел ниже) остаются для автоматизаций и подключения без OAuth.

Что делает API (`api-avail/src/oauth.ts`):
- discovery: `/.well-known/oauth-protected-resource` и `/.well-known/oauth-authorization-server`;
- динамическая регистрация клиента (`/oauth/register`);
- вход через Google и страница согласия (`/oauth/authorize`, PKCE S256);
- токены (`/oauth/token`): доступ на 1 час, refresh на 30 дней, при каждом обновлении выдаётся новая пара;
- отзыв (`/oauth/revoke`).

Издатель — `API_PUBLIC_URL` (`https://sch.avail-int.com/api`). Caddy после обновления `Caddyfile` проксирует
в API и корневые `/.well-known/oauth-*`: часть клиентов ищет метаданные от корня домена.

### Переключить коннектор организации на OAuth

1. Обновить сервер (`./update.sh`). Миграция 9013 применится при старте API. Обновить `Caddyfile` из репозитория
   и перезапустить Caddy: `docker compose up -d caddy`.
2. Проверка: `curl -s https://sch.avail-int.com/api/.well-known/oauth-authorization-server | head -c 300`. Должен
   прийти JSON с `issuer: "https://sch.avail-int.com/api"`.
3. claude.ai, Owner организации: Settings → **Connectors**.
   - Если коннектор `AVAIL library` с заголовком `Authorization` уже есть, удалить его. Для
     автоматизаций токен остаётся, его можно отозвать отдельно (Users → `claude@avail.invalid` → Tokens).
   - **Add custom connector**: Name — `AVAIL library`, Remote MCP server URL — `https://sch.avail-int.com/api/mcp`.
     Request headers и OAuth Client ID / Secret **не заполнять**: Claude зарегистрируется сам.
4. Сообщить инженерам, что коннектор переключён.

Claude Code: `claude mcp add --transport http avail-library https://sch.avail-int.com/api/mcp`, затем в сессии
`/mcp` → avail-library → Authenticate. Откроется браузер с тем же входом.

### Что увидит инженер при первом подключении

1. В claude.ai: Settings → Connectors → `AVAIL library` → **Connect** (или Claude предложит подключиться при первом
   запросе к библиотеке).
2. Откроется вход Google. Если инженер уже вошёл в AVAIL Schematic в этом браузере, этот шаг пропускается. Входят
   только аккаунты avail-int.com; отключённый пользователь получает отказ («account_disabled»).
3. Страница **Connect Claude to AVAIL Schematic**. На ней:
   - кто подключается: email и роль;
   - что Claude сможет делать. Engineer: читать библиотеку, проверять шаблоны линтером и нормализатором, предлагать
     правки на ревью. Librarian и admin: ещё черновики шаблонов, очередь ревью, дубли и журнал;
   - что в журнале действия будут с пометкой «via Claude».
4. **Allow**: страница вернётся в claude.ai, коннектор станет Connected. **Deny**: подключение отменяется.
5. Claude сам обновляет доступ (токен на час, refresh на 30 дней). Если коннектором не пользовались 30 дней,
   claude.ai попросит подключиться снова.

Инструменты по ролям: engineer — `search_templates`, `get_template`, `lint_template`, `normalize_template`,
`propose_change`; librarian, admin и AI Assistant — все девять. Утверждать, скрывать и удалять через коннектор нельзя
никому.

### Отозвать доступ Claude

- **Users** (admin): колонка **Claude access** → **Manage**. Там список подключений (клиент, когда выдан, последнее
  использование, состояние) и **Revoke**. Следующий запрос Claude получит 401 «Access for Claude was revoked on …».
- **Disable** пользователя отзывает все его подключения и токены.
- Сам инженер может отключить коннектор в claude.ai. Подключение отзывается через `/oauth/revoke`, когда Claude его
  вызывает.
- В журнале: «Claude connected (…)» и «Claude access revoked (…)»; действия — «email via Claude».

## AI Assistant: MCP-коннектор по статическому токену

API отдаёт удалённый MCP-сервер библиотеки: **`https://sch.avail-int.com/api/mcp`** (Streamable HTTP, без
сессий; Caddy проксирует `/api/*` как есть, отдельная настройка не нужна). Вход — OAuth (раздел выше) или токен пользователя с ролью
**AI Assistant** (этот раздел: автоматизации, подключение без OAuth); без токена или с отозванным / просроченным — 401.

Инструменты (по правам роли — чтение, проверка, черновики и предложения; утверждение и скрытие — только librarian):
`search_templates`, `get_template`, `review_queue`, `possible_duplicates`, `audit_log` — чтение;
`lint_template`, `normalize_template` — проверка без сохранения; `create_draft_template` — новый шаблон в статусе
draft (дубль — отказ со ссылкой на существующий), `propose_change` — правка на ревью (вкладка Proposals в `/library`).

### 1. Создать токен

1. Меню аккаунта → **Users** (admin). Строка `claude@avail.invalid` (служебный AI Assistant, метка System) → колонка
   Tokens → **Manage**. Для отдельного ассистента можно завести пользователя и дать ему роль AI Assistant.
2. **Name** — для чего токен, например «claude.ai connector» (имя будет в журнале у каждого действия по токену),
   **Expires** — срок (30 / 90 дней / 1 год, не больше года) → **Create token**.
3. Скопировать значение `avail_ai_…` — **оно показывается один раз** (в базе только хэш). Потеряли — отозвать и создать новый.

### 2. Подключить в claude.ai

Settings → **Connectors** → **Add custom connector**:
- **Name** — `AVAIL library`;
- **Remote MCP server URL** — `https://sch.avail-int.com/api/mcp`;
- раздел **Request headers**: заголовок `Authorization`, значение `Bearer avail_ai_…` (слово `Bearer`, пробел, токен).
  OAuth Client ID / Secret не заполнять.

Ограничения claude.ai (по [документации Anthropic](https://claude.com/docs/connectors/building/authentication)):
заголовки запроса — бета, доступна не всем организациям; если раздела Request headers в диалоге нет, у организации
пока нет доступа. Коннектор с заголовком добавляет Owner организации, и токен действует для всех её участников —
в журнале все их действия будут от `claude@avail.invalid` с именем этого токена. Запросы к коннектору идут с серверов
Anthropic, поэтому адрес должен быть доступен из интернета (он доступен).

Без раздела Request headers — Claude Code:
```bash
claude mcp add --transport http avail-library https://sch.avail-int.com/api/mcp \
  --header "Authorization: Bearer avail_ai_…"
```

Проверка из консоли:
```bash
curl -s https://sch.avail-int.com/api/mcp -H "Authorization: Bearer avail_ai_…" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```

### 3. Отозвать

Users → строка пользователя → Tokens → **Manage** → **Revoke** у токена: следующий запрос получит 401 «Access token
"…" was revoked on <дата>». Отключение пользователя (Disable) отзывает все его токены; смена роли с AI Assistant — тоже.
Лимит — `AI_TOKEN_RATE_LIMIT` запросов в минуту на токен (по умолчанию 120), сверх — 429.

Журнал (Audit log): создание черновиков и предложений — от `claude@avail.invalid (token “имя”)`; чтение не пишется.

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
