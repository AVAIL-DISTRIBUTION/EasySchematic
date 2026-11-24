# AVAIL Device Block Standard / Стандарт блока устройства AVAIL

Nov 20, 2026 · @Dmitri Martakov · v0.6 draft (Nov 28, 2026: Audio I/O, Telephony, пометки питания, PoE по классу; Nov 27: Sync, слоты и платы, разъём из сигнала) · ранее v0.4 draft (Nov 23, 2026: таксономия, вендоры, Generic; Nov 25, 2026: два уровня вендоров, решения о вендорах, питание по шине)

## 1. Назначение

Каждый блок в библиотеке AVAIL собирается по этому стандарту, вручную или генератором, чтобы схемы, кабельные журналы и спецификации выглядели и считались одинаково. Стандарт выведен из 22 блоков, которые инженеры отобрали как лучшие; за образец взяты три самых полных: Extron DTP3 T 203, Extron DMP 128 Plus C AT и Extron IPCP Pro 255Q xi.

У блока два уровня качества:

| Уровень | Что значит | Где можно использовать |
| --- | --- | --- |
| A — проверен AVAIL | Выполнены все обязательные правила, порты сверены с даташитом | Рабочая библиотека, проекты для заказчика |
| B — черновик | Все порты, типы сигналов и разъёмы есть; физика или заметки неполные | Черновые схемы, с пометкой в проекте |

Обязательные правила помечены словом **обязательно**, остальное — рекомендации.

## 2. Карточка устройства

Название блока — это коммерческое имя с производителем, артикул живёт отдельно и в шапку не выносится.

| Поле | Правило | Пример |  |
| --- | --- | --- | --- |
| label | Производитель + модель, как на сайте производителя | Extron DTP3 T 203 | обязательно |
| model | То же, что label | Extron DTP3 T 203 | обязательно |
| modelNumber | Артикул производителя (part number). Если отдельного артикула нет — код модели | 60-1885-52; VC-TR61 | обязательно |
| shortName | Модель без производителя, не артикул | DTP3 T 203 | обязательно |
| manufacturer | Каноническое имя из справочника вендоров [avail-vendors.json](avail-vendors.json); синонимы приводятся к нему (Biamp Systems → Biamp, NETGEAR → Netgear-AV). Если написание в учётной системе отличается от написания производителя, основным считается написание учётной системы. Производитель вне портфеля AVAIL — Generic | Extron, Biamp, Netgear-AV | обязательно |
| deviceType | Из словаря EasySchematic; один тип на класс продукта | hdbaset-extender, audio-dsp, touch-screen | обязательно |
| category | Путь листовой категории из таксономии [avail-taxonomy.json](avail-taxonomy.json). Для блоков на схеме — только категории с schematic=true | AV distribution / Extenders | обязательно |
| auxiliaryData | Одна строка в шапке: {{deviceType}} | header: {{deviceType}} | обязательно |
| color | Не задаётся: цвет шапки будет идти от категории | — |  |

На схеме экземпляр блока переименовывается по роли в проекте (DSP 1, TX TABLE), карточка шаблона при этом не меняется.

### 2.1 Справочники

Категории и вендоры берутся только из справочников в репозитории; справочник меняется PR-ом, блоки под него — следом.

