/**
 * Wyrestorm power connector convention (src/avail/wyrestormPower.ts, decision 2026-11-27): by body —
 * box → locking DC barrel, in-wall → 2-pin phoenix, any mains → IEC; a link-powered box gets its local
 * supply; a connector the document names is kept; other bodies and vendors are left alone.
 */
import { describe, expect, it } from "vitest";
import { WYRESTORM_NOTES, withWyrestormPower, wyrestormBody } from "../avail/wyrestormPower";

const dc = (label = "12V DC In", extra: Record<string, unknown> = {}) => ({ id: "p", label, signalType: "power", direction: "input", section: "Power", ...extra });
const hdmi = { id: "h", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi", section: "Video Inputs" };
const card = (over: Record<string, unknown>) => ({ manufacturer: "Wyrestorm", modelNumber: "EX-70-H2-TX", label: "Wyrestorm EX-70-H2-TX", deviceType: "hdbaset-extender", rackForm: "shelf-only", voltage: "12V DC", _avail: {}, ...over });

describe("wyrestormBody", () => {
  it("in-wall by part number or words; rack; box; other", () => {
    expect(wyrestormBody(card({ modelNumber: "NHD-500-IW-TX v2", rackForm: undefined }))).toBe("wall");
    expect(wyrestormBody(card({ modelNumber: "SW-120-TX3-UK", rackForm: undefined }))).toBe("wall");
    expect(wyrestormBody(card({ modelNumber: "SW-1", _avail: { description: "Decora wall plate, 1-gang" } }))).toBe("wall");
    expect(wyrestormBody(card({ rackForm: "full" }))).toBe("rack");
    expect(wyrestormBody(card({}))).toBe("box");
    expect(wyrestormBody(card({ rackForm: undefined, deviceType: "ptz-camera" }))).toBe("other");
  });
});

describe("withWyrestormPower", () => {
  it("box DC → barrel; in-wall → 2-pin phoenix; rack mains → IEC; notes say verify", () => {
    expect(withWyrestormPower(card({}), [hdmi, dc()])[1]).toMatchObject({ connectorType: "barrel", notes: WYRESTORM_NOTES.barrel });
    expect(withWyrestormPower(card({ modelNumber: "SW-120-TX3-US", rackForm: undefined, voltage: "20V DC" }), [dc("20V DC In", { notes: "20V DC 6A" })])[0])
      .toMatchObject({ connectorType: "phoenix", notes: `20V DC 6A; ${WYRESTORM_NOTES.phoenix}` });
    expect(withWyrestormPower(card({ rackForm: "full", voltage: "100-240V AC" }), [dc("AC Power In")])[0]).toMatchObject({ connectorType: "iec" });
  });

  it("any mains input → IEC whatever the body (AMP-2120-DNT: shelf box; in-wall, other); low-voltage AC is left", () => {
    const mains = dc("AC Power In", { notes: "AC 100-240V 50/60Hz" });
    expect(withWyrestormPower(card({ modelNumber: "AMP-2120-DNT", deviceType: "amplifier", voltage: "100-240V AC" }), [mains])[0])
      .toMatchObject({ connectorType: "iec", notes: `AC 100-240V 50/60Hz; ${WYRESTORM_NOTES.iec}` });
    expect(withWyrestormPower(card({ modelNumber: "SW-1-IW", rackForm: undefined, voltage: "100-240V AC" }), [dc("AC Power In")])[0]).toMatchObject({ connectorType: "iec" });
    expect(withWyrestormPower(card({ rackForm: undefined, deviceType: "controller", voltage: "100-240V AC" }), [dc("Mains In")])[0]).toMatchObject({ connectorType: "iec" });
    const lowAc = [dc("24V AC In")];
    expect(withWyrestormPower(card({ voltage: "24V AC" }), lowAc)).toBe(lowAc);
  });

  it("a named connector stays; other bodies and other vendors are left; same array when nothing changes", () => {
    const named = [hdmi, dc("12V DC In", { connectorType: "phoenix" })];
    expect(withWyrestormPower(card({}), named)).toBe(named);
    const other = [dc()];
    expect(withWyrestormPower(card({ rackForm: undefined, deviceType: "controller" }), other)).toBe(other);
    expect(withWyrestormPower(card({ manufacturer: "Extron" }), other)).toBe(other);
  });

  it("a link-powered box (PoH / PoC) gets its local supply with the card's voltage; without a voltage — DC In", () => {
    const rx = withWyrestormPower(card({ voltage: "18V DC / PoH" }), [hdmi]);
    expect(rx[1]).toMatchObject({ label: "18V DC In", signalType: "power", direction: "input", connectorType: "barrel", section: "Power" });
    expect(String((rx[1] as Record<string, unknown>).notes)).toMatch(/^local supply, alternative to power over the link; Wyrestorm convention/);
    const noV = withWyrestormPower(card({ voltage: "PoC (bidirectional)" }), [hdmi]);
    expect(noV[1]).toMatchObject({ label: "DC In", notes: expect.stringContaining("voltage not published") });
    // Not powered over the link, no power port: nothing added (the document's gap stays visible).
    expect(withWyrestormPower(card({ voltage: "12V DC" }), [hdmi])).toEqual([hdmi]);
  });
});

describe("withWyrestormPower: additions of 2026-11-27 (AC cord, adapters, PoE only, signal ports)", () => {
  it("AC power cord matrices and IDB boxes → IEC; cameras and bars → barrel, not locking", () => {
    expect(withWyrestormPower(card({ modelNumber: "MXV-0808-H2A v3", voltage: "100-240V AC" }), [dc("AC Power In")])[0]).toMatchObject({ connectorType: "iec", notes: WYRESTORM_NOTES.iec });
    expect(withWyrestormPower(card({ modelNumber: "IDB-400-MS", rackForm: undefined, deviceType: "table-box", voltage: "100-250V AC" }), [dc("Mains In")])[0]).toMatchObject({ connectorType: "iec" });
    expect(withWyrestormPower(card({ modelNumber: "CAM-210-PTZ", rackForm: undefined, deviceType: "ptz-camera" }), [dc()])[0]).toMatchObject({ connectorType: "barrel", notes: WYRESTORM_NOTES.adapter });
  });

  it("PoE-only keypads and touch panels: the unnamed power port goes, PoE on the LAN", () => {
    const lan = { id: "l", label: "LAN", signalType: "ethernet", direction: "bidirectional", connectorType: "rj45", section: "Network" };
    const out = withWyrestormPower(card({ modelNumber: "SYN-KEY10", rackForm: undefined, deviceType: "keypad" }), [lan, dc()]);
    expect(out).toEqual([{ ...lan, notes: WYRESTORM_NOTES.poe }]);
  });

  it("signal ports: named in the notes first, else the convention", () => {
    const sig = (signalType: string, direction: string, notes?: string) => ({ id: "s", label: "X", signalType, direction, section: "Control", ...(notes ? { notes } : {}) });
    const one = (p: Record<string, unknown>) => withWyrestormPower(card({}), [p])[0];
    expect(one(sig("serial", "bidirectional"))).toMatchObject({ connectorType: "phoenix", notes: WYRESTORM_NOTES.serial });
    expect(one(sig("serial", "bidirectional", "8-pin Mini DIN, max length 30m"))).toMatchObject({ connectorType: "mini-din-8", notes: "8-pin Mini DIN, max length 30m" });
    expect(one(sig("serial", "bidirectional", "debug only, 3.5mm"))).toMatchObject({ connectorType: "trs-eighth" });
    expect(one(sig("analog-audio", "output", "5-pin balanced"))).toMatchObject({ connectorType: "phoenix", notes: "5-pin balanced" });
    expect(one(sig("analog-audio", "output", "balanced"))).toMatchObject({ connectorType: "phoenix", notes: `balanced; ${WYRESTORM_NOTES.balanced}` });
    expect(one(sig("analog-audio", "output", "stereo; de-embed"))).toMatchObject({ connectorType: "trs-eighth", notes: `stereo; de-embed; ${WYRESTORM_NOTES.unbalanced}` });
    expect(one(sig("analog-audio", "input"))).not.toHaveProperty("connectorType"); // balance unknown: left
    expect(one(sig("ir", "output"))).toMatchObject({ connectorType: "trs-eighth", notes: WYRESTORM_NOTES.irOut });
    expect(one(sig("ir", "input"))).toMatchObject({ connectorType: "trs-eighth", notes: WYRESTORM_NOTES.irIn });
  });
});

