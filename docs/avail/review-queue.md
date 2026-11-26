# Review queue

Draft catalog templates that `approve:catalog` leaves for an engineer. Source: library/catalog (1789 files); generated 2026-11-26 by `npm run report:review-queue` (api-avail).

In the queue: **380** — level B 91, level A with ports not from the manufacturer 289.

By ports source: db 312, manufacturer (datasheet) 37, manufacturer (stencil) 14, variant of db 13, no source 4.

A template is counted under every reason it has; **only** — templates for which this is the only reason (closing it moves them on: B → A, or to approval).

| Group | Reason | Templates | Only | Families (top) | Proposal |
|---|---|---:|---:|---|---|
| Level B | no powerDrawW/voltage (or poeDrawW) | 54 | 34 | Biamp voltera 16, Extron fox3 5, Biamp evoko 3, Biamp parlé 3 | **data** — Power draw and voltage from the data sheet. Proposed rules R1 (slots-only chassis) and R2 (voltage from the power notes) close a few; the rest needs the data sheet. |
| Level B | label longer than 28 characters | 15 | 0 | Extron dtp3 13, Extron in1608 2 | **rule** — Proposed rule R3 (In / Out wording, a long qualifier to notes) closes these without new data; otherwise shorten by hand to the silkscreen. |
| Level B | no weightKg | 12 | 6 | Extron fox3 5, Biamp vocia 2, Extron dtp3 2, Biamp apprimo 1 | **data** — Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied. |
| Level B | no power port | 7 | 1 | Biamp parlé 2, Extron sf 2, Biamp crowd 1, Biamp d-diwac 1 | **data** — Add the power input from the data sheet, or the bus-power note ("PoE", "bus-powered (USB)") on the port that powers it. |
| Level B | a relay must be contact-closure | 5 | 0 | Extron ipcp 5 | **manual** — Signal type against the label: check the panel and correct the signal (or the label). |
| Level B | analog-audio must be input or output, not bidirectional | 4 | 0 | Biamp tesiraforté 2, Biamp parlé 1, Biamp voltera 1 | **manual** — Check the direction on the panel (the normalizer sets it only when the label says In / Out). |
| Level B | eBUS must be ebus | 4 | 0 | Extron ipcp 4 | **manual** — Signal type against the label: check the panel and correct the signal (or the label). |
| Level B | no heightMm | 3 | 2 | Biamp easyconnect 2, Biamp vocia 1 | **data** — Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied. |
| Level B | no section | 3 | 0 | Extron ucs 2, Biamp parlé 1 | **rule** — The normalizer puts the port into the section of its signal when it can tell; the rest by hand. |
| Level B | HDBaseT/DTP/XTP must be hdbaset | 2 | 0 | Extron in1808 2 | **manual** — Signal type against the label: check the panel and correct the signal (or the label). |
| Level B | section … is not in the vocabulary | 1 | 0 | Biamp voltera 1 | **rule** — The normalizer puts the port into the section of its signal when it can tell; the rest by hand. |
| Level B | ir must be input or output, not bidirectional | 1 | 0 | Extron ucs 1 | **manual** — Check the direction on the panel (the normalizer sets it only when the label says In / Out). |
| Ports source | db | 312 | 274 | Extron fox3 50, Extron quantum 22, Extron ca 16, Extron dtp3 16 | **manual** — Community ports: an engineer compares them with the data sheet in Review, then Verify — or ports from the data sheet (portsSource datasheet) and approve:catalog. |
| Ports source | variant of db | 13 | 13 | Extron ca 6, Extron cable 4, Biamp parlé 1, Extron dtp 1 | **manual** — Follows the variant it copied: review that one (or give it data-sheet ports), then fill:catalog-ports again. |
| Ports source | no source | 4 | 2 | Extron cable 2, Extron ccd 2 | **data** — Ports from the data sheet with portsSource datasheet. |

## Level B: no powerDrawW/voltage (or poeDrawW) (54)

Proposal: **data** — Power draw and voltage from the data sheet. Proposed rules R1 (slots-only chassis) and R2 (voltage from the power notes) close a few; the rest needs the data sheet.

