/**
 * Pass-through power (catalog field `_avail.passThroughPower`, decision 2026-11-27): a device that powers
 * other devices downstream — Shure UA844+ (DC Out 1-4 to receivers, up to 2.5 A), PA411 (DC outputs to
 * PSM300 P3T transmitters), UABIAST (DC bias over the coax to UA834 / UA874) — publishes an input rating
 * that already includes what it passes on, so its powerDrawW does too.
 *
 *   "_avail": { "passThroughPower": { "enabled": true, "powers": "<what it powers>" } }
 *
 * Rule for a future rack / room power total (.claude/skills/avail-documents, section 8): a device powered
 * from such a block is not added a second time. Pure: used by avail:check-library (libraryFiles.ts) and
 * the future power calculation.
 */
export interface PassThroughPower {
  enabled: true;
  /** What it powers, in English: ports, devices, limits ("DC Out 1-4 to receivers, 2.5 A max combined"). */
  powers: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems of `_avail.passThroughPower` (none when absent). */
export function passThroughPowerProblems(avail: Record<string, unknown>): string[] {
  const v = avail.passThroughPower;
  if (v === undefined) return [];
  if (!isObj(v)) return ['_avail.passThroughPower must be {"enabled": true, "powers": "<what it powers>"}'];
  const out: string[] = [];
  if (v.enabled !== true) out.push("_avail.passThroughPower.enabled must be true");
  if (typeof v.powers !== "string" || !v.powers.trim()) out.push("_avail.passThroughPower.powers must name what it powers");
  const extra = Object.keys(v).filter((k) => k !== "enabled" && k !== "powers");
  if (extra.length) out.push(`_avail.passThroughPower: unknown field ${extra.join(", ")}`);
  return out;
}

/** The pass-through power of a card's `_avail` (null when it has none or the field is malformed). */
export function passThroughPowerOf(avail: unknown): PassThroughPower | null {
  if (!isObj(avail) || avail.passThroughPower === undefined || passThroughPowerProblems(avail).length) return null;
  const v = avail.passThroughPower as Record<string, unknown>;
  return { enabled: true, powers: String(v.powers) };
}
