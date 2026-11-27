---
name: avail-fork
description: How this fork of EasySchematic is built: why it exists, decisions taken (Google Workspace sign-in, server-side projects, layouts inside EasySchematic, no generated stubs), the minimal hook points in upstream files (check them when merging upstream or touching upstream files), and the phase plan. Use when merging upstream, editing an upstream file, or planning work.
---

# Форк AVAIL: назначение, решения, точки подключения upstream, фазы

(Перенесено из корневого CLAUDE.md без изменений текста.)

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

## Точки подключения в файлах upstream

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
| `src/components/DeviceEditor.tsx` | сборка AVAIL: Category и Manufacturer — `AvailCategoryField` / `AvailManufacturerField` (`ListPicker.tsx`), категория по типу — `categoryForDeviceType` |
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

## План фаз

| Фаза | Содержание |
|------|------------|
| 0 | **Фундамент** — Docker-образ и CI (сделано); перенос API с Cloudflare Workers на наш сервер (Node + SQLite + файловое хранилище) (сделано); вход через Google Workspace только для нашего домена (сделано); ежедневные бэкапы (`deploy/avail/backup.sh` готов, cron ставится на сервере); отключение внешней библиотеки шаблонов |
| 1 | **Библиотека** — закрытая библиотека устройств AVAIL на нашем API; линтер блоков `src/avail/blockLint.ts`; справочники категорий и вендоров, статусы шаблонов, импорт сырья из easyschematic.live; фильтр библиотеки по статусу, ревью модератора, автонормализатор (сделано); курируемая библиотека `library/avail` (23 шаблона уровня A), редактирование шаблонов из ревью, английский интерфейс; решения о вендорах и чистка библиотеки (сделано); каталог Extron/Biamp `library/catalog` — порты и загрузка уровня A (шаг 1.9) |
| 2 | **Классификация** — категории/типы устройств и портов под наш ассортимент |
| 3 | **Хранение** — только хранение проектов: структура клиент → объект → помещение, статусы |
| 4 | **Интеграция Claude** — помощь в проектировании через Claude |
| 5 | **Функционал** — доработки редактора (планировки и пр.) |
