/**
 * Vendor decisions (docs/avail/vendor-decisions.json — the source of truth): which
 * manufacturers the AVAIL library keeps, renames, narrows down, folds into Generic or
 * drops. Pure functions, no Node or browser dependencies: apply:vendor-decisions and
 * import:upstream (api-avail) both classify templates with classifyTemplate().
 *
 *   keep     — keep list ∪ every vendor of avail-vendors.json (portfolio or supported);
 *              the manufacturer is written in its canonical form (rename map, aliases);
 *   scope    — Sony: only keepDeviceTypes; Netgear-AV: only models matching keepModelPattern;
 *   generic  — brands we do not carry: per deviceType one template becomes
 *              "Generic <type>" (genericTemplate), the rest go;
 *   drop     — everything else, and templates without a manufacturer.
 */
import decisionsJson from "../../docs/avail/vendor-decisions.json";
import { genericModelNumber, lintBlock, type BlockLevel } from "./blockLint";
import { defaultCategoryFor, findCategory, findVendor, GENERIC_VENDOR, VENDORS } from "./library";

export interface VendorDecisions {
  version: number;
  keep: string[];
  newSupportedVendors: string[];
  rename: Record<string, string>;
  generic: string[];
  scope: Record<string, { keepDeviceTypes?: string[]; keepModelPattern?: string; note?: string }>;
}

export const VENDOR_DECISIONS = decisionsJson as unknown as VendorDecisions;

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export type Classification =
  | { kind: "keep"; manufacturer: string; renamed: boolean }
  | { kind: "scope"; manufacturer: string; reason: string }
  | { kind: "generic"; manufacturer: string }
  | { kind: "drop"; manufacturer: string }
  | { kind: "none" };

export interface TemplateLike {
  manufacturer?: string | null;
  deviceType?: string | null;
  modelNumber?: string | null;
  label?: string | null;
}

export class VendorRules {
  private readonly rename = new Map<string, string>();
  private readonly keep = new Map<string, string>();
  private readonly generic = new Set<string>();
  private readonly scope = new Map<string, { keepDeviceTypes?: Set<string>; keepModelPattern?: RegExp }>();

  readonly decisions: VendorDecisions;

  constructor(decisions: VendorDecisions = VENDOR_DECISIONS) {
    this.decisions = decisions;
    for (const [from, to] of Object.entries(decisions.rename)) this.rename.set(key(from), to);
    for (const v of VENDORS) this.keep.set(key(v.name), v.name);
    for (const k of decisions.keep) if (!this.keep.has(key(k))) this.keep.set(key(k), k);
    for (const g of decisions.generic) this.generic.add(key(g));
    for (const [vendor, rule] of Object.entries(decisions.scope)) {
      this.scope.set(key(vendor), {
        keepDeviceTypes: rule.keepDeviceTypes ? new Set(rule.keepDeviceTypes) : undefined,
        keepModelPattern: rule.keepModelPattern ? new RegExp(rule.keepModelPattern, "i") : undefined,
      });
    }
  }

  /** Canonical spelling: rename map, then avail-vendors.json aliases, then the keep list. */
  canonical(manufacturer: string): string {
    const k = key(manufacturer);
    const renamed = this.rename.get(k);
    if (renamed) return renamed;
    const vendor = findVendor(manufacturer);
    if (vendor) return vendor.name;
    return this.keep.get(k) ?? manufacturer.trim().replace(/\s+/g, " ");
  }