- **Таксономия** — [avail-taxonomy.json](avail-taxonomy.json). Это категории учётной системы AVAIL (Odoo) плюс наша Other / Generic. В category записывается полный путь листовой категории (leaf=true): «Audio Products / DSP», а не «DSP» и не «Audio Products». Категории с schematic=false (кабели, крепёж, лицензии, ПО, аксессуары) — позиции только для BoQ/BoM, блоком на схеме они не бывают. deviceTypeDefaults задаёт категорию по умолчанию для типа устройства; null — категорию выбирает инженер.
- **Вендоры** — [avail-vendors.json](avail-vendors.json). manufacturer пишется ровно как name; aliases — написания, которые встречаются в источниках и приводятся к name. Если написание в учётной системе отличается от написания производителя, основным считается написание учётной системы: Wyrestorm (у производителя — WyreStorm), Netgear-AV (NETGEAR), TV One (tvONE); написание производителя остаётся в aliases. scope уточняет, какая линейка вендора у нас в портфеле. Два уровня: `portfolio: true` — портфель AVAIL, `portfolio: false` — поддерживаемые вендоры вне портфеля; линтер принимает оба.
- **Решения о вендорах** — [vendor-decisions.json](vendor-decisions.json): кого библиотека держит (keep), как пишется (rename), в каких границах (scope: Sony — только системные камеры, Netgear-AV — только AV Line), какие бренды сводятся в Generic (generic: «Generic <тип>» создаётся только для deviceType, у которых Generic ещё нет; существующий Generic не перезаписывается) и что удаляется (всё остальное и шаблоны без производителя). Вендоры портфеля из avail-vendors.json сохраняются всегда, даже если их нет в keep. Применяет `npm run apply:vendor-decisions`, import:upstream соблюдает те же правила.

### 2.2 Generic

Generic — вендор для всего, что нужно в проекте, но не входит в портфель AVAIL: ноутбук, Room PC, мышь, сторонний источник.

| Поле | Правило | Пример |
| --- | --- | --- |
| manufacturer | Generic | Generic |
| label, model | «Generic <класс>»: класс устройства, без бренда и модели | Generic Room PC |
| modelNumber | «GEN-<КЛАСС>»: класс заглавными, слова через дефис | GEN-ROOM-PC |
| shortName | Класс без «Generic» | Room PC |
| category | Обычно Other / Generic, если в таксономии нет подходящей категории | Other / Generic |

Физика (габариты, вес, питание) и referenceUrl у Generic для уровня A не обязательны: конкретного изделия нет. Порты, секции, типы сигналов и разъёмы — по общим правилам.

## 3. Физика, питание, источники

Все числа берутся с официальной страницы или даташита производителя: на них строятся стойки, расчёт питания и BoQ.

| Поле | Правило | Пример | Уровень A |
| --- | --- | --- | --- |
| heightMm, widthMm, depthMm | Габариты корпуса в мм, без ушей и ручек | 44 × 222 × 216 | обязательно |
| weightKg | Вес нетто, кг | 0.98 | обязательно |
| powerDrawW | Максимальное потребление, Вт. Для PoE-устройств не заполняется | 90.3 | обязательно, кроме PoE |
| voltage | Входное питание: 100-240V, 12V DC, 48V DC | 100-240V | обязательно, кроме PoE |
| poeDrawW | Потребление по PoE, Вт (устройство-потребитель) | 25.5 | обязательно для PoE |
| poeBudgetW | Бюджет PoE, Вт (коммутатор, DSP с PoE-портами) | 120 | обязательно для PSE |
| thermalBtuh | Тепловыделение, BTU/ч, если указано производителем | 308 |  |
| referenceUrl | Страница продукта у производителя, не у реселлера | extron.com/product/dtp3t203 | обязательно |
| searchTerms | Строчными: артикул, серия, аббревиатуры, синонимы | 60-1885-52, dtp3, hdbaset | обязательно |

Если производитель число не публикует, поле остаётся пустым, а блок не может получить уровень A, пока число не уточнено.

Исключение — Generic (п. 2.2): физика и referenceUrl для уровня A не обязательны.

### 3.1 Питание по шине

Устройство, которое питается не от своего блока питания, отдельного порта питания не имеет. Это записывается в notes порта, через который оно питается, и тогда линтер не требует порт питания:

| Питание | Пометка в notes | Что требуется |
| --- | --- | --- |
| USB | bus-powered (USB) | powerDrawW (напряжение шины задано стандартом USB) |
| PoE | PoE (например, «PoE+ 802.3at class 4») | poeDrawW |
| Шина управления | bus-powered (eBUS), bus-powered (ACP), bus-powered (DCP), bus-powered (VCH) | — (бюджет шины считается на хосте) |
| Фантомное | phantom (например, «phantom +48 V») | — |
| Батарея | battery | — |
| Пассивное устройство | passive | — |

