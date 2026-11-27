# Форма сбора данных о продуктах (intake)

Форма — способ получить от вендора, инженера или ИИ-ассистента данные карточек по прайс-листу.
Источник истины формата — шаблон [`tools/avail/intake/avail-intake-template.xlsx`](../../tools/avail/intake/avail-intake-template.xlsx)
и этот документ; правила проверяет `src/avail/intake.ts`, загрузку в каталог делает `npm run import:intake`.
Промпт для ИИ-ассистента, который заполняет форму по прайс-листу, —
[`tools/avail/intake/avail-intake-ai-prompt.md`](../../tools/avail/intake/avail-intake-ai-prompt.md).

Порты в форме не собираются: их добавляют позже по Datasheet URL (шаг 1.9 — `fill:catalog-ports`,
даташиты, линтер).

## Листы шаблона

| Лист | Что это |
| --- | --- |
| Instructions | Правила заполнения (английский — форму заполняют вендоры) |
| Products | Данные: строка 1 — заголовки, серые курсивные строки — примеры (удалить перед отправкой; `import:intake` пропускает строки с Note «EXAMPLE ROW…») |
| Lists | Выпадающие списки: Vendors, Categories (+ Schematic block?), Device types, Rack form, Source, Lifecycle |

Списки листа Lists совпадают со справочниками репозитория (тест `api-avail/test/intake.test.ts`):
Vendors = `docs/avail/avail-vendors.json`, Categories = листовые категории `docs/avail/avail-taxonomy.json`,
Device types ⊆ типы редактора (`src/deviceTypeCategories.ts`) и `deviceTypeDefaults`. Справочник
меняется PR-ом — шаблон обновляется в том же PR.

## Колонки (лист Products)

`*` — обязательно. Числа — без единиц, десятичная точка.

| Колонка | Правило | Поле карточки каталога |
| --- | --- | --- |
| Vendor * | Каноническое имя из Lists (псевдоним — ошибка с подсказкой; нового вендора сначала добавить в `avail-vendors.json`) | `manufacturer`, папка `library/catalog/<vendor>/` |
| Category * | Листовая категория из Lists. BoQ-категория (Schematic block? = no) — предупреждение: линтер такую карточку не пропустит | `category` |
| Device type * | Тип из Lists. Платы и вставки — `expansion-card` | `deviceType` |
| Model * | Как у производителя, с вендором; если вендора в начале нет — добавляется (предупреждение) | `label` = Model, с вариантом — `Model (Variant)` |
| Part number * | Артикул производителя; **одна строка — один артикул**, повтор в файле — ошибка | `modelNumber`, `id = avail-<vendor>-<артикул>` |
| Alt part number | Альтернативный / региональный артикул | `_avail.altPartNumber` |
| Variant | Чем артикул отличается от других той же модели: цвет, MM/SM, регион, лицензия | `_avail.variant`, в скобках в `label` |
| Short name | Модель без вендора; пусто — из Model | `shortName` |
| Input voltage | Как опубликовано: «100-240V AC», «12V DC», «PoE 802.3af class 2» | `voltage` |
| Power draw (W) | Максимальное потребление от сети / DC; для PoE-устройств пусто | `powerDrawW` |
| PoE draw (W) | Потребление по PoE; только класс — максимум класса и пометка в Note | `poeDrawW` |
| PoE budget (W) | Бюджет PoE (коммутатор, DSP, инжектор) | `poeBudgetW` |
| Heat (BTU/h) | Если опубликовано | `thermalBtuh` |
| Height / Width / Depth (mm), Weight (kg) | Обязательны для всего, что ставится в шкаф (стандарт 3.2) | `heightMm`, `widthMm`, `depthMm`, `weightKg` |
| Rack form | Из Lists; Non-rack — монтаж в помещении | `rackForm` (full / half / shelf-only), `_avail.rackFormSource`, `_avail.rackUnits` |
| Slot families (chassis) | Шасси: семейства слотов через запятую | `_avail.slotFamilies` |
| Card for slot families | Плата: в какие семейства слотов входит | `slotFamily` (первое), `_avail.cardFamilies` (если несколько) |
| Reference URL * | Страница продукта у производителя (не у реселлера) | `referenceUrl` |
| Datasheet URL | Прямая ссылка на PDF; по ней потом заполняются порты | `_avail.datasheetUrl` |
| Description | Краткое описание производителя | `_avail.description` |
| Source * | Откуда большая часть значений (Lists) | `_avail.source` (у существующей карточки — `_avail.intakeSource`) |
| Note | Необычное: оценки, расхождения источников, почему поле пустое | `_avail.note` |
| Lifecycle | Из Lists: Active (по умолчанию, можно не заполнять), Upcoming (анонсирован, ещё не поставляется), EoL (снят с производства). Стандарт 3.3 | `_avail.lifecycle` (active / upcoming / eol); значение в строке заменяет жизненный цикл карточки целиком |
| Lifecycle date | Upcoming — когда начнутся поставки, EoL — с какого времени (необязательно): `2027`, `2027-Q3`, `2027-09`, `2027-09-15` | `_avail.availableFrom` / `_avail.eolDate` |

