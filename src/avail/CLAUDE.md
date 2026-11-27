# src/avail — фронтенд AVAIL

(Перенесено из корневого CLAUDE.md без изменений текста; загружается при работе в src/avail/.)

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