«no PoE» в notes и источники PoE (с poeBudgetW) под это правило не попадают; PoE отмечается на входном порту, фантомное питание — на выходе микрофона. Платы питаются от шасси (5.1).

**PoE без опубликованной мощности.** Если производитель называет только класс PoE, poeDrawW = максимум класса, а в notes порта — «PoE: actual draw not published»:

| Класс | poeDrawW, Вт |
| --- | --- |
| 1 | 3.84 |
| 2 | 6.49 |
| 3 и 802.3af без класса | 12.95 |
| 4 / 802.3at | 25.5 |

Если данных нет совсем (у производителя не опубликованы), поле остаётся пустым — не выдумывать; такие шаблоны идут в запрос производителю (`npm run export:vendor-requests`).

| Порт | notes | Что требуется |
| --- | --- | --- |
| USB-C камеры | USB 3.0 video/data; bus-powered (USB), < 10 W | powerDrawW |
| LAN микрофона | PoE+ 802.3at class 4 | poeDrawW |

## 4. Порты

Каждый физический разъём на корпусе — один порт, сгруппированный в секцию по назначению, а не по стороне корпуса. Порядок секций повторяет поток сигнала: входы, выходы, сеть, управление, питание.

### 4.1 Секции и их порядок (обязательно)

| № | Секция | Что сюда входит |
| --- | --- | --- |
| 1 | Video Inputs | HDMI, DP, USB-C с видео, SDI, HDBaseT-входы |
| 2 | Video Outputs | HDMI, HDBaseT/DTP/XTP-выходы, loop |
| 3 | Audio Inputs | Микрофонные и линейные входы |
| 4 | Audio Outputs | Линейные и цифровые выходы (S/PDIF) |
| 5 | Audio I/O | Аналоговые аудиопорты, настраиваемые на вход или выход (notes: «configurable») |
| 6 | Speaker Outputs | Выходы на акустику |
| 7 | RF | Антенные входы и выходы, Bluetooth |
| 8 | Network | LAN, SFP, порты AVoIP |
| 9 | Telephony | Телефонные линии (POTS) |
| 10 | Dante | Разъёмы Dante / AES67 |
| 11 | AVB | Разъёмы AVB / Milan |
| 12 | Serial | RS-232, RS-422/485, RS-232 pass-through |
| 13 | IR | IR-выходы и входы |
| 14 | Relays | Релейные выходы |
| 15 | Digital I/O | GPIO, logic I/O |
| 16 | Control | Contact closure, tally, volume, DMX, MIDI, датчики и прочее управление |
| 17 | Sync | Опорные сигналы и время: genlock (reference), word clock, timecode |
| 18 | Expansion | eBUS, EXP, ACP и другие фирменные шины (A&H DX/SLink/gigaACE, Yamaha YDIF…) |
| 19 | USB | USB-хост, USB-аудио, USB-камера |
| 20 | Configuration | Сервисные порты: USB config, setup, console, OOB |
| 21 | Power | Питание, включая power loop |

Словарь сознательно дробный: так делят порты лучшие блоки инженеров (IPCP Pro 255Q xi, DMP 128 Plus), и так схему быстрее читать. Уточнение в скобках допустимо: «Audio Inputs (Phantom)», «Serial (TP Tx 1)». Секции «Back of unit», «Front of unit», «Slot N» для обычных портов не используются; пустые секции не создаются.

### 4.2 Подписи портов (обязательно)

- Смысл — как шелкография на панели, форма — единая: слова с заглавной, аббревиатуры прописными (HDMI, LAN, USB, RS-232, DTP3), номер в конце: HDMI In 1, Line Out 3, Digital I/O 2.
- Направление словами In / Out, а не стрелками и не символами.
- Уточнения — в скобках в конце: (Front), (Loop), (PoE+), (Primary), (Secondary).
- Не длиннее 28 символов; технические подробности — в notes.
- Не капсом целиком: «BALANCED AUDIO OUT 1» → «Audio Out 1 (Balanced)». Подписи из одних аббревиатур и номеров так и пишутся на панели и капсом не считаются: «IPCP LAN», «USB HID», «AV LAN», «COM 1», «RS-232/IR».

