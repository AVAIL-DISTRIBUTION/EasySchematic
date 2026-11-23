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

## Сборка и деплой

- `Dockerfile.avail` — образ фронтенда: `npm run generate-fallback && npx vite build`,
  отдача через nginx. `tsc -b` в Docker не запускается: `.dockerignore`
  исключает `api/src` и `devices`, и проверка типов там падает. Типы
  проверяет CI (`npm run build` в `ci.yml`).
- `.github/workflows/avail-image.yml` — на push в `master` собирает образ
  для `linux/arm64` и публикует в `ghcr.io/avail-distribution/easyschematic`
  с тегами `latest` и `sha-<commit>`.

## План фаз

| Фаза | Содержание |
|------|------------|
| 0 | **Фундамент** — Docker-образ и CI (сделано); перенос API с Cloudflare Workers на наш сервер (Node + SQLite + файловое хранилище); вход через Google Workspace только для нашего домена; ежедневные бэкапы; отключение внешней библиотеки шаблонов |
| 1 | **Библиотека** — закрытая библиотека устройств AVAIL на нашем API; линтер блоков `tools/avail/avail_block_lint.py` |
| 2 | **Классификация** — категории/типы устройств и портов под наш ассортимент |
| 3 | **Хранение** — только хранение проектов: структура клиент → объект → помещение, статусы |
| 4 | **Интеграция Claude** — помощь в проектировании через Claude |
| 5 | **Функционал** — доработки редактора (планировки и пр.) |
