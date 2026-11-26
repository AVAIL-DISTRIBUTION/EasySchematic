/**
 * AVAIL block auto-normalizer: brings a template closer to the Device Block Standard
 * (docs/avail/device-block-standard.md) where the fix is mechanical and unambiguous.
 *
 *   normalizeBlock(template) → { template, changes }
 *
 * Pure function, the input is not modified. Rule of the game: nothing is invented.
 * When a field cannot be fixed unambiguously it is left as it is and a change with
 * `manual: true` ("needs a manual fix") explains why.
 *
 * What it does:
 *   - manufacturer → canonical vendor name; category from deviceTypeDefaults when the
 *     current one is missing or not a leaf of the taxonomy (a BoQ-only leaf, schematic=false,
 *     is a decision and is kept);
 *   - header (auxiliaryData) → the single row {{deviceType}}; color is removed (the
 *     header color will come from the category);
 *   - label starts with the canonical manufacturer; shortName = model (label without the
 *     manufacturer) when empty or a part number;
 *   - port labels in all caps → standard form (words capitalized, abbreviations upper),
 *     only when every word is known;
 *   - LAN / Dante / AVB / serial / GPIO / buses → direction bidirectional;
 *   - video / analog audio / speaker level / IR marked bidirectional → direction from the
 *     label (In / Out / Loop / Mic / Rx / Tx…), HDMI (e)ARC → input; otherwise manual;
 *   - port sections → the standard's vocabulary (by section name, or by signal type and
 *     direction for "Back/Front of unit", "Inputs", empty and other ad-hoc sections),
 *     front-panel ports get "(Front)"; ports ordered by the standard's section order.
 */
import { BLOCK_SECTIONS } from "./blockLint";
import { ABBREVIATIONS } from "./labels";
import categoryPlanJson from "../../docs/avail/category-plan.json";
import { canonicalFamily, familyInfo } from "./slotFamilies";
import { BIDIRECTIONAL_SIGNALS, CONFIGURABLE_NOTE, directionFromLabel, SIGNAL_CONNECTORS, sectionBase, targetSection } from "./sections";

export { BIDIRECTIONAL_SIGNALS, sectionByPurpose } from "./sections";
import { applyCatalogRules } from "./catalogRules";
import { defaultCategoryFor, findCategory, findVendor, normalizeManufacturer } from "./library";

export interface NormalizeChange {
  /** Field path: "manufacturer", "label", "ports[<id>].section", "ports.order", … */
  field: string;
  from?: unknown;
  to?: unknown;
  /** What was done, or why it needs a human. */
  note: string;
  /** true — not changed: no unambiguous fix ("needs a manual fix"). */
  manual?: boolean;
  /** For an unresolved port section: the port's signal type and direction (report breakdown). */
  port?: { signalType: string; direction: string };
}

export interface NormalizeResult<T> {
  template: T;
  changes: NormalizeChange[];
}

type Obj = Record<string, unknown>;
type PortLike = Obj & { id?: unknown; label?: unknown; signalType?: unknown; direction?: unknown; section?: unknown };

// Python-style part number (the linter's rule): 60-1885-52.
const SKU_RE = /^\p{Nd}{2}-\p{Nd}{3,4}-\p{Nd}{2}(?=\n?$)/u;

// "AUX", "PGM", "PVW" read as abbreviations on panels; everything else below is a plain word.
const WORDS = new Set(
  `in out input inputs output outputs line mic power audio video left right main program preview monitor loop thru through
   remote control network relay relays port ports host device service setup config reset ground phantom balanced unbalanced
   analog digital speaker speakers headphone headphones front rear primary secondary zone level record send return bus
   channel mix master sub subwoofer amp amplifier antenna display camera link data sync clock trigger alarm contact closure
   button tally expansion card slot mute volume mode status local external internal stereo mono console mouse keyboard touch
   panel sensor light fan port serial switch room table wall program aux dante lan optical coax coaxial fiber
   circuit key mirrored genlock patch ethernet automix screen matrix composite cascade hi low ceiling mains debug
   passthrough up down cable secure reference wireless wired receiver transmitter encoder decoder scaler`.split(/\s+/).filter(Boolean),
);

/** The standard's header (section 2): a single aux row with the device type. */
export const STANDARD_HEADER: readonly { text: string; position: "header" }[] = [{ text: "{{deviceType}}", position: "header" }];