  classify(t: TemplateLike): Classification {
    const raw = (t.manufacturer ?? "").trim();
    if (!raw) return { kind: "none" };
    const manufacturer = this.canonical(raw);
    const k = key(manufacturer);
    if (this.generic.has(key(raw)) || this.generic.has(k)) return { kind: "generic", manufacturer: raw };
    if (!this.keep.has(k)) return { kind: "drop", manufacturer: raw };
    const rule = this.scope.get(k);
    if (rule?.keepDeviceTypes && !rule.keepDeviceTypes.has(t.deviceType ?? "")) {
      return { kind: "scope", manufacturer, reason: `deviceType ${t.deviceType ?? "?"} is outside the ${manufacturer} scope` };
    }
    if (rule?.keepModelPattern) {
      const label = (t.label ?? "").trim();
      // The label without the brand in any spelling: "NETGEAR M4350-16V4C" → "M4350-16V4C".
      const spellings = [manufacturer, raw, ...(findVendor(manufacturer)?.aliases ?? [])].map(key).sort((a, b) => b.length - a.length);
      const hit = spellings.find((sp) => label.toLowerCase().startsWith(sp + " "));
      const bare = hit ? label.slice(hit.length + 1) : label;
      const candidates = [t.modelNumber ?? "", label, bare];
      if (!candidates.some((c) => rule.keepModelPattern!.test(c.trim()))) {
        return { kind: "scope", manufacturer, reason: `model ${t.modelNumber || label} is outside the ${manufacturer} scope` };
      }
    }
    return { kind: "keep", manufacturer, renamed: manufacturer !== raw };
  }
}

// ---- Generic templates

const UPPER_WORDS = new Set(["led", "ptz", "usb", "kvm", "dsp", "av", "pc", "tv", "ip", "ndi", "sdi", "hdmi", "poe", "ups", "da", "mtr", "ccu", "dmx", "rf", "ir", "lcd", "ups"]);

/** "led-processor" → "LED Processor", "tv" → "TV", "video-bar" → "Video Bar". */
export function deviceTypeTitle(deviceType: string): string {
  return deviceType
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (UPPER_WORDS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

/** Fields that describe one branded product and do not belong on a Generic template. */
const BRAND_FIELDS = [
  "referenceUrl", "imageUrl", "heightMm", "widthMm", "depthMm", "weightKg", "powerDrawW", "powerCapacityW", "voltage",
  "thermalBtuh", "poeDrawW", "poeBudgetW", "unitCost", "color",
] as const;

type Obj = Record<string, unknown>;

/**
 * The Generic form of a branded template (standard 2.2): "Generic <type>", GEN-<TYPE>,
 * category from deviceTypeDefaults (Other / Generic when there is none), no links, no
 * brand-specific physical data, search terms from the type only. Ports are kept.
 */
export function genericTemplate<T extends Obj>(t: T): T {
  const deviceType = String(t.deviceType ?? "device");
  const title = deviceTypeTitle(deviceType);
  const label = `${GENERIC_VENDOR} ${title}`;
  const out: Obj = { ...t };
  for (const f of BRAND_FIELDS) delete out[f];
  const def = defaultCategoryFor(deviceType);
  const cat = findCategory(def);
  Object.assign(out, {
    label,
    shortName: title,
    manufacturer: GENERIC_VENDOR,
    modelNumber: genericModelNumber(label),
    category: cat?.leaf && cat.schematic ? cat.path : "Other / Generic",
    searchTerms: [...new Set([title.toLowerCase(), deviceType, "generic"])],
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
  });
  return out as T;
}

const LEVEL_RANK: Record<BlockLevel, number> = { FIX: 0, B: 1, A: 2 };
const PHYSICAL = ["heightMm", "widthMm", "depthMm", "weightKg", "powerDrawW", "poeDrawW"];

/**
 * How complete a template is (genericRule): standard level first, then ports with a
 * connector, then filled physical fields, then the number of ports.
 */
export function completeness(t: Obj): number {
  const ports = Array.isArray(t.ports) ? (t.ports as Obj[]) : [];
  const withConnector = ports.filter((p) => typeof p.connectorType === "string" && p.connectorType !== "").length;
  const physical = PHYSICAL.filter((f) => typeof t[f] === "number" && (t[f] as number) > 0).length;
  return LEVEL_RANK[lintBlock(t).level] * 1_000_000 + withConnector * 1_000 + physical * 100 + Math.min(ports.length, 99);
}