### 4.3 Направление

| Сигнал | direction |
| --- | --- |
| Видео, аналоговое аудио, акустика, IR, tally, реле | input или output, по факту |
| LAN, Dante, AVB, USB-данные, RS-232/422/485, Digital I/O, шины | bidirectional |
| Питание | input; output — у PDU и блоков питания и у выходов 12 V / 24 V / 48 V, Tally, Lamp |

Для видео (HDMI, DP, SDI, DVI, VGA, HDBaseT), аналогового аудио, акустики и IR `bidirectional` — ошибка данных (линтер: W). Нормализатор выводит направление из подписи: In / Input / Mic / Line In / Rx → input; Out / Output / Loop / Thru / Monitor / Tx → output. Если подпись не говорит ни того, ни другого (или говорит оба), направление не угадывается — «сверить с панелью». Исключения: HDMI с eARC/ARC — input, возврат звука в notes; двухпроводный интерком (partyline), разъём TRRS / headset, проброс по линии (pass-thru) и порты «In/Out», «I/O» действительно двунаправленные.

### 4.4 Типы сигналов (обязательно)

| Порт на панели | signalType |
| --- | --- |
| HDBaseT, Extron DTP/DTP3/XTP | hdbaset |
| Dante / AES67 | dante |
| AVB / Milan | avb |
| LAN управления, AVoIP-порт | ethernet |
| RS-232 | serial |
| RS-422 / RS-485 | rs422 (только если порт действительно 422/485) |
| Реле, вход contact closure | contact-closure |
| Digital I/O, GPIO, logic I/O | gpio |
| IR | ir |
| eBUS, ACP | ebus |
| Extron EXP | extron-exp |
| USB-C с DP Alt Mode | usb, режим — в notes |
| Thunderbolt | thunderbolt |

### 4.5 Разъёмы (обязательно)

connectorType заполняется у каждого порта, без исключений. Клеммник Phoenix (captive screw) — phoenix, винтовая колодка акустики — terminal-block, сетевой IEC — iec, DC-штекер — barrel, SFP-клетка — sfp.

Где разъём однозначно следует из сигнала, его ставит нормализатор: HDMI → hdmi, SDI → bnc, Ethernet / Dante / AVB / HDBaseT / SLink → rj45, DisplayPort → displayport, DVI → dvi, VGA → vga, genlock / word clock → bnc. У сигналов с несколькими обычными разъёмами (аналоговое аудио, USB, GPIO, питание, IR, RF, AES, RS-232) разъём выбирает человек.

### 4.6 Заметки

notes заполняется там, где разъём или режим неочевиден: число полюсов и шаг клеммника (3-pole 3.5 mm), фантомное питание, класс PoE, режимы USB-C, Dante primary/secondary.

## 5. Особые случаи

Здесь правила, на которых блоки чаще всего расходятся.

- **Dante и AVB.** Порт — это разъём RJ-45, а не аудиоканал. Каналы (AEC Ref In, Automix Out) в порты не превращаются, их число и назначение пишутся в notes порта. Два Dante-разъёма — «Dante (Primary)» и «Dante (Secondary)».
- **HDBaseT, DTP, XTP.** Тип hdbaset, разъём rj45, в подписи семейство и направление: «DTP3 Out», «XTP In 2». Что передаётся по линии (видео, RS-232, IR, LAN, питание) — в notes.
- **PoE.** У потребителя отдельного порта питания нет: LAN подписывается «LAN (PoE+)», мощность — в poeDrawW устройства. У источника PoE (коммутатор, DSP) — poeBudgetW на устройстве и «(PoE+)» в подписи каждого питающего порта.
- **USB-C.** Если несёт видео (DP Alt Mode) — секция Video Inputs, тип usb, режим в notes. Если только данные или сервис — секция USB или Configuration.
- **Фреймы с картами** (XTP II CrossPoint, Quantum Ultra II). На шасси — только собственные разъёмы шасси (Network, Control, Configuration, Power). Карты — отдельные шаблоны, вставляются в слоты; порты карт живут в карточке карты. Подробнее — раздел 5.1.
- **HDBaseT / DTP / XTP с настраиваемым направлением** (DTP3 I/O, XTP I/O). `bidirectional` допустимо, в notes — «configurable input/output», секция — «Video Inputs (Configurable)».

