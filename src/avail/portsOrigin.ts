/**
 * Where a template's ports come from, for approving by source and the library's review queue:
 *
 *   manufacturer — the manufacturer's own documents: an Extron stencil, a data sheet, the
 *                  curated library (library/avail), or a catalog variant of such a template;
 *   community    — the community database (easyschematic.live import, or catalog ports taken
 *                  from the database snapshot), or a variant of such a template;
 *   none         — nothing recorded (catalog card without ports or without portsSource,
 *                  templates made in the editor).
 *
 * Input is the template's meta: its source and the catalog JSON import:catalog stored
 * (avail_template_meta.catalog: the file path and the catalog file's _avail). A variant points
 * at another catalog file; that file's source decides. Pure, no Node or browser dependencies.
 */
export type PortsOrigin = "manufacturer" | "community" | "none";
export const PORTS_ORIGINS: readonly PortsOrigin[] = ["manufacturer", "community", "none"];

/** portsSource kinds that are the manufacturer's documents. */
export const MANUFACTURER_KINDS: ReadonlySet<string> = new Set(["stencil", "datasheet", "library"]);

/** Meta source of templates loaded from library/avail and from easyschematic.live. */
const CURATED_SOURCE = "avail-library";
const UPSTREAM_SOURCE = "easyschematic.live";

export interface CatalogMeta {
  file?: string;
  portsSource?: { kind?: string; from?: string; label?: string } | null;
  [k: string]: unknown;
}

export interface PortsOriginInfo {
  origin: PortsOrigin;
  /** portsSource.kind of the template ("stencil", "db", "variant"…), or "library" / "upstream". */
  kind?: string;
  /** The document: stencil file, data sheet URL, library file, database template id. */
  from?: string;
  /** For a variant: the catalog file it copied and that file's own source. */
  via?: { file: string; kind?: string };
}

/** Parses avail_template_meta.catalog; null when absent or not JSON. */
export function parseCatalogMeta(json: string | null | undefined): CatalogMeta | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as CatalogMeta) : null;
  } catch {
    return null;
  }
}

function classify(kind: string | undefined): PortsOrigin {
  if (!kind) return "none";
  if (MANUFACTURER_KINDS.has(kind)) return "manufacturer";
  if (kind === "db") return "community";
  return "none";
}

/**
 * Origin of a template's ports. `catalogByFile` holds the catalog meta of every loaded catalog
 * file by its path, to follow a variant to the template it copied (one step: a variant's donor
 * is never a variant itself).
 */
export function portsOrigin(
  meta: { source?: string | null; catalog?: CatalogMeta | null },
  catalogByFile: ReadonlyMap<string, CatalogMeta>,
): PortsOriginInfo {
  if (meta.source === CURATED_SOURCE) return { origin: "manufacturer", kind: "library" };
  const src = meta.catalog?.portsSource;
  if (meta.catalog) {
    const kind = src?.kind;
    if (kind === "variant") {
      const file = src?.from ?? "";
      const donor = catalogByFile.get(file)?.portsSource;
      return {
        origin: classify(donor?.kind),
        kind,
        ...(donor?.from ? { from: donor.from } : {}),
        via: { file, ...(donor?.kind ? { kind: donor.kind } : {}) },
      };
    }
    return { origin: classify(kind), ...(kind ? { kind } : {}), ...(src?.from ? { from: src.from } : {}) };
  }
  if (meta.source === UPSTREAM_SOURCE) return { origin: "community", kind: "upstream" };
  return { origin: "none" };
}

/** Index of catalog meta by file path. */
export function catalogIndex(metas: Iterable<CatalogMeta | null>): Map<string, CatalogMeta> {
  const out = new Map<string, CatalogMeta>();
  for (const m of metas) if (m?.file) out.set(m.file, m);
  return out;
}

/** Human-readable source for a status reason: "stencil (DTP - …vssx)", "datasheet (https://…) via variant extron/x.json". */
export function describeOrigin(info: PortsOriginInfo): string {
  const kind = info.via ? (info.via.kind ?? "unknown") : (info.kind ?? "unknown");
  const doc = info.from ? ` (${info.from})` : "";
  return info.via ? `${kind}${doc} via variant ${info.via.file}` : `${kind}${doc}`;
}
