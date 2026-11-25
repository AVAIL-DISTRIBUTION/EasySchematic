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
сервер приезжают с новым образом. В базу попадают только файлы уровня A.

```bash
./backup.sh                                                       # обязательно первым; откат — восстановление из бэкапа
./update.sh                                                       # новый образ: каталог в /app/library/catalog, миграция 9005
docker compose exec api npm run import:catalog -- --dry-run       # создано / обновлено / ниже A / library/avail / удалено (SQT-1)
docker compose exec api npm run import:catalog
docker compose exec api npm run import:catalog -- --dry-run       # повтор: «inserted 0, updated 0»
```

Найденные по производителю + артикулу шаблоны обновляются (raw → draft, verified остаётся verified,
если данные не изменились, иначе draft с причиной), остальные создаются как draft. `library/avail`
не трогается; Biamp SQT-1 удаляется (`docs/avail/deleted-templates.json`). В отчёте
«possible duplicate» — новый шаблон, порты которого взяты из шаблона базы с похожим названием
(цветовой вариант): решите, скрыть ли старый.

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

Утверждать шаблоны (карточка ревью в библиотеке) могут модераторы и админы. Роль хранится
в `users.role` (`contributor` / `moderator` / `admin`); пользователь появляется в базе после
первого входа.

Первый админ — прямо в базе:
```bash
docker compose exec api node -e "require('better-sqlite3')('/data/easyschematic.sqlite').prepare('UPDATE users SET role=? WHERE email=?').run('admin','boss@avail-int.com')"
```
Дальше админ назначает роли через API upstream (нужна его сессия — cookie `session` из браузера):
```bash
curl -s https://sch.avail-int.com/api/users -H 'Cookie: session=<…>'                  # id пользователей
curl -s -X PUT https://sch.avail-int.com/api/users/<id>/role -H 'Cookie: session=<…>' \
     -H 'Content-Type: application/json' -d '{"role":"moderator"}'
```
Роль действует сразу; в открытом редакторе — после перезагрузки страницы.

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