### 5.1 Слоты и платы

- **Семейство называет тип слота, а не плату.** Формат — `<vendor>-<platform>-<slot-type>` строчными (`extron-xtp-2`, `yamaha-my`, `qsc-core-io`, `ah-dlive-io`). Отраслевые форм-факторы — стандартным именем (`sfp`, `qsfp`, `sd-card`, `ops`, `intel-sdm`).
- **Одно семейство — один физический формат.** Если платы двух линеек физически взаимозаменяемы по документации производителя, это одно семейство. Пример: dLive и Avantis — один I/O Port (`ah-dlive-io`), SQ и AHM — другой (`ah-sq-io`).
- **Справочник семейств** — [slot-families.json](slot-families.json): платформа, категория шасси и плат, прежние имена (aliases, нормализатор переименовывает), `alsoAccepts` — какие ещё семейства принимает слот.
- **Слот может принимать список семейств:** `slotFamily` (основное) и `slotFamilies` (дополнительные). Пример: слоты Quantum Ultra II принимают `extron-quantum-ultra-2` и `extron-quantum-ultra`, потому что Quantum Ultra II совместим со всеми платами Quantum Ultra. Выбор платы в редакторе и в MCP учитывает список.
- **Категория:** категория платы = категория шасси, в которое она вставляется (по семейству в справочнике).
- **Питание:** плата питается от шасси, порт питания и мощность для неё не требуются; габариты и вес тоже не требуются.
- **Линтер (W), когда знает библиотеку:**
  - слот, для которого в библиотеке нет ни одной платы;
  - плата, которую не принимает ни одно шасси.
- **Передняя панель.** Фронтальные порты включаются, только если используются при монтаже или настройке, и получают «(Front)» в подписи. Секция — по назначению, не «Front of unit».
- **Резервное питание.** Два блока питания — два порта: «AC Power 1», «AC Power 2».
- **Компьютеры и источники общего назначения** (NUC, ноутбук). Описываются только разъёмы, которые реально участвуют в AV-системе; дубли USB одного типа допустимо свести в один порт с количеством в notes.

## 6. Эталон: Extron DTP3 T 203 по стандарту

Блок инженеров взят почти без изменений: перераспределены три порта по секциям, у двух поправлены подписи и направление.

