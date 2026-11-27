# Wyrestorm: импорт формы сбора (2026-11-27)

Файл: `avail-intake-wyrestorm-20261127-reviewed-v2.xlsx` (в репозиторий не кладётся). Цены формы (MSRP) в каталог не попадают: репозиторий публичный.

## Итог

- Строк Keep: 174 → карточки `library/catalog/wyrestorm/` (174), Exclude: 17 (не загружаются).
- Комплекты: 29 в `docs/avail/kits.json` — 4 с листа Kits, 25 пар TX/RX; у компонентов `_avail.kit.kitPartNumbers`, артикул комплекта убран из Alt part number.
- Источник портов: страница продукта wyrestorm.com — 150 карточек (`portsSource.kind = datasheet`, раздел Technical Specifications; PDF спецификаций — только в партнёрской папке SharePoint, недоступны), снимок базы (порты сообщества) — 5, без портов — 19.
- Уровни линтера (после соглашения о разъёмах): A 19, B 105, FIX 50. В базу `import:catalog` грузит A и B (124: 80 новых, 44 обновят шаблоны базы); FIX остаются в каталоге до данных.

## Соглашение Wyrestorm о разъёмах (решения 2026-11-27)

Только где страница разъём не называет; notes порта — «Wyrestorm convention: … — verify». Код — `src/avail/wyrestormPower.ts`, применяет `fill:catalog-ports`. Источник — spec sheets Wyrestorm: EX-100-H2, RXV-35-4K, NHD-400, NHD-500-IW-TX, NHD-500 / 600, EX-35-H2, MX KIT full range.

**Питание**
- настольные / полочные коробки с DC — `barrel` (locking DC, threaded bushing), напряжение — блока питания (поле voltage карточки со страницы);
- настенные (`-IW`, `-UK`, `-US`; in-wall / wall plate / gang) — `phoenix`, 2-pin;
- стоечные с сетевым входом и всё, к чему в комплекте AC power cord (матрицы MX / MXV, в т.ч. матрицы комплектов, IDB-300 / IDB-400 с сетевым входом) — `iec`;
- камеры, видео- и аудиобары с внешним адаптером (CAM-210 / 420, HALO-VX10, APO-210-UC) — `barrel` без фиксации;
- питание только по PoE (SYN-KEY10, SYN-TOUCH10) — без отдельного порта питания, «PoE» в notes LAN;
- коробки и настенные с PoH / PoC без своего порта питания — порт локального блока (альтернатива питанию по линии).

**Сигналы**
- RS-232 — `phoenix` 3-pin; симметричное аналоговое аудио — `phoenix` 5-pin; несимметричное стерео — 3.5 мм (`trs-eighth`);
- IR — 3.5 мм: TS у излучателя (IR Out), TRS у приёмника (IR In);
- что notes порта уже называют со страницы (3.5mm, 8-pin Mini DIN, N-pin) — берётся как названо; аудио без указания, симметричное ли оно, — без разъёма.

Питание без разъёма осталось у:
- AMP-2120-DNT: AC Power In

## Почему FIX (50)

- Без портов: 19 (ниже).
- С портами, но у порта нет разъёма (страница не называет, соглашение не покрывает): 31. Чаще всего:
  - USB Host: 5
  - Mic In 1: 3
  - Mic In 2: 3
  - Audio Out: 3
  - Mains Outlet: 3
  - Trigger In: 2
  - Line In: 2
  - Audio In: 2
  - USB Device 1: 2
  - USB Device 2: 2
  - USB Device 3: 2
  - USB Device 4: 2

## Без портов и почему

- EX-100-KVM-8K-RX: per-unit connectors are not listed: the page only says 'HDMI IN/OUT', 'AUDIO OUT' (PCM 2.0) and 'USB 2.0: 255Mbps' without unit, count or connector; link connector and signal type not published (page does not say HDBaseT); power input (DC 12V 3A) is not assigned to a unit; dimensions are garbled on the page
- EX-100-KVM-8K-TX: per-unit connectors are not listed: the page only says 'HDMI IN/OUT', 'AUDIO OUT' (PCM 2.0) and 'USB 2.0: 255Mbps' without unit, count or connector; link connector and signal type not published (page does not say HDBaseT); power input (DC 12V 3A) is not assigned to a unit; dimensions are garbled on the page
- EXP-SW-0201-8K: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- EXP-SW-0401-8K: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- HALO-COM-MIC: no technical specifications on the product page
- IDB-300: no technical specifications on the product page
- IDB-400-EU-C: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- IDB-HDMI-C: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- IDB-K2-C: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- IDB-RJ45-C: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- IDB-USBA-C: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- IDB-USBC-C: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- NHD-SW48-410 v2: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- SP-0104-H2: no technical specifications on the product page
- SW-620L-TX-W: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- SYN-CTL-HUB-IO-10: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- SYN-CTL-HUB-IR-06: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- SYN-CTL-HUB-RL-04: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке
- SYN-CTL-HUB-RS-03: нет страницы продукта на wyrestorm.com (ревьюер проверил sitemap); документация — только в партнёрской папке

