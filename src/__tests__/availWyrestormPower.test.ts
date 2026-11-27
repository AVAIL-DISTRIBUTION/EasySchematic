/**
 * Wyrestorm power connector convention (src/avail/wyrestormPower.ts, decision 2026-11-27): by body —
 * box → locking DC barrel, in-wall → 2-pin phoenix, rack mains → IEC; a link-powered box gets its local
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

  it("a named connector stays; mains off the rack, other bodies and other vendors are left; same array when nothing changes", () => {
    const named = [hdmi, dc("12V DC In", { connectorType: "phoenix" })];
    expect(withWyrestormPower(card({}), named)).toBe(named);
    const mainsBox = [dc("AC Power In")];
    expect(withWyrestormPower(card({ voltage: "100-240V AC" }), mainsBox)).toBe(mainsBox);
    const cam = [dc()];
    expect(withWyrestormPower(card({ rackForm: undefined, deviceType: "ptz-camera" }), cam)).toBe(cam);
    expect(withWyrestormPower(card({ manufacturer: "Extron" }), cam)).toBe(cam);
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