**Цен в форме нет:** репозиторий публичный, `unitCost` в каталог не пишется. Колонка цены из старой формы
(«MSRP (USD)» и любая другая с ценой в названии) принимается и игнорируется — в отчёте строка «Ignored columns».

Rack form → поля каталога: «1U Full rack» … «10U Full rack» → `full` + число U; «1U 1/2 rack» → `half`;
«1U 1/4 rack», «1U 1/8 rack», «Shelf» → `shelf-only`; «Non-rack» → без `rackForm`.

## Проверки `import:intake`

**Ошибки** — строка в каталог не попадает:

- нет обязательной колонки в заголовке или неизвестная колонка — не загружается ничего;
- пустое обязательное поле;
- значение не из списка (Vendor, Category — листовая, Device type, Rack form, Source, Lifecycle); псевдоним вендора;
- Lifecycle date не в формате `2027` / `2027-Q3` / `2027-09` / `2027-09-15` или без Lifecycle Upcoming / EoL;
- число с единицами или отрицательное («12.5 W»);
- ссылка не http(s);
- повтор артикула (вендор + артикул) в файле;
- нет габаритов или веса при Rack form, отличном от Non-rack (для существующей карточки учитываются её значения).

**Предупреждения** — строка загружается, в отчёте замечание:

- нет габаритов у того, что не монтируется в помещении (стандарт 3.2) и без Rack form;
- PoE в Input voltage без PoE draw; сетевое / DC-питание без Power draw;
- нет Datasheet URL;
- Lifecycle Upcoming без Lifecycle date;
- BoQ-категория; Model без вендора в начале;
- `expansion-card` без «Card for slot families»; семейство слотов не из `docs/avail/slot-families.json`.

## Запись в каталог

- Новая карточка: `library/catalog/<vendor>/<slug(label)>.json` (при совпадении имени — с `-<артикул>`),
  формат каталога Extron/Biamp, `_avail.status = awaiting-ports`, `ports: []`; запись в `index.json`.
- Существующая карточка (тот же `id` или вендор + артикул): непустые ячейки строки заменяют поля карточки,
  **пустые ячейки ничего не стирают**; порты, слоты, `_avail.portsSource` / `portsMissing` не трогаются.
  Изменился label — файл переименовывается, `index.json` обновляется.
- Приоритет источников (CLAUDE.md): документ производителя > карточка > база — форма заполняется по документам
  производителя, поэтому её значения заменяют карточку.
- Повторный запуск с тем же файлом ничего не меняет («unchanged»). Код выхода 1, если в файле есть строки с ошибками
  (корректные строки при этом записаны).

## Порядок работы

```bash
cd api-avail
npm run import:intake -- ../tools/avail/incoming/avail-intake-<vendor>-<yyyymmdd>.xlsx --dry-run   # отчёт
npm run import:intake -- ../tools/avail/incoming/avail-intake-<vendor>-<yyyymmdd>.xlsx             # запись в library/catalog
# дальше обычный путь каталога: порты по Datasheet URL, затем
npm run fill:catalog-ports        # порты из library/avail / базы / вариантов
cd .. && npm run avail:check-library
# PR; на сервере после бэкапа — import:catalog (deploy/avail/README.md, «Шаг 1.9»)
```