## Расхождения на страницах

Страница несёт два блока спецификаций, которые расходятся; спорные порты не записаны, причина — в `_avail.portsMissing`:

- CAM-210-PTZ: two spec blocks disagree: block 1 lists 1x USB 3.0 Type C female, 1x RJ-45 10/100, 1x HDMI female Type A out and power 12V DC 2A | PoE 802.3af; block 2 lists 1x USB 3.0 Type B female, 1x RJ45 8-pin LAN, no HDMI out and power 12V DC 1A. The page does not say which block is for this part;
- IDB-200-MS: two spec blocks disagree: block 1 lists 1 x HDMI and no RJ-45; block 2 lists 2 x HDMI and 1 x RJ-45; the page does not say which block is for IDB-200-MS. HDMI and RJ-45 left out; mains listed as North American Type B in both blocks, not for MS
- CAM-210-NDI-PTZ: The page has two spec blocks; the second (no NDI, USB 3.0 Type B, no HDMI out, 12V DC 1A, no PoE) differs. Ports taken from the first block because it matches the NDI model (page mentions NDI); the second block is probably the non-NDI CAM-210-PTZ.
- EX-70-H2-TX: The page has two spec blocks: the second (HDMI Loop out, Ethernet RJ-45, 35m reach) differs from the first (70m reach, no loop, no Ethernet). Ports taken from the first block because its 70m/230ft reach matches this model's description.
- EX-70-H2-RX: The page has two spec blocks: the second (HDMI Loop out, Ethernet RJ-45, 35m reach) differs from the first (70m reach, no loop, no Ethernet). Ports taken from the first block because its 70m/230ft reach matches this model's description.
- RXV-70-G2-SCL: Power Supply differs between the two spec blocks: '12V 1A DC (Optional)' vs '18V DC (Optional)'; voltage left null.
- RX-700: Power voltage: Power Supply says '18V DC 3A' but the feature list says '12v DC PSU with US, UK, EU & AU Power cables included'; voltage left null.
- SW-660-TX-W: The page has two specification blocks that disagree and does not say which belongs to SW-660-TX-W: LAN 2x RJ-45 vs 3x RJ-45; USB-C power 'Dynamic 100W PD' vs '60W PD'; 'Max Power Consumption 160W' only in the second block; source count 6 vs 4 in the feature lists
- SYN-TOUCH10 v3: Two specification blocks disagree: PoE+ 802.3at listed as present vs 'PoE function optional'; Micro USB 'Reserved' vs 'Micro USB OTG'; Headphone jack 'Reserved' vs '3.5mm Earphone + Microphone'; USB 2.0 Type-A vs USB host + USB for Serial; page does not say which block is v3
- NHD-120-RX: Two specification blocks differ in LAN speed: 10/100/1000Base-T vs 10/100Base-T; port set is the same
- NHD-500-IW-TX v2: Two specification blocks disagree: second lists '1x USB 2.0 Type-B Host' in addition to USB-C Host; latency text also differs; page does not say which block is v2
- NHD-600-E-TX: Power supply: specifications say '12V 2A DC PSU' but In the Box says '1x 12V 1A DC PSU'
- NHD-600-E-RX: Power supply: specifications say '12V 2A DC PSU' but In the Box says '1x 12V 1A DC PSU'
- EX-100-KVM-TX: Third specification block lists 'DC 20V 3A with locking connector' and 'Max. Power Consumption 39.79W', while the first two blocks list 'DC 12V/3A' and 19W; page does not say which is right, so voltage and power draw are left out
- EX-100-KVM-RX: Third specification block lists 'DC 20V 3A with locking connector' and 'Max. Power Consumption 39.79W', while the first two blocks list 'DC 12V/3A' and 19W; page does not say which is right, so voltage and power draw are left out
- SW-640L-TX-W: Two specification blocks differ in USB version: 3x USB 3.0 Type A / 2x USB 3.0 Type B vs 3x USB 2.0 Type A / 2x USB 2.0 Type B; counts are the same; page does not say which is right
- MX-0404-HDMI: Two specification blocks disagree on Power Supply: 12V DC 2A vs 5V DC 2A
- MX-0812-SCL: Two specification blocks disagree: only the first lists USB 3.0 Type A device and Type B host ports (and the built-in USB hub feature)
- MX-0404-KIT-MATRIX: Spec blocks differ slightly: only the second lists 'Analog: 2ch Analog' audio; ports otherwise identical
- SYN-CTL-FL10: Power: 'Power: 12V DC; PoE' in the general block vs 'POWER Power 5V 0.2A' in the POWER block; power port and voltage left out
- NHD-120-IW-TX: Analog audio: first block says output '1x 5-pin Phoenix Analog Audio' (Outputs), second block says input '1x 3-pin Phoenix Analog Audio' (Inputs); port left out
- NHD-400-E-RX: Two spec blocks: first (decoder: Inputs 1x RJ-45, Outputs 1x HDMI Out) used for this RX; second block lists the reverse (Inputs 1x HDMI, Outputs 1x RJ-45) and calls the unit an encoder
- NHD-510-TX: RS-232: 4-pin vs 3-pin Phoenix between the two blocks; pin count left out | USB host: 'USB 2.0 Type-B Host' vs 'USB 3.0 Type Host'; version left out | PoE class: 802.3at PoE+ vs 802.3af; class left out | SFP: 1000Base-LX/LX10 distances only in the first block
- NHD-CTL-PRO v2: Power: '12v DC | PoE Compliant' vs 'AC 100 ~ 240V | 802.3af PoE Compliant' | Dimensions: 215mm x 120mm x 25mm vs 440mm x 43.5mm x 240mm | power consumption 'Max 15.4 | Average: 8w' unit missing in both blocks
- COM-MIC-HUB: AEC Ref is listed under Audio Input Port but its text says 'Left and Right channels output'; treated as input | Trigger OUT text says 'voltage input with 5V'
- EX3-100-EARC-TX: Two spec blocks: first gives 12V DC 2A and 190mm x 115mm x 23mm; second has placeholders '12V DC ?A', 'Max. Power Consumption ???', 'Weight ????', '190*D*25 mm'; dimensions, power draw and current left out
- EX3-100-EARC-RX: Two spec blocks: first gives 12V DC 2A and 190mm x 115mm x 23mm; second has placeholders '12V DC ?A', 'Max. Power Consumption ???', 'Weight ????', '190*D*25 mm'; dimensions, power draw and current left out
- IDB-400-MS: First block (multi-standard mains): 1 x USB-A, 2 x USB-C; second block (North American Type B): 1 x USB-C, 2 x USB Type A charging ports; USB ports left out
- MX-1007-HYB: Second block lists the RS-232 line twice and an extra HDBaseT 3.0/PoE+ feature line; ports identical
- RXV-35-SCL: Power Supply: '12V 1A DC (Optional)' in the first block vs '18V DC (Optional)' in the second; optional DC input left out
- SW-515-RX: IR: '1x IR TX: 3.5mm (1/8in) TS Mono' in the first block vs '1x IR RX: 3.5mm (1/8in) TS Mono' in the second; IR port left out
- NHD-124-TX: The page has two spec blocks: LAN '10/100/1000Base-T' with Power Supply '12V DC 3A' vs LAN '10/100Base-T | PoE 802.1af' with Power Supply '12V DC 3A | 802.3af PoE Compliant'; the page does not say which applies, so LAN speed and PoE are not stated on the port
- NHD-500-TX v2: Two spec blocks disagree and the page does not say which is v2: TX audio input '5-pin Balanced Audio' vs '3.5mm TRS Audio'; TX USB '1 x USB 2.0 Type B' vs '1 x USB 2.0 Type Host'; SFP '1000Base-SX/LX/LX10' vs '1000BaseT-SX'; PoE '802.3at PoE+' vs '802.3af'. Disputed items left out of 
- NHD-500-RX v2: Two spec blocks disagree and the page does not say which is v2: TX audio input '5-pin Balanced Audio' vs '3.5mm TRS Audio'; TX USB '1 x USB 2.0 Type B' vs '1 x USB 2.0 Type Host'; SFP '1000Base-SX/LX/LX10' vs '1000BaseT-SX'; PoE '802.3at PoE+' vs '802.3af'. Disputed items left out of 
- NHD-USB-TRX: The page has a second spec block that belongs to a different product (HDMI/analog audio output, RS-232, IR, NHD-120-TX routing; LAN '10/100Base-T | PoE 802.1af'); it was ignored, only the USB block is used
- IDB-400-MS-C: The page has two spec blocks: this MS model (British/European/Indian outlet, USB-A, USB-C, 4 customer connectors) and a North American Type B version (2x HDMI, RJ-45, 2x USB-A charging); only the MS block is used, as the 'In the Box' names IDB-400-MS-C
- EXP-SP-0102-H2: The two spec blocks disagree in the feature text only (splits to 'up to two' vs 'up to four' HDMI displays); the Inputs/Outputs lists agree (1 in, 2 out), so ports use them

