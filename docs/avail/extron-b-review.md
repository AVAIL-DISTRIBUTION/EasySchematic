# Разбор Extron уровня B (стандарт v0.11)

Nov 26, 2026 · ветка `avail/extron-b-fixes`

Состояние посчитано на копии снимка базы сервера (`tools/avail/incoming/db/easyschematic.sqlite`, 25 ноября). На неё
наложены `import:catalog` и `normalize:library`, как это будет на сервере: «до» — код `master`, «после» — эта ветка.
Учитываются шаблоны Extron без hidden, уровень посчитан линтером с контекстом слотов библиотеки.

| | A | B | FIX (не в базе) |
|---|---:|---:|---:|
| до (`master`) | 1026 | **47** (draft 40, raw 7) | — |
| после | 1055 | **20** (draft 17, raw 3) | — |

27 шаблонов перешли B → A, понижений нет. Кроме того, загрузятся две карточки Cable Cubby F55 (70-1295-02/-03). Раньше
они были FIX и в базу не попадали, теперь у них уровень A.

## Что сделано

1. **Cable Cubby F55** (70-1295-02 Black, 70-1295-03 Aluminum) — 4 слота `extron-cubby-flex55`. Источник
   `_avail.slotsSource` = `document: https://www.extron.com/Power-Modules/prodsubtype-587`, цитата Extron — в
   `_avail.slotsNote`: «Most Cable Cubby F55 enclosures include standard connectivity hardware for up to four
   full-size Flex55 and EU modules». **F55 Edge (70-1296-xx) и F55 UT (70-1299-xx) не тронуты**: ни в стенсилах, ни в
   описании, ни в локальных документах числа проёмов нет. Сайт Extron отвечает автоматическим запросам Bot Defense, и
   страницы продуктов прочитать не удалось.
2. **R4, тип сигнала по подписи** (`src/avail/catalogRules.ts` `signalFromLabel`). «Relay N» и «IPCP Relay N» →
   contact-closure: выход, если порт не помечен входом, секция Relays. Подпись со словом eBUS → ebus, bidirectional,
   секция Expansion; порты с изменённой секцией встают в порядок стандарта. Правило применяют:
   - нормализатор, то есть `normalize:library` для raw/draft;
   - `fill:catalog-ports`, то есть все карточки каталога;
   - `normalize:library` для verified с портами сообщества (`portsOrigin` = community), только R4. Изменённый
     verified становится draft с причиной «signal type from the port label (standard v0.11, R4): ports changed,
     approve again». На снимке таких шаблонов нет: verified и так на уровне A.
3. **Линтер.** Правило «HDBaseT/DTP/XTP must be hdbaset» больше не срабатывает:
   - на портах с Pass-Through / Pass-thru / over в подписи («IR Pass-Through (DTP2 Out)»);
   - на сигналах ir / serial.
4. **R5, пометки питания по группам** (`powerNote`, только Extron):
   - сабвуферы, у которых все порты — входы speaker-level и нет порта питания (SF 10C SUB, SF 8CT SUB), получают
     «passive» в notes входа. Громкоговорители (speaker, в том числе SF … CT) линтер и так считает пассивными, их
     карточки не меняются: иначе `import:catalog` без пользы перевёл бы утверждённые в draft;
   - OCS 100C / 100W получают «bus-powered (eBUS)» на порту Sensor Out (eBUS). По notes сообщества это +12V/+S/-S/G от
     процессора управления;
   - IPA T RLY4 получает «powered by host» на Control / Power In («DC power from a host (12VDC)»).
5. **Ошибка выбора стенсила.** Артикулы OCS 100C/W есть в двух мастерах: в собственном (Power, два сенсорных входа) и в
   мастере PC 1224 (преобразователь питания, порты USB Power / 24 V Out / Power Out (Loop)). `fill:catalog-ports` брал
   PC 1224. Теперь при равном качестве выигрывает мастер, нарисованный для меньшего числа изделий
   (`indexStencils`). У OCS остаются порты сообщества: собственный мастер не рисует разъёмы и уровень понизил бы.
   Поэтому у OCS источник db, и `approve:catalog` их не утвердит — нужна сверка по даташиту.

## B → A (27)