/** Same condition as the linter: exactly one aux row, {{deviceType}}. */
export function hasStandardHeader(aux: unknown): boolean {
  return Array.isArray(aux) && aux.length === 1 && !!aux[0] && typeof aux[0] === "object" && (aux[0] as Obj).text === "{{deviceType}}";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function startsWithWord(label: string, prefix: string): boolean {
  if (!prefix || label.length < prefix.length) return false;
  if (label.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return false;
  const next = label.charAt(prefix.length);
  return next === "" || /\s/.test(next);
}

/**
 * The label with the canonical manufacturer in front: a known spelling at the start (the
 * canonical name, an alias, the original value) is replaced, otherwise the name is added.
 * Longest spelling first: "Biamp Systems X" is the alias "Biamp Systems", not "Biamp" + "Systems X".
 */
export function labelWithManufacturer(label: string, manufacturer: string, original = ""): string {
  const vendor = findVendor(manufacturer);
  const prefixes = [manufacturer, ...(vendor ? [vendor.name, ...vendor.aliases] : []), original].filter(Boolean).sort((a, b) => b.length - a.length);
  const hit = prefixes.find((p) => startsWithWord(label, p));
  return hit ? `${manufacturer}${label.slice(hit.length)}` : `${manufacturer} ${label}`;
}

const CATEGORY_PLAN = new Map(
  (categoryPlanJson as { templates: { id: string; category: string }[] }).templates.map((e) => [e.id, e.category]),
);

/** Category docs/avail/category-plan.json gives this template id, if any. */
export function plannedCategory(id: string): string | undefined {
  return id ? CATEGORY_PLAN.get(id) : undefined;
}

/** Category of a card's slot family, or of a chassis' first slot family with one (registry). */
function familyCategory(t: Obj): { family: string; category: string } | null {
  const families = [
    typeof t.slotFamily === "string" ? t.slotFamily : "",
    ...(Array.isArray(t.slots) ? (t.slots as Obj[]).map((s) => (s && typeof s.slotFamily === "string" ? s.slotFamily : "")) : []),
  ].filter(Boolean);
  for (const f of families) {
    const c = familyInfo(f)?.category;
    if (c && findCategory(c)?.leaf) return { family: f, category: c };
  }
  return null;
}

/** Lint condition for an all-caps label: ≥2 Latin words and no lower case. */
export function isCapsLabel(label: string): boolean {
  const words = label.split(/[\s/()-]+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= 2 && label === label.toUpperCase();
}

/**
 * "HDMI INPUT 1" → "HDMI Input 1". Returns null when some word is neither a known word
 * nor a known abbreviation: guessing its case would be inventing.
 */
export function standardCaseLabel(label: string): string | null {
  let unknown = false;
  const word = (w: string): string => {
    if (w === "" || w === "/" || w === "-") return w;
    const abbr = ABBREVIATIONS.get(w.toUpperCase());
    if (abbr) return abbr;
    if (/\d/.test(w) || !/[A-Za-z]/.test(w) || w.length === 1) return w; // 12V, DTP3, 3G, L, R — as written
    if (WORDS.has(w.toLowerCase())) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    unknown = true;
    return w;
  };
  const out = label.replace(/[A-Za-z0-9+][A-Za-z0-9+/-]*/g, (token) => {
    const abbr = ABBREVIATIONS.get(token.toUpperCase());
    if (abbr) return abbr; // RS-232, I/O, S/PDIF as a whole
    // Compound tokens ("IN/OUT", "MIC-LINE"): every part must be known.
    return token.split(/([/-])/).map(word).join("");
  });
  return unknown ? null : out;
}

/**
 * Normalizes one block. Works on library templates (DeviceTemplate) and on the data of
 * device nodes; unknown fields are carried over untouched.
 */
export function normalizeBlock<T extends object>(input: T): NormalizeResult<T> {
  const t = structuredClone(input) as unknown as Obj;
  const changes: NormalizeChange[] = [];

  // --- manufacturer
  const manRaw = str(t.manufacturer);
  const man = normalizeManufacturer(manRaw);
  if (man && man !== manRaw) {
    changes.push({ field: "manufacturer", from: manRaw, to: man, note: "canonical name from avail-vendors.json" });
    t.manufacturer = man;
  }
  if (!man) changes.push({ field: "manufacturer", note: "no manufacturer: label and shortName are not normalized", manual: true });

  // --- slot families (standard "Slots and cards"): old names → registry name; extra accepted families
  if (typeof t.slotFamily === "string" && t.slotFamily) {
    const fam = canonicalFamily(t.slotFamily);
    if (fam !== t.slotFamily) {
      changes.push({ field: "slotFamily", from: t.slotFamily, to: fam, note: "slot family from docs/avail/slot-families.json" });
      t.slotFamily = fam;
    }
  }
  if (Array.isArray(t.slots)) {
    t.slots = (t.slots as unknown[]).map((raw, i) => {
      if (!raw || typeof raw !== "object") return raw;
      const slot = { ...(raw as Obj) };
      const where = `slots[${str(slot.id) || i}]`;
      if (typeof slot.slotFamily === "string" && slot.slotFamily) {
        const fam = canonicalFamily(slot.slotFamily);
        if (fam !== slot.slotFamily) {
          changes.push({ field: `${where}.slotFamily`, from: slot.slotFamily, to: fam, note: "slot family from docs/avail/slot-families.json" });
          slot.slotFamily = fam;
        }
        const extra = familyInfo(fam)?.alsoAccepts ?? [];
        const current = Array.isArray(slot.slotFamilies) ? (slot.slotFamilies as unknown[]).filter((f): f is string => typeof f === "string").map(canonicalFamily) : [];
        const next = [...new Set([...current, ...extra])].filter((f) => f !== fam);
        const before = Array.isArray(slot.slotFamilies) ? slot.slotFamilies : undefined;
        if (next.length && JSON.stringify(next) !== JSON.stringify(before)) {
          changes.push({ field: `${where}.slotFamilies`, from: before ?? null, to: next, note: `the ${fam} slot also accepts these families` });
          slot.slotFamilies = next;
        }
      }
      return slot;
    });
  }

  // --- category
  const planned = plannedCategory(str(t.id));
  const cat = findCategory(str(t.category));
  if (planned && planned !== t.category) {
    changes.push({ field: "category", from: t.category ?? null, to: planned, note: "docs/avail/category-plan.json" });
    t.category = planned;
  } else if (planned) {
    // already as planned
  } else if (cat?.leaf && !cat.schematic) {
    // A valid BoQ-only category (schematic=false) is a deliberate decision: not replaced.
    changes.push({ field: "category", from: t.category, note: `category "${cat.path}" is BoQ-only (schematic=false): kept, decide whether the item belongs on schematics`, manual: true });
  } else if (!cat || !cat.leaf) {
    // A card or a chassis takes the category of its slot family (cards = their chassis'),
    // then deviceTypeDefaults (also a BoQ-only default when there is no category at all).
    const famCat = familyCategory(t);
    const def = defaultCategoryFor(str(t.deviceType));
    const defCat = findCategory(def);
    if (famCat) {
      changes.push({ field: "category", from: t.category ?? null, to: famCat.category, note: `category of slot family ${famCat.family}` });
      t.category = famCat.category;
    } else if (def && defCat?.leaf && (defCat.schematic || !str(t.category))) {
      changes.push({ field: "category", from: t.category ?? null, to: def, note: `deviceTypeDefaults for "${str(t.deviceType)}"` });
      t.category = def;
    } else {
      changes.push({ field: "category", from: t.category ?? null, note: `no default category for type "${str(t.deviceType)}": pick one from the taxonomy`, manual: true });
    }
  }

  // --- header: one row, {{deviceType}}; no color (the standard, section 2)
  if (!hasStandardHeader(t.auxiliaryData)) {
    changes.push({ field: "auxiliaryData", from: t.auxiliaryData ?? null, to: [...STANDARD_HEADER], note: "header = {{deviceType}}" });
    t.auxiliaryData = STANDARD_HEADER.map((r) => ({ ...r }));
  }
  if ("color" in t) {
    if (t.color !== undefined && t.color !== null && t.color !== "") {
      changes.push({ field: "color", from: t.color, note: "color removed: the header color will come from the category" });
    }
    delete t.color;
  }

  // --- label: canonical manufacturer at the start
  const label = str(t.label);
  if (man && label) {
    const next = labelWithManufacturer(label, man, manRaw);
    if (next !== label) {
      changes.push({ field: "label", from: label, to: next, note: "label = manufacturer + model" });
      t.label = next;
    }
  }

  // --- shortName: the model, when empty or a part number
  const sn = str(t.shortName);
  if (!sn || SKU_RE.test(sn)) {
    const l = str(t.label);
    const model = man && startsWithWord(l, man) ? l.slice(man.length).trim() : "";
    if (model) {
      changes.push({ field: "shortName", from: sn || null, to: model, note: sn ? "was a part number: model taken from label" : "model taken from label" });
      t.shortName = model;
    } else {
      changes.push({ field: "shortName", from: sn || null, note: "cannot tell the model from the label", manual: true });
    }
  }

  // --- ports
  if (Array.isArray(t.ports)) {
    const ports = (t.ports as unknown[]).map((p) => (p && typeof p === "object" ? (p as PortLike) : p));
    for (const p of ports) {
      if (!p || typeof p !== "object") continue;
      const port = p as PortLike;
      const id = str(port.id) || str(port.label);
      const where = `ports[${id}]`;

      // label case
      const pl = str(port.label);
      if (isCapsLabel(pl)) {
        const fixed = standardCaseLabel(pl);
        if (!fixed) {
          changes.push({ field: `${where}.label`, from: pl, note: "all-caps label with unknown words: fix it from the panel silkscreen", manual: true });
        } else if (isCapsLabel(fixed)) {
          changes.push({ field: `${where}.label`, from: pl, note: "label made of abbreviations only: check it against the panel silkscreen", manual: true });
        } else {
          changes.push({ field: `${where}.label`, from: pl, to: fixed, note: "all-caps label → standard case" });
          port.label = fixed;
        }
      }

      // direction
      const sig = str(port.signalType);
      if (BIDIRECTIONAL_SIGNALS.has(sig) && port.direction !== "bidirectional" && port.direction !== "passthrough") {
        changes.push({ field: `${where}.direction`, from: port.direction, to: "bidirectional", note: `${sig} is bidirectional by the standard (4.3)` });
        port.direction = "bidirectional";
      }
      // physical-direction signals (video, analog audio, speaker level, IR): never bidirectional
      const inferred = directionFromLabel(port);
      if (inferred && "manual" in inferred) {
        changes.push({ field: `${where}.direction`, from: port.direction, note: inferred.manual, manual: true });
      } else if (inferred && "configurable" in inferred) {
        const notes = str(port.notes);
        if (!notes.toLowerCase().includes(CONFIGURABLE_NOTE)) {
          const next = notes ? `${notes}; ${CONFIGURABLE_NOTE}` : CONFIGURABLE_NOTE;
          changes.push({ field: `${where}.notes`, from: notes || null, to: next, note: "HDBaseT port configurable as input or output (v3)" });
          port.notes = next;
        }
      } else if (inferred) {
        changes.push({
          field: `${where}.direction`,
          from: port.direction,
          to: inferred.direction,
          note: inferred.arc ? "HDMI with (e)ARC is an input; the audio return goes in notes" : `${sig} direction from the label`,
        });
        port.direction = inferred.direction;
        if (inferred.arc) {
          const notes = str(port.notes);
          if (!/audio return/i.test(notes)) port.notes = notes ? `${notes}; (e)ARC: audio return to the source` : "(e)ARC: audio return to the source";
        }
      }

      // connector, where the signal leaves no doubt (v3)
      if (!str(port.connectorType) && SIGNAL_CONNECTORS[sig]) {
        changes.push({ field: `${where}.connectorType`, from: port.connectorType ?? null, to: SIGNAL_CONNECTORS[sig], note: `connector from the signal type ${sig}` });
        port.connectorType = SIGNAL_CONNECTORS[sig];
      }

      // section
      const target = targetSection(port);
      if (target && "manual" in target) {
        changes.push({
          field: `${where}.section`,
          from: port.section ?? null,
          note: target.manual,
          manual: true,
          port: { signalType: str(port.signalType), direction: str(port.direction) },
        });
      } else if (target) {
        changes.push({ field: `${where}.section`, from: port.section ?? null, to: target.section, note: "section from the standard's vocabulary" });
        port.section = target.section;
        const cur = str(port.label);
        if (target.front && !/front/i.test(cur)) {
          changes.push({ field: `${where}.label`, from: cur, to: `${cur} (Front)`, note: "front panel port: \"(Front)\" added to the label" });
          port.label = `${cur} (Front)`;
        }
      }
    }

    // order: standard sections in the standard's order; slot and unresolved ports keep their place after them
    const rank = (p: unknown): number => {
      const sec = p && typeof p === "object" ? str((p as PortLike).section) : "";
      const i = (BLOCK_SECTIONS as readonly string[]).indexOf(sectionBase(sec));
      return i < 0 ? BLOCK_SECTIONS.length : i;
    };
    const sorted = ports.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
    if (sorted.some((p, i) => p !== ports[i])) {
      changes.push({ field: "ports.order", note: "ports ordered by the standard's sections (4.1)" });
    }
    t.ports = sorted;
  }

  // --- R2 voltage from the power input's notes, R3 long port labels (v0.10, catalogRules.ts)
  const ruled = applyCatalogRules(t);
  for (const c of ruled.changes) {
    changes.push({
      field: c.field,
      from: c.from,
      to: c.to,
      note: c.rule === "R2" ? "voltage stated by the power input (R2)" : "label over 28 characters: In / Out, qualifier to notes (R3)",
    });
  }
  return { template: ruled.block as unknown as T, changes };
}

/** Changes that were applied (not the "manual" notes). */
export function appliedChanges(changes: NormalizeChange[]): NormalizeChange[] {
  return changes.filter((c) => !c.manual);
}
