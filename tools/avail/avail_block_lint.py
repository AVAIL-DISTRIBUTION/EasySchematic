#!/usr/bin/env python3
"""AVAIL Device Block Standard v0.2 - linter.

Usage:
  python3 avail_block_lint.py <schematic.json | device-archive.json> [--verbose]

Checks every device template / device node against the standard and prints
level A / B / FIX per device. Errors (E) block level B, warnings (W) block level A.
"""
import json, re, sys

SECTIONS = ["Video Inputs", "Video Outputs", "Audio Inputs", "Audio Outputs", "Speaker Outputs", "RF",
            "Network", "Dante", "AVB", "Serial", "IR", "Relays", "Digital I/O", "Control",
            "Expansion", "USB", "Configuration", "Power"]
BIDIR = {"ethernet", "dante", "avb", "serial", "rs422", "gpio", "ebus", "extron-exp", "thunderbolt"}
SKU_RE = re.compile(r"^\d{2}-\d{3,4}-\d{2}$")


def section_base(s):
    return re.sub(r"\s*\(.*\)$", "", s or "").strip()


def lint_device(d):
    E, W = [], []
    label, model = d.get("label", ""), d.get("model")
    man = d.get("manufacturer", "")
    # --- card
    if not man: E.append("нет manufacturer")
    elif not label.lower().startswith(man.lower()): W.append(f"label не начинается с производителя ({man})")
    if model and model != label: W.append("model отличается от label")
    if not d.get("modelNumber"): E.append("нет modelNumber")
    sn = d.get("shortName")
    if not sn: W.append("нет shortName")
    elif SKU_RE.match(sn): W.append(f"shortName = артикул ({sn}), нужна модель")
    if not d.get("deviceType"): E.append("нет deviceType")
    if not d.get("category"): W.append("нет category")
    aux = d.get("auxiliaryData") or []
    if [a.get("text") for a in aux] != ["{{deviceType}}"]: W.append("шапка не {{deviceType}}")
    if d.get("color"): W.append("задан color")
    # --- physical
    poe = bool(d.get("poeDrawW"))
    for f in ("heightMm", "widthMm", "depthMm", "weightKg"):
        if not d.get(f): W.append(f"нет {f}"); break
    passive = d.get("deviceType") in ("speaker", "antenna", "passive")
    if not poe and not passive and not (d.get("powerDrawW") and d.get("voltage")):
        W.append("нет powerDrawW/voltage (или poeDrawW)")
    if not d.get("referenceUrl"): W.append("нет referenceUrl")
    if not d.get("searchTerms"): W.append("нет searchTerms")
    # --- ports
    ports = [p for p in d.get("ports", []) if not str(p.get("section", "")).startswith("Slot")]
    if not any(p.get("signalType") == "power" for p in ports) and not poe and not d.get("slots"):
        if d.get("deviceType") not in ("speaker", "antenna"): E.append("нет порта питания")
    order = []
    for p in ports:
        l, sig, dr, sec = p.get("label", ""), p.get("signalType"), p.get("direction"), p.get("section")
        tag = f"«{l}»"
        if not p.get("connectorType"): E.append(f"{tag}: нет connectorType")
        b = section_base(sec)
        if not sec: E.append(f"{tag}: нет секции")
        elif b not in SECTIONS: E.append(f"{tag}: секция «{sec}» вне словаря")
        else: order.append(SECTIONS.index(b))
        words = [w for w in re.split(r"[\s/()-]+", l) if re.search(r"[A-Za-z]{2,}", w)]
        if len(words) >= 2 and l == l.upper(): W.append(f"{tag}: подпись капсом")
        if len(l) > 28: W.append(f"{tag}: подпись длиннее 28 символов")
        if sig in BIDIR and dr != "bidirectional":
            (W if sig == "dante" else W).append(f"{tag}: {sig} должен быть bidirectional"
                                                + (" (каналы Dante — не порты)" if sig == "dante" else ""))
        if sig == "power" and dr != "input" and not re.search(r"loop|thru|out", l, re.I):
            E.append(f"{tag}: питание не input")
        if sig == "rs422" and "232" in l: E.append(f"{tag}: RS-232 размечен как rs422")
        if "relay" in l.lower() and sig != "contact-closure": W.append(f"{tag}: реле должно быть contact-closure")
        if "ebus" in l.lower() and sig != "ebus": W.append(f"{tag}: eBUS должен быть ebus")
        if re.search(r"\b(dtp|xtp|hdbaset)", l.lower()) and sig != "hdbaset" and sig != "power":
            W.append(f"{tag}: HDBaseT/DTP/XTP должен быть hdbaset")
    if order != sorted(order): W.append("порядок секций не по стандарту")
    level = "FIX" if E else ("B" if W else "A")
    return level, E, W


def devices(doc):
    if "templates" in doc: return doc["templates"]
    return [n["data"] for n in doc.get("nodes", []) if n.get("type") == "device"]


if __name__ == "__main__":
    doc = json.load(open(sys.argv[1]))
    verbose = "--verbose" in sys.argv
    res = []
    for d in devices(doc):
        lv, E, W = lint_device(d)
        res.append((d.get("label"), lv, E, W))
        print(f"{lv:<4} {d.get('label','?'):<40} E={len(E):<3} W={len(W)}")
        if verbose:
            for m in E: print("      E", m)
            for m in W: print("      W", m)
    print("\nИтого:", {k: sum(1 for r in res if r[1] == k) for k in ("A", "B", "FIX")})