- Vendors: Biamp 36, Extron 18
- Device types: amplifier 16, fiber-transmitter 7, adapter 4, wired-mic 4, control-expansion 3, wireless-presentation 3, button-panel 2, power-supply 2
- Families: Biamp voltera 16, Extron fox3 5, Biamp evoko 3, Biamp parlé 3, Biamp bma 2, Biamp easyconnect 2, Biamp modena 2, Extron ccd 2, Extron ocs 2, Extron sf 2, Extron wfa 2, Extron xtp 2
- Examples: Biamp BMA 360D-I Black; Biamp BMA 360D-I White; Biamp D-DIWAC; Biamp EasyConnect MPX 250; Biamp EasyConnect USB-C Adapter

## Level B: label longer than 28 characters (15)

Proposal: **rule** — Proposed rule R3 (In / Out wording, a long qualifier to notes) closes these without new data; otherwise shorten by hand to the silkscreen.

- Vendors: Extron 15
- Device types: router 13, presentation-system 2
- Families: Extron dtp3 13, Extron in1608 2
- Examples: Extron DTP3 CrossPoint 622 IPCP A LL; Extron DTP3 CrossPoint 622 IPCP A SL LL; Extron DTP3 CrossPoint 622 IPCP A SL; Extron DTP3 CrossPoint 622 IPCP A; Extron DTP3 CrossPoint 642 IPCP A LL

## Level B: no weightKg (12)

Proposal: **data** — Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied.

- Vendors: Extron 8, Biamp 4
- Device types: fiber-transmitter 5, audio-interface 2, hdbaset-extender 2, dock 1, network-switch 1, power-supply 1
- Families: Extron fox3 5, Biamp vocia 2, Extron dtp3 2, Biamp apprimo 1, Biamp nms-ng10gpx-avb 1, Extron ucs 1
- Examples: Biamp Apprimo Touch 10 UCX-PSA; Biamp NMS-NG10GPX-AVB; Biamp Vocia PLD-1; Biamp Vocia PLD-2; Extron DTP3 R 331

## Level B: no power port (7)

Proposal: **data** — Add the power input from the data sheet, or the bus-power note ("PoE", "bus-powered (USB)") on the port that powers it.

- Vendors: Biamp 4, Extron 3
- Device types: subwoofer 2, wired-mic 2, audio-interface 1, button-panel 1, control-expansion 1
- Families: Biamp parlé 2, Extron sf 2, Biamp crowd 1, Biamp d-diwac 1, Extron ipa 1
- Examples: Biamp Crowd Mics ATOM; Biamp D-DIWAC; Biamp Parlé TCM-1EX Black; Biamp Parlé TCM-1EX White; Extron IPA T RLY4

## Level B: a relay must be contact-closure (5)

Proposal: **manual** — Signal type against the label: check the panel and correct the signal (or the label).

- Vendors: Extron 5
- Device types: control-processor 5
- Families: Extron ipcp 5
- Examples: Extron IPCP Pro 350 xi (LinkLicense); Extron IPCP Pro 360Q xi (LinkLicense); Extron IPCP Pro 360Q xi (Standard); Extron IPCP Pro 550 xi; Extron IPCP Pro 555Q xi

## Level B: analog-audio must be input or output, not bidirectional (4)

Proposal: **manual** — Check the direction on the panel (the normalizer sets it only when the label says In / Out).

- Vendors: Biamp 4
- Device types: audio-dsp 2, amplifier 1, video-bar 1
- Families: Biamp tesiraforté 2, Biamp parlé 1, Biamp voltera 1
- Examples: Biamp Parlé VBC 2800; Biamp TesiraFORTÉ AVB VT; Biamp TesiraFORTÉ AVB VT4; Biamp Voltera D 2400.8

## Level B: eBUS must be ebus (4)

Proposal: **manual** — Signal type against the label: check the panel and correct the signal (or the label).