| Шаблон | Артикул | Статус | Было | Что закрыло | approve:catalog |
|---|---|---|---|---|---|
| IPCP Pro 350 xi (LinkLicense) | 60-1912-01A | draft | relay ≠ contact-closure | R4 | нет (db) |
| IPCP Pro 360Q xi (Standard) | 60-1916-01 | draft | relay, eBUS | R4 | нет (db) |
| IPCP Pro 360Q xi (LinkLicense) | 60-1916-01A | draft | relay, eBUS | R4 | нет (db) |
| IPCP Pro 550 xi | 60-1913-01A | draft | relay, eBUS | R4 | нет (db) |
| IPCP Pro 555Q xi | 60-1917-01A | draft | relay, eBUS | R4 | нет (db) |
| IN1808 IPCP Q SA with LinkLicense | 60-1615-92A | draft | «IR Pass-Through (DTP2 Out)» | линтер | нет (db) |
| IN1808 IPCP Q MA 70 with LinkLicense | 60-1615-93A | draft | то же | линтер | нет (db) |
| IN1808 IPCP SA | 60-1615-02 | raw | то же | линтер | — (не каталог) |
| IN1808 IPCP SA LL | 60-1615-02A | raw | то же | линтер | — |
| IN1808 IPCP MA 70 | 60-1615-03 | raw | то же | линтер | — |
| IN1808 IPCP MA 70 LL | 60-1615-03A | raw | то же | линтер | — |
| SF 10C SUB | 60-1610-01 | draft | нет питания | R5 passive | нет (db) |
| SF 8CT SUB | 60-1941-03 | draft | нет питания | R5 passive | нет (db) |
| IPA T RLY4 | 60-545-03 | draft | нет питания | R5 powered by host | нет (db) |
| OCS 100C | 60-1664-01 | draft | нет напряжения | R5 bus-powered (eBUS), стенсил | нет (db) |
| OCS 100W | 60-1665-01 | draft | нет напряжения | то же | нет (db) |
| DTP3 T 202 EU/MK | 60-1829-52 | draft | плата Flex55 без шасси | слоты F55 | **да** (stencil) |
| MLC 62 RS EU (Black / White) | 60-1005-32 / -35 | draft | то же | слоты F55 | **да** (stencil) |
| One HDMI F-F on Pigtail (Black / White) | 70-1178-02 / -03 | draft | то же | слоты F55 | **да** (datasheet) |
| One USB 2.0 A F-F on Pigtail (Black / White) | 70-1180-02 / -03 | draft | то же | слоты F55 | **да** (datasheet) |
| One USB 3.2 A F to B F on Pigtail (Black / White) | 70-1240-02 / -03 | draft | то же | слоты F55 | **да** (datasheet) |
| One USB-C F to HDMI F on Pigtail (Black / White) | 70-1243-12 / -13 | draft | то же | слоты F55 | **да** (datasheet) |

Итого `approve:catalog -- --dry-run`: утвердит Extron 494 (было 483), на ревью уровень B — Extron 12 (было 25). Карточки
Cable Cubby F55 (A, без портов, источник портов не записан) — в «no source». Их утверждает библиотекарь в рабочем окне.

## Осталось на B (20) и почему

**Нет данных в карточке** (W «no weightKg» / «no powerDrawW/voltage»). Заполняются по даташиту, правилом не решаются:

| Шаблон | Артикул | Не хватает |
|---|---|---|
| DTP3 R 331, DTP3 T 331 | 60-2092-53 / -52 | вес |
| UCS 601 | 60-2042-01 | вес |
| FOX3 R 111 MM / SM | 60-1957-41 / -42 | вес, мощность / напряжение |
| FOX3 SR 302 MM / SM | 60-1959-21 / -22 | вес, мощность / напряжение |
| FOX3 T 302 SM | 60-1959-12 | вес, мощность / напряжение |
| PPC 25 | 60-887-01 | мощность / напряжение |
| SW2 HD 8K | 60-1985-01 | мощность / напряжение |
| WFA 100 EU / US | 60-1944-02 / -01 | мощность / напряжение |
| XTP SFR HD 4K MM / SM | 60-1278-31 / -32 | мощность / напряжение |

**Порт требует решения по панели или даташиту:**

| Шаблон | Артикул | Статус | Замечание | Что решить |
|---|---|---|---|---|
| UCS 303, UCS SW 313 | 60-1797-01 / -02 | draft | «USB-C In (DP Alt, 60W PD)»: нет секции | USB-C с видео: Video Inputs или USB — по даташиту (4.1) |
| UCS SR 501 | 60-1798-13 | draft | «IR/Serial»: ir bidirectional | общий разъём IR и RS-232: разделить на два порта с `exclusiveGroup` или указать направление IR |
| IN1804 DI, IN1804 DI/DO | 60-1699-12 / -14 | raw | «IR Thru (In)»: ir bidirectional | вход или выход — по панели (подпись говорит и Thru, и In) |
| MLC 226 IP | 60-600-02 | raw | «PWR SNS»: капс | подпись с шелкографии — «Power Sense»? Реле этого шаблона исправил R4 |

## Команды на сервере (после мержа и выхода образа)

```bash
cd /srv/easyschematic/deploy/avail
./backup.sh
./update.sh                                                    # новый образ api и app
docker compose exec api npm run import:catalog -- --dry-run    # 14 карточек Extron изменились, F55 загрузятся
docker compose exec api npm run import:catalog
docker compose exec api npm run normalize:library -- --dry-run # R4 для raw/draft базы и verified с портами сообщества
docker compose exec api npm run normalize:library
docker compose exec api npm run approve:catalog -- --dry-run   # ожидается +11 Extron (DTP3 T 202 EU/MK, MLC 62 RS EU, One … on Pigtail)
docker compose exec api npm run approve:catalog
```

После этого в рабочем окне (`/library`) библиотекарь:

- утверждает Cable Cubby F55 ×2;
- просматривает A-шаблоны с портами сообщества из таблицы выше (IPCP Pro xi, IN1808 IPCP Q LinkLicense, SF SUB,
  IPA T RLY4, OCS 100), сохранённый фильтр Review queue;
- для OCS 100C/W сверяет порты с даташитом.
