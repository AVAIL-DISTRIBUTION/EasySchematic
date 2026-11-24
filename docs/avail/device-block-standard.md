# AVAIL Device Block Standard / Стандарт блока устройства AVAIL

Nov 20, 2026 · @Dmitri Martakov · v0.3 draft (Nov 23, 2026: таксономия, вендоры, Generic)

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
| manufacturer | Каноническое имя из справочника вендоров [avail-vendors.json](avail-vendors.json); синонимы приводятся к нему (Biamp Systems → Biamp, Netgear → NETGEAR). Производитель вне портфеля AVAIL — Generic | Extron, Biamp, NETGEAR | обязательно |
| deviceType | Из словаря EasySchematic; один тип на класс продукта | hdbaset-extender, audio-dsp, touch-screen | обязательно |
| category | Путь листовой категории из таксономии [avail-taxonomy.json](avail-taxonomy.json). Для блоков на схеме — только категории с schematic=true | AV distribution / Extenders | обязательно |
| auxiliaryData | Одна строка в шапке: {{deviceType}} | header: {{deviceType}} | обязательно |
| color | Не задаётся: цвет шапки будет идти от категории | — |  |

На схеме экземпляр блока переименовывается по роли в проекте (DSP 1, TX TABLE), карточка шаблона при этом не меняется.

### 2.1 Справочники

Категории и вендоры берутся только из справочников в репозитории; справочник меняется PR-ом, блоки под него — следом.

- **Таксономия** — [avail-taxonomy.json](avail-taxonomy.json). Это категории учётной системы AVAIL (Odoo) плюс наша Other / Generic. В category записывается полный путь листовой категории (leaf=true): «Audio Products / DSP», а не «DSP» и не «Audio Products». Категории с schematic=false (кабели, крепёж, лицензии, ПО, аксессуары) — позиции только для BoQ/BoM, блоком на схеме они не бывают. deviceTypeDefaults задаёт категорию по умолчанию для типа устройства; null — категорию выбирает инженер.
- **Вендоры** — [avail-vendors.json](avail-vendors.json). manufacturer пишется ровно как name; aliases — написания, которые встречаются в источниках и приводятся к name. scope уточняет, какая линейка вендора у нас в портфеле.

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

## 4. Порты

Каждый физический разъём на корпусе — один порт, сгруппированный в секцию по назначению, а не по стороне корпуса. Порядок секций повторяет поток сигнала: входы, выходы, сеть, управление, питание.

### 4.1 Секции и их порядок (обязательно)

| № | Секция | Что сюда входит |
| --- | --- | --- |
| 1 | Video Inputs | HDMI, DP, USB-C с видео, SDI, HDBaseT-входы |
| 2 | Video Outputs | HDMI, HDBaseT/DTP/XTP-выходы, loop |
| 3 | Audio Inputs | Микрофонные и линейные входы |
| 4 | Audio Outputs | Линейные и цифровые выходы (S/PDIF) |
| 5 | Speaker Outputs | Выходы на акустику |
| 6 | RF | Антенные входы и выходы |
| 7 | Network | LAN, SFP, порты AVoIP |
| 8 | Dante | Разъёмы Dante / AES67 |
| 9 | AVB | Разъёмы AVB / Milan |
| 10 | Serial | RS-232, RS-422/485, RS-232 pass-through |
| 11 | IR | IR-выходы и входы |
| 12 | Relays | Релейные выходы |
| 13 | Digital I/O | GPIO, logic I/O |
| 14 | Control | Contact closure, tally, volume и прочее управление |
| 15 | Expansion | eBUS, EXP, ACP и другие фирменные шины |
| 16 | USB | USB-хост, USB-аудио, USB-камера |
| 17 | Configuration | Сервисные порты: USB config, setup, console, OOB |
| 18 | Power | Питание, включая power loop |

Словарь сознательно дробный: так делят порты лучшие блоки инженеров (IPCP Pro 255Q xi, DMP 128 Plus), и так схему быстрее читать. Уточнение в скобках допустимо: «Audio Inputs (Phantom)», «Serial (TP Tx 1)». Секции «Back of unit», «Front of unit», «Slot N» для обычных портов не используются; пустые секции не создаются.

### 4.2 Подписи портов (обязательно)

- Смысл — как шелкография на панели, форма — единая: слова с заглавной, аббревиатуры прописными (HDMI, LAN, USB, RS-232, DTP3), номер в конце: HDMI In 1, Line Out 3, Digital I/O 2.
- Направление словами In / Out, а не стрелками и не символами.
- Уточнения — в скобках в конце: (Front), (Loop), (PoE+), (Primary), (Secondary).
- Не длиннее 28 символов; технические подробности — в notes.
- Не капсом целиком: «BALANCED AUDIO OUT 1» → «Audio Out 1 (Balanced)».

### 4.3 Направление

| Сигнал | direction |
| --- | --- |
| Видео, аналоговое аудио, акустика, IR, tally, реле | input или output, по факту |
| LAN, Dante, AVB, USB-данные, RS-232/422/485, Digital I/O, шины | bidirectional |
| Питание | input |

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

### 4.6 Заметки

notes заполняется там, где разъём или режим неочевиден: число полюсов и шаг клеммника (3-pole 3.5 mm), фантомное питание, класс PoE, режимы USB-C, Dante primary/secondary.

## 5. Особые случаи

Здесь правила, на которых блоки чаще всего расходятся.

- **Dante и AVB.** Порт — это разъём RJ-45, а не аудиоканал. Каналы (AEC Ref In, Automix Out) в порты не превращаются, их число и назначение пишутся в notes порта. Два Dante-разъёма — «Dante (Primary)» и «Dante (Secondary)».
- **HDBaseT, DTP, XTP.** Тип hdbaset, разъём rj45, в подписи семейство и направление: «DTP3 Out», «XTP In 2». Что передаётся по линии (видео, RS-232, IR, LAN, питание) — в notes.
- **PoE.** У потребителя отдельного порта питания нет: LAN подписывается «LAN (PoE+)», мощность — в poeDrawW устройства. У источника PoE (коммутатор, DSP) — poeBudgetW на устройстве и «(PoE+)» в подписи каждого питающего порта.
- **USB-C.** Если несёт видео (DP Alt Mode) — секция Video Inputs, тип usb, режим в notes. Если только данные или сервис — секция USB или Configuration.
- **Фреймы с картами** (XTP II CrossPoint, Quantum Ultra II). На шасси — только собственные разъёмы шасси (Network, Control, Configuration, Power). Карты — отдельные шаблоны, вставляются в слоты; порты карт живут в карточке карты.
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

**Линтер.** Запуск: `npm run avail:lint -- <файл.json> --verbose`. Принимает и сохранённую схему, и архив устройств. С v0.3 он сверяет category с таксономией, manufacturer — со справочником вендоров и применяет правила Generic; первая версия на Python (`tools/avail/avail_block_lint.py`, v0.2) оставлена как архив. Категория вне таксономии, не лист или с schematic=false — ошибка (E): блок с ней не поднимется выше FIX.

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
