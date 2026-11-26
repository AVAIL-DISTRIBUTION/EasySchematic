# Review queue

Draft catalog templates that `approve:catalog` leaves for an engineer. Source: library/catalog (1789 files); generated 2026-11-26 by `npm run report:review-queue` (api-avail).

In the queue: **344** — level B 53, level A with ports not from the manufacturer 291.

By ports source: db 275, manufacturer (datasheet) 39, manufacturer (stencil) 12, variant of db 12, no source 6.

A template is counted under every reason it has; **only** — templates for which this is the only reason (closing it moves them on: B → A, or to approval).

| Group | Reason | Templates | Only | Families (top) | Proposal |
|---|---|---:|---:|---|---|
| Level B | no powerDrawW/voltage (or poeDrawW) | 44 | 34 | Biamp voltera 16, Extron fox3 5, Biamp evoko 3, Biamp bma 2 | **data** — Power draw and voltage from the data sheet. Rules R1 (slots-only chassis) and R2 (voltage from the power notes) of v0.10 already closed what they can; the rest needs the data sheet. |
| Level B | no weightKg | 12 | 6 | Extron fox3 5, Biamp vocia 2, Extron dtp3 2, Biamp apprimo 1 | **data** — Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied. |
| Level B | no heightMm | 3 | 2 | Biamp easyconnect 2, Biamp vocia 1 | **data** — Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied. |
| Level B | no power port | 2 | 1 | Biamp crowd 1, Biamp d-diwac 1 | **data** — Add the power input from the data sheet, or the bus-power note ("PoE", "bus-powered (USB)") on the port that powers it. |
| Ports source | db | 275 | 273 | Extron fox3 50, Extron quantum 22, Extron ca 16, Extron dtp3 16 | **manual** — Community ports: an engineer compares them with the data sheet in Review, then Verify — or ports from the data sheet (portsSource datasheet) and approve:catalog. |
| Ports source | variant of db | 12 | 12 | Extron ca 6, Extron cable 4, Extron dtp 1, Extron sf 1 | **manual** — Follows the variant it copied: review that one (or give it data-sheet ports), then fill:catalog-ports again. |
| Ports source | no source | 6 | 6 | Extron cable 4, Extron ccd 2 | **data** — Ports from the data sheet with portsSource datasheet. |

## Level B: no powerDrawW/voltage (or poeDrawW) (44)

Proposal: **data** — Power draw and voltage from the data sheet. Rules R1 (slots-only chassis) and R2 (voltage from the power notes) of v0.10 already closed what they can; the rest needs the data sheet.

- Vendors: Biamp 33, Extron 11
- Device types: amplifier 16, fiber-transmitter 7, adapter 4, button-panel 2, power-supply 2, switcher 2, touch-screen 2, wired-mic 2
- Families: Biamp voltera 16, Extron fox3 5, Biamp evoko 3, Biamp bma 2, Biamp easyconnect 2, Biamp modena 2, Extron wfa 2, Extron xtp 2, Biamp d-diwac 1, Biamp echo 1, Biamp nms-ng10gpx-avb 1, Biamp parlé 1
- Examples: Biamp BMA 360D-I Black; Biamp BMA 360D-I White; Biamp D-DIWAC; Biamp EasyConnect MPX 250; Biamp EasyConnect USB-C Adapter

## Level B: no weightKg (12)

Proposal: **data** — Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied.

- Vendors: Extron 8, Biamp 4
- Device types: fiber-transmitter 5, audio-interface 2, hdbaset-extender 2, dock 1, network-switch 1, power-supply 1
- Families: Extron fox3 5, Biamp vocia 2, Extron dtp3 2, Biamp apprimo 1, Biamp nms-ng10gpx-avb 1, Extron ucs 1
- Examples: Biamp Apprimo Touch 10 UCX-PSA; Biamp NMS-NG10GPX-AVB; Biamp Vocia PLD-1; Biamp Vocia PLD-2; Extron DTP3 R 331

## Level B: no heightMm (3)

Proposal: **data** — Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied.

- Vendors: Biamp 3
- Device types: adapter 1, audio-interface 1, switcher 1
- Families: Biamp easyconnect 2, Biamp vocia 1
- Examples: Biamp EasyConnect MPX 200; Biamp EasyConnect USB-C Adapter; Biamp Vocia WR-1

## Level B: no power port (2)

Proposal: **data** — Add the power input from the data sheet, or the bus-power note ("PoE", "bus-powered (USB)") on the port that powers it.

- Vendors: Biamp 2
- Device types: audio-interface 1, button-panel 1
- Families: Biamp crowd 1, Biamp d-diwac 1
- Examples: Biamp Crowd Mics ATOM; Biamp D-DIWAC

## Ports source: db (275)

Proposal: **manual** — Community ports: an engineer compares them with the data sheet in Review, then Verify — or ports from the data sheet (portsSource datasheet) and approve:catalog.

- Vendors: Extron 275
- Device types: expansion-card 49, fiber-transmitter 44, speaker 43, router 24, table-box 14, amplifier 11, control-processor 11, frame 11
- Families: Extron fox3 50, Extron quantum 22, Extron ca 16, Extron dtp3 16, Extron ac+usb 15, Extron dtp 15, Extron cable 13, Extron ac 12, Extron sf 11, Extron sm 10, Extron xpa 9, Extron ipcp 8
- Examples: Extron 12G HD-SDI 101; Extron AC 102 AUS; Extron AC 102 BR; Extron AC 102 CN; Extron AC 102 EU

## Ports source: variant of db (12)

Proposal: **manual** — Follows the variant it copied: review that one (or give it data-sheet ports), then fill:catalog-ports again.

- Vendors: Extron 12
- Device types: speaker 7, table-box 4, router 1
- Families: Extron ca 6, Extron cable 4, Extron dtp 1, Extron sf 1
- Examples: Extron CA 163 LP (Black, 70/100V, IP54, Single); Extron CA 163 LP (Black, 8 Ohm, IP54, Single); Extron CA 163 LP (White, 70/100V, IP54, Single); Extron CA 163 LP (White, 8 Ohm, IP54, Single); Extron CA 163 PT (Black, 8 Ohm, IP54, Single)

## Ports source: no source (6)

Proposal: **data** — Ports from the data sheet with portsSource datasheet.

- Vendors: Extron 6
- Device types: table-box 6
- Families: Extron cable 4, Extron ccd 2
- Examples: Extron Cable Cubby 100 AUS AC; Extron Cable Cubby 100; Extron Cable Cubby F55 (Aluminum, No AC); Extron Cable Cubby F55 (No AC, Black); Extron CCD 220

## Rule v0.9: room-mounted by name and description

Catalog cards that only the new rule makes room-mounted (category and device type do not): **57**. Dimensions and weight are no longer required for them. Level before → after:

- A→A: 41
- B→A: 2 — Extron DTP3 R 201 D, Black; Extron DTP3 R 201 D, White
- B→B: 1
- FIX→FIX: 13

## Proposed rules

None at the moment. R1 (slots-only chassis need no power figures), R2 (voltage from the power input's notes) and R3 (port labels: In / Out, a long qualifier to notes) were applied in standard v0.10.

Not proposed as rules (they would invent data): power draw of devices whose card has none (Biamp Voltera amplifiers, FOX3 endpoints — from the data sheet); passive subwoofers (SF 10C SUB, SF 8CT SUB — active ones exist, the data sheet decides); dimensions of rack devices.