## Шаблоны Wyrestorm в базе (снимок 2026-11-25, 55, все raw от сообщества)

- Совпали по производителю + артикулу: 49. `import:catalog` обновит 45 (карточка A/B; raw → draft): APO-SKY-MIC, CAM-0402-BRG, CAM-0402-NDI-BRG, COM-MIC-HUB, CON-ANLG-DNT, CON-DNT-ANLG, CON-DNT-XLR, CON-USBC-DNT, CON-XLR-DNT, EX-35-8K-RX, EX-35-8K-TX, EXA-100-EARC-RX, EXP-CON-AUD-H2, EXP-MX-0402-H2, MX-0403-H3-MST, MX-1007-HYB, MXV-0808-H2A v3, MXV-0808-H2A-70 v3, NHD-120-IW-TX, NHD-120-TX, NHD-124-TX, NHD-128-NDI-TRX, NHD-150-RX, NHD-500-E-RX, NHD-500-E-TX, NHD-510-TX, NHD-600-E-RX, NHD-600-E-TX, NHD-600-TRX, NHD-600-TRXF, NHD-CTL-PRO-V2, NHD-USB-TRX, RX-35-POH, RX-70-4K, RX3-100, RXV-35-4K, RXV-35-SCL, RXV-70-4K-G2, RXV-70-G2-SCL, SW-0204-VW, SW-130-TX-UK, SW-515-RX, SW-620-TX-W, SW-640L-TX-W, TS-280-EU.
- Совпали, но карточка FIX — в базе остаётся версия сообщества, пока карточка не дойдёт до B: 4 (AMP-2120-DNT, EXA-100-EARC-TX, IDB-300-BTN, NHD-500-TX v2).
- Без настоящего артикула / артикул не совпал — кандидаты в дубли (6), решить в рабочем окне (Possible duplicates / Merge into… / Not duplicates):
  - «Wyrestorm EX-70-G2 RX» (modelNumber `EX-70-G2 (Receiver)`) ↔ карточки: EX-70-G2-RX, EX-70-G2-TX
  - «Wyrestorm EX-70-G2 TX» (modelNumber `EX-70-G2 (Transmitter)`) ↔ карточки: EX-70-G2-RX, EX-70-G2-TX
  - «Wyrestorm MX-0402-MST Conference Room Switcher» (modelNumber `MX-0402-MST`) ↔ карточки: MX-0402-MST v2 — `import:catalog` скроет его сам (raw, та же модель: «superseded by catalog»)
  - «Wyrestorm MX-0404-KIT» (modelNumber `MX-0404-KIT`) ↔ карточки: MX-0404-KIT-MATRIX
  - «Wyrestorm NHD-120-RX-S Sealoc Decoder» (modelNumber `NHD-120-RX-S`) ↔ карточки: NHD-120-RX
  - «Wyrestorm SYN-TOUCH10 v2 All-In-One Touchpad Controller» (modelNumber `SYN-TOUCH10 v2`) ↔ карточки: SYN-TOUCH10 v3

## Команды на сервере (после вливания PR)

```bash
cd /srv/easyschematic/deploy/avail
./backup.sh
docker compose exec api npm run import:catalog -- --dry-run
docker compose exec api npm run import:catalog
docker compose exec api npm run approve:catalog -- --dry-run
docker compose exec api npm run approve:catalog
docker compose exec api npm run report:duplicates -- --out /data/duplicates.md
```

`approve:catalog` утвердит карточки уровня A с портами со страницы производителя (`datasheet`); B и FIX — в очереди ревью.