**Карточка:** label и model — Extron DTP3 T 203 · modelNumber — 60-1885-52 · shortName — DTP3 T 203 · deviceType — hdbaset-extender · category — KVM / Extenders · 44 × 222 × 216 мм, 0.98 кг · 90.3 Вт, 100-240V · [extron.com/product/dtp3t203](https://www.extron.com/product/dtp3t203)

| Секция | Подпись | direction | signalType | connectorType | notes |
| --- | --- | --- | --- | --- | --- |
| Video Inputs | HDMI In 1 | input | hdmi | hdmi |  |
| Video Inputs | HDMI In 2 | input | hdmi | hdmi |  |
| Video Inputs | USB-C In | input | usb | usb-c | DP Alt Mode, 4 HBR2 lanes |
| Video Outputs | HDMI Out (Loop) | output | hdmi | hdmi |  |
| Video Outputs | DTP3 Out | output | hdbaset | rj45 | На приёмник DTP3 |
| Network | LAN | bidirectional | ethernet | rj45 |  |
| Serial | RS-232 | bidirectional | serial | phoenix | 3-pole 3.5 mm |
| Control | Contact Closure | input | contact-closure | phoenix |  |
| Control | Tally Out | output | tally | phoenix |  |
| Configuration | USB Config (Front) | bidirectional | usb | usb-c |  |
| Power | AC Power | input | power | iec |  |

Что изменено относительно присланного блока: LAN перенесён из Control в Network; USB Config — из Control в Configuration и стал bidirectional; «RS-232 (3-pole)» → «RS-232», полюса ушли в notes; «HDMI Out (loop)» → «HDMI Out (Loop)»; «DTP3 Out (RJ-45 to Rx)» → «DTP3 Out», пояснение в notes; shortName — модель вместо артикула.

## 7. Аудит присланных блоков

Из 22 блоков 4 уже на уровне B, 18 требуют правок; уровня A пока нет ни у одного. Почти все правки механические: проставить секции из словаря, заменить shortName с артикула на модель, дописать поисковые термины. Содержательных ошибок мало, но они есть: RS-232, размеченный как rs422, реле как gpio, нет порта питания.

| Блок | Уровень | Обязательные правки (E) | Рекомендации (W) |
| --- | --- | --- | --- |
| Extron XTP II CrossPoint 1600 | B | — | shortName, color, подпись капсом |
| Extron DTP3 T 203 | B | — | shortName, color, длинная подпись USB-C |
| Extron DTP3 R 201 | B | — | shortName, color |
| Shure MXA925 | B | — | label без «Shure»; каналы Dante как порты; подписи капсом |
| Extron IPCP Pro 255Q xi | FIX | 4 секции вне словаря (VOL, LAN, eBUS) | реле → contact-closure, eBUS → ebus, COM bidirectional |
| Extron TLP Pro 1035T | FIX | нет порта питания (PoE: нужен poeDrawW) | shortName, color |
| Extron Quantum Ultra II 305 | FIX | секция Setup → Configuration | color |
| Extron DTP CrossPoint 108 4K | FIX | 12 секций вне словаря (Pass-Thru, Switcher Control, EXP Bus) | shortName, color, 2 длинные подписи |
| Extron DMP 128 Plus C AT | FIX | 26 секций вне словаря (Mic/Line, Line Outputs, Dante Network) | shortName, color, порядок секций |
| Extron SMP 352 | FIX | 9 секций вне словаря | shortName, color, 2 длинные подписи |
| Netgear M4250-26G4XF-PoE+ | FIX | 33 секции вне словаря (Lan, SFP, OOB, Console) | label без «NETGEAR», searchTerms |
| ASUS NUC 13 Pro | FIX | 11 портов в секциях Back/Front of unit | shortName, searchTerms |
| Sharp ME982 | FIX | нет секций у 13 портов; RS-232 как rs422 | label без «Sharp», габариты, питание, searchTerms |
| Lumens VC-TR61 | FIX | нет секций у 6 портов; RS-232 как rs422 ×2 | shortName, направление RS-232 |
| Biamp TesiraFORTÉ DAN AI | FIX | нет секций у 25 портов; нет порта питания | питание, searchTerms |
| Shure IntelliMix P300 | FIX | нет секций у 6 портов; нет порта питания | shortName, габариты, searchTerms, подписи капсом |
| Shure SLXD4QDAN+A | FIX | нет секций у 15 портов | shortName |
| Shure UA874 | FIX | 2 секции вне словаря → RF | shortName, color |
| Biamp Desono DX-S5-UB-W | FIX | нет секций у 2 портов | shortName, searchTerms, подписи капсом |
| Biamp Voltera D 2400.8 | FIX | 19 секций вне словаря; 2 порта без разъёма | shortName, searchTerms; в modelNumber опечатка «Voltera» |
| Absen Clear Cobalt CL0.7 | FIX | нет секций у 4 портов | shortName, питание, searchTerms, подписи капсом |
| WyreStorm NHD-500-TX v2 | FIX | 5 портов без разъёма; нет секций у 11 портов | label без «WyreStorm», габариты, питание, подписи капсом ×8 |

Наши четыре шаблона Biamp из пилота (Vidi 250, TCM-XA, AMP-450BP, FORTÉ X 400) стандарт тоже не проходят: в них нет секций. Их переделаю первыми вместе с этими 22.

## 8. Проверка: линтер и чек-лист ревью

Формальные правила проверяет линтер `src/avail/blockLint.ts`, человек проверяет только то, что машина проверить не может: совпадение с реальной панелью.

**Линтер.** Запуск: `npm run avail:lint -- <файл.json> --verbose`. В ошибках «no section» и «section … is not in the vocabulary» линтер подсказывает секцию, если нормализатор её знает (`; use "Video Outputs"`). Принимает и сохранённую схему, и архив устройств. С v0.3 он сверяет category с таксономией, manufacturer — со справочником вендоров и применяет правила Generic; первая версия на Python (`tools/avail/avail_block_lint.py`, v0.2) оставлена как архив. Категория вне таксономии, не лист или с schematic=false — ошибка (E): блок с ней не поднимется выше FIX.

**Статус в библиотеке.** Уровень A — условие для статуса verified: утвердить шаблон ниже уровня A нельзя. raw — непроверенное сырьё (импорт), draft — в работе у инженера, hidden — скрыт из библиотеки.

**Автонормализатор** (`src/avail/normalize.ts`, CLI `npm run normalize:library`) исправляет то, что решается механически: секции по словарю и их порядок, производителя, label и shortName, подписи из капса, направление LAN/Dante/AVB/RS-232/GPIO, категорию по типу устройства. Неоднозначное он не трогает, а помечает «требует ручной правки». Статус после нормализации не меняется — утверждает человек. Выдаёт уровень A / B / FIX по каждому блоку: ошибки (E) не пускают на уровень B, рекомендации (W) — на уровень A. В рабочей системе он встанет в CI библиотеки и в генератор шаблонов: блок с ошибками в библиотеку не попадёт.

**Чек-лист инженера при ревью** (то, что линтер не видит). Интерфейс показывает его на английском, дословно этим списком (`REVIEW_CHECKLIST` в `src/avail/libraryView.ts`, синхронность проверяет тест):

- [ ] Number and type of ports match the rear and front panels in the datasheet.
- [ ] Port labels match the panel silkscreen in meaning.
- [ ] Ports within a section are in panel order.
- [ ] Signal type matches the port's real protocol (RS-232 vs RS-485, Dante vs AVB, relay vs GPIO).
- [ ] Dimensions, weight and power are checked against the datasheet of the same revision.
- [ ] referenceUrl leads to the page of exactly this model.

По-русски: число и тип портов совпадают с панелями по даташиту; подписи по смыслу совпадают с шелкографией; порядок портов внутри секции — как на панели; тип сигнала соответствует реальному протоколу (RS-232 vs RS-485, Dante vs AVB, реле vs GPIO); габариты, вес, потребление сверены с даташитом той же ревизии; referenceUrl ведёт на страницу именно этой модели.

**Статус после сохранения.** Шаблон verified, у которого после сохранения (любым маршрутом) уровень ниже A, автоматически становится draft; причина и время пишутся в `avail_template_meta.status_reason` / `status_changed_at` и показываются в карточке ревью. verified ставит только человек.

**Курируемая библиотека.** `library/avail/*.json` — по файлу на шаблон, имя по производителю и модели латиницей (`extron-dtp3-t-203.json`); каждый файл обязан быть на уровне A (CI: `npm run avail:check-library`). Шаблоны, которым не хватает официальных данных, лежат в `library/avail-pending/`. `npm run import:avail` загружает `library/avail/` в базу со статусом draft; `library/hidden.json` — шаблоны, которые держим скрытыми (дубли).

**Открытые вопросы для утверждения:**

1. ~~Таксономия category: повторяет категории Odoo или своя для проектирования?~~ **Решено (v0.3):** таксономия = учётная система. category — путь листовой категории Odoo из [avail-taxonomy.json](avail-taxonomy.json); своя категория одна — Other / Generic для Generic-устройств без подходящей категории в учётной системе.
2. Цвет шапки по категории: вводим или оставляем единый?
3. Подписи портов: только английский или двуязычные для проектов в СНГ?