- Vendors: Extron 4
- Device types: control-processor 4
- Families: Extron ipcp 4
- Examples: Extron IPCP Pro 360Q xi (LinkLicense); Extron IPCP Pro 360Q xi (Standard); Extron IPCP Pro 550 xi; Extron IPCP Pro 555Q xi

## Level B: no heightMm (3)

Proposal: **data** — Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied.

- Vendors: Biamp 3
- Device types: adapter 1, audio-interface 1, switcher 1
- Families: Biamp easyconnect 2, Biamp vocia 1
- Examples: Biamp EasyConnect MPX 200; Biamp EasyConnect USB-C Adapter; Biamp Vocia WR-1

## Level B: no section (3)

Proposal: **rule** — The normalizer puts the port into the section of its signal when it can tell; the rest by hand.

- Vendors: Extron 2, Biamp 1
- Device types: switcher 2, video-bar 1
- Families: Extron ucs 2, Biamp parlé 1
- Examples: Biamp Parlé VBC 2800; Extron UCS 303; Extron UCS SW 313

## Level B: HDBaseT/DTP/XTP must be hdbaset (2)

Proposal: **manual** — Signal type against the label: check the panel and correct the signal (or the label).

- Vendors: Extron 2
- Device types: presentation-system 2
- Families: Extron in1808 2
- Examples: Extron IN1808 IPCP Q MA 70 with LinkLicense; Extron IN1808 IPCP Q SA with LinkLicense

## Level B: section … is not in the vocabulary (1)

Proposal: **rule** — The normalizer puts the port into the section of its signal when it can tell; the rest by hand.

- Vendors: Biamp 1
- Device types: amplifier 1
- Families: Biamp voltera 1
- Examples: Biamp Voltera D 2400.8

## Level B: ir must be input or output, not bidirectional (1)

Proposal: **manual** — Check the direction on the panel (the normalizer sets it only when the label says In / Out).

- Vendors: Extron 1
- Device types: scaler 1
- Families: Extron ucs 1
- Examples: Extron UCS SR 501

## Ports source: db (312)

Proposal: **manual** — Community ports: an engineer compares them with the data sheet in Review, then Verify — or ports from the data sheet (portsSource datasheet) and approve:catalog.

- Vendors: Extron 275, Biamp 37
- Device types: speaker 51, expansion-card 49, fiber-transmitter 44, router 24, amplifier 17, table-box 14, frame 13, audio-dsp 11
- Families: Extron fox3 50, Extron quantum 22, Extron ca 16, Extron dtp3 16, Extron ac+usb 15, Extron dtp 15, Extron cable 13, Extron ac 12, Extron sf 11, Extron sm 10, Biamp tesira 9, Extron xpa 9
- Examples: Biamp ALC-1604D; Biamp ALC-404D; Biamp Desono C-IC6 Black; Biamp Desono C-IC6 White; Biamp Desono DX-IC6LP-TAA White

## Ports source: variant of db (13)

Proposal: **manual** — Follows the variant it copied: review that one (or give it data-sheet ports), then fill:catalog-ports again.

- Vendors: Extron 12, Biamp 1
- Device types: speaker 7, table-box 4, router 1, wired-mic 1
- Families: Extron ca 6, Extron cable 4, Biamp parlé 1, Extron dtp 1, Extron sf 1
- Examples: Biamp Parlé TTM-X White; Extron CA 163 LP (Black, 70/100V, IP54, Single); Extron CA 163 LP (Black, 8 Ohm, IP54, Single); Extron CA 163 LP (White, 70/100V, IP54, Single); Extron CA 163 LP (White, 8 Ohm, IP54, Single)

## Ports source: no source (4)

Proposal: **data** — Ports from the data sheet with portsSource datasheet.

- Vendors: Extron 4
- Device types: table-box 4
- Families: Extron cable 2, Extron ccd 2
- Examples: Extron Cable Cubby 100 AUS AC; Extron Cable Cubby 100; Extron CCD 220; Extron CCD 320

## Rule v0.9: room-mounted by name and description

Catalog cards that only the new rule makes room-mounted (category and device type do not): **57**. Dimensions and weight are no longer required for them. Level before → after:

