---
name: avail-datasheets
description: How to process downloaded manufacturer data sheets into catalog cards (portsSource datasheet), the datasheet list report and the PR / server steps after. Use when given data sheets or asked to fill catalog ports from documents.
---

# Даташиты: список и обработка

(Перенесено из корневого CLAUDE.md без изменений текста.)

Список — `npm run report:datasheets` (api-avail; `src/avail/datasheetList.ts`, `api-avail/src/datasheetListCli.ts`) →
`docs/avail/datasheets-to-download.md` и `.xlsx` рядом: карточки каталога с портами сообщества (portsSource `db` и variant
от db) Extron и Biamp, сгруппированные так, чтобы один документ (A&E-спецификация со страницы продукта) закрыл максимум
артикулов: общая страница продукта (`referenceUrl`) или модель без варианта (цвет, MM/SM, регион). Колонки: Vendor,
Family, Models, Part numbers, Product page, Cards it closes; по убыванию «сколько закроет». После обработки документа
строка из списка уходит (перезапустить команду).

Порядок обработки скачанного (любая сессия может выполнить):

1. PDF лежат в `/Users/dmartakov/avail/datasheets/<vendor>/` (`extron/`, `biamp/`), имя файла — как скачано; в git
   их не кладём. Строку списка, которую закрывает документ, находим по странице продукта / моделям / артикулам.
2. Для каждой карточки группы (`library/catalog/<vendor>/…json`) сверяем порты с документом: число и тип разъёмов
   на задней и передней панели, сигнал, направление, разъём, notes (полюса клеммника, PoE-класс, режимы USB-C) — по
   стандарту (`docs/avail/device-block-standard.md`, разделы 4–5). **При расхождении приоритет у документа**: порты
   карточки заменяются портами по документу. Поля карточки (габариты, вес, мощность, напряжение) — заполняем пустые;
   если документ расходится с карточкой, приоритет у документа, старое значение — в `_avail.notes`.
3. `_avail.portsSource = { "kind": "datasheet", "from": "<vendor>/<имя файла>.pdf" }` (при необходимости `note` —
   страница / раздел документа). Варианты из той же группы (цвет, регион, MM/SM) получают те же порты и тот же
   `portsSource` — копией: `fill:catalog-ports` переносит порты на варианты только без портов, а варианты из базы
   свои порты имеют. Чего в документе нет — не выдумываем: перечисляем в `_avail.portsMissing`.
4. `cd api-avail && npm run fill:catalog-ports -- --db ../tools/avail/incoming/db/easyschematic.sqlite` (порты из
   datasheet не трогает, применяет R2/R3 и правило 12 V DC Extron, сравнивает со стенсилами);
   `npm run avail:check-library`; `npm run report:datasheets`; `npm run report:review-queue`.
5. Коммит в ветку `avail/datasheets-<vendor>-<семейство>` («Catalog: <Vendor> <family> ports from the data sheets»),
   PR в master с разделами «что сделано / как проверить». После мержа на сервере: `./backup.sh`, `docker compose exec
   api npm run import:catalog`, затем `approve:catalog -- --dry-run` и `approve:catalog` — карточки уровня A с
   `datasheet` утвердятся.

**Соглашения по портам Biamp** (утверждены, шаг 1.9): фирменные шины (DIWAC, APart, Impera NEB,
Devio-линк) — `signalType: "custom"`, название шины в подписи или в начале notes; выходы табличек
приватности Qt — `tally` (output, Control); расширительные линки Parlé XEX — `avb` (как в TCM-XA).
Неполный блок не пишется: если документ не называет разъёмы основных сигналов, портов нет, причина —
в `_avail.portsMissing`. Пометки «проверить Thru по панели» остаются в `portsMissing` у блоков с портами.