- A→A: 40
- B→A: 2 — Extron DTP3 R 201 D, Black; Extron DTP3 R 201 D, White
- B→B: 2
- FIX→FIX: 13

## Proposed rules (not applied)

Mass reasons a rule could close without inventing data, simulated on the queue's level-B templates. **Alone** — B → A with this rule only; **with all** — B → A with every proposed rule (and the rules already in force).

| Rule | Applies to | B → A alone | B → A with all | Of those, approvable (manufacturer ports) |
|---|---:|---:|---:|---:|
| R1. Slots-only chassis without a power input need no power figures | 2 | 2 | 2 | 0 |
| R2. Voltage from the power input's notes | 1 | 1 | 1 | 1 |
| R3. Port label wording: Input / Output → In / Out, a long qualifier to notes | 15 | 15 | 15 | 0 |

With every proposed rule: **18** of 91 level-B templates reach A; 1 of them have ports from the manufacturer and would be approved by approve:catalog, the rest still need the ports review (source db).

### R1. Slots-only chassis without a power input need no power figures

A chassis whose only connections are slots (Cable Cubby drawers CCD 220 / 320) and that has no power input is passive: powerDrawW / voltage are not required, as for passive devices (3.1). Reads only the ports and slots the card has.

- Applies to: Extron CCD 220; Extron CCD 320
- B → A alone: Extron CCD 220; Extron CCD 320

### R2. Voltage from the power input's notes

When the card has powerDrawW but no voltage, and the notes of its single power input state exactly one voltage ("External 12VDC …", "12 V 2 A DC"), that voltage is the card's voltage. The value is already in the card.

- Applies to: Biamp MAX Connect
- B → A alone: Biamp MAX Connect

### R3. Port label wording: Input / Output → In / Out, a long qualifier to notes

Labels over 28 characters ("HDMI Output 1 (Buffered Mirror)", "DTP3/XTP/HDBT Scaled Output 2", "USB 2.0 (Rear, Communication)"): the standard's form In / Out (4.2), and when still too long the bracket moves to notes. Words change, the facts stay — a normalizer rule.

- Applies to: Extron DTP3 CrossPoint 622 IPCP A LL; Extron DTP3 CrossPoint 622 IPCP A SL LL; Extron DTP3 CrossPoint 622 IPCP A SL; Extron DTP3 CrossPoint 622 IPCP A; Extron DTP3 CrossPoint 642 IPCP A LL; Extron DTP3 CrossPoint 642 IPCP A SL LL; Extron DTP3 CrossPoint 642 IPCP A SL; Extron DTP3 CrossPoint 662 IPCP A LL; Extron DTP3 CrossPoint 662 IPCP A SL LL; Extron DTP3 CrossPoint 662 IPCP A SL; Extron DTP3 CrossPoint 884 IPCP A LL; Extron DTP3 CrossPoint 884 IPCP A; …
- B → A alone: Extron DTP3 CrossPoint 622 IPCP A LL; Extron DTP3 CrossPoint 622 IPCP A SL LL; Extron DTP3 CrossPoint 622 IPCP A SL; Extron DTP3 CrossPoint 622 IPCP A; Extron DTP3 CrossPoint 642 IPCP A LL; Extron DTP3 CrossPoint 642 IPCP A SL LL; Extron DTP3 CrossPoint 642 IPCP A SL; Extron DTP3 CrossPoint 662 IPCP A LL; Extron DTP3 CrossPoint 662 IPCP A SL LL; Extron DTP3 CrossPoint 662 IPCP A SL; Extron DTP3 CrossPoint 884 IPCP A LL; Extron DTP3 CrossPoint 884 IPCP A; Extron DTP3 CrossPoint 884; Extron IN1608 xi IPCP Q MA 70 (LinkLicense); Extron IN1608 xi IPCP Q SA (LinkLicense)

Not proposed as rules (they would invent data): power draw of devices whose card has none (Biamp Voltera amplifiers, FOX3 endpoints — from the data sheet); passive subwoofers (SF 10C SUB, SF 8CT SUB — active ones exist, the data sheet decides); dimensions of rack devices.
