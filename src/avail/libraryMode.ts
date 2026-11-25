/**
 * AVAIL library mode in the editor: template statuses, the "show unverified" switch,
 * the signed-in user's role. No React here (hooks are in useAvail.ts).
 *
 * The mode turns on by itself: our API (api-avail) answers GET /templates with the
 * X-Avail-Library header. Against upstream's API nothing changes. The flag is kept in
 * localStorage so the next page load starts in the right mode before the first fetch.
 *
 *   verified — checked by AVAIL; draft — being worked on; raw — not checked; hidden — mods only.
 */
import type { DeviceTemplate } from "../types";

export type TemplateStatus = "verified" | "draft" | "raw" | "hidden";
export type UserRole = "contributor" | "moderator" | "admin" | string;

export const AVAIL_LIBRARY_HEADER = "X-Avail-Library";
const KEY_MODE = "avail.library";
const KEY_SHOW_UNVERIFIED = "avail.library.showUnverified";
const KEY_PORTS_FILTER = "avail.library.portsFilter";

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* private mode, blocked storage: the setting lives for this page only */
  }
}

let active = read(KEY_MODE) === "1";
let showUnverified = read(KEY_SHOW_UNVERIFIED) === "1";
let role: UserRole | null = null;
let statuses = new Map<string, TemplateStatus>();
let statusesLoaded = false;

// ---- change notification (useSyncExternalStore + library reloads)
let version = 0;
const listeners = new Set<() => void>();
const reloaders = new Set<() => void>();

function emit(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVersion(): number {
  return version;
}

/** Library panels register here to refetch when statuses or the switch change. */
export function onLibraryChanged(reload: () => void): () => void {
  reloaders.add(reload);
  return () => reloaders.delete(reload);
}

export function notifyLibraryChanged(): void {
  for (const r of reloaders) r();
  emit();
}

// ---- mode and statuses

export function isAvailLibrary(): boolean {
  return active;
}

export function statusOfTemplate(t: unknown): TemplateStatus | null {
  const s = (t as { availStatus?: unknown } | null)?.availStatus;
  return s === "verified" || s === "draft" || s === "raw" || s === "hidden" ? s : null;
}

function recordStatuses(data: readonly DeviceTemplate[]): void {
  statuses = new Map();
  for (const t of data) {
    const s = statusOfTemplate(t);
    if (t.id && s) statuses.set(t.id, s);
  }
  statusesLoaded = true;
}

/** Called by templateApi with every fresh GET /templates answer. */
export function noteLibraryResponse(res: Response, data: readonly DeviceTemplate[]): void {
  const isAvail = res.headers.get(AVAIL_LIBRARY_HEADER) === "1";
  if (isAvail !== active) {
    active = isAvail;
    write(KEY_MODE, isAvail ? "1" : null);
  }
  if (isAvail) recordStatuses(data);
  else {
    statuses = new Map();
    statusesLoaded = false;
  }
  emit();
}

/** Called by templateApi when it falls back to the last-good cached library. */
export function noteCachedLibrary(data: readonly DeviceTemplate[]): void {
  if (!active) return;
  recordStatuses(data);
  emit();
}

/**
 * Status of the library template a block on the schematic was made from. null — not an
 * AVAIL library, library not loaded yet, or a block without a template. A template the
 * loaded library does not list (raw while "show unverified" is off, or unknown) is raw.
 */
export function blockStatus(templateId: string | undefined | null): TemplateStatus | null {
  if (!active || !statusesLoaded || !templateId) return null;
  return statuses.get(templateId) ?? "raw";
}

/** Badge text, one whole string per status (ready for a translation table): verified has none. */
export const STATUS_BADGES: Readonly<Record<TemplateStatus, string | null>> = {
  verified: null,
  draft: "Draft",
  raw: "Unverified",
  hidden: "Hidden",
};

export function statusBadge(status: TemplateStatus | null): string | null {
  return status ? STATUS_BADGES[status] : null;
}

// ---- "show unverified" and role

export function getShowUnverified(): boolean {
  return showUnverified;
}

export function setShowUnverified(value: boolean): void {
  if (value === showUnverified) return;
  showUnverified = value;
  write(KEY_SHOW_UNVERIFIED, value ? "1" : null);
  notifyLibraryChanged();
}

export function getRole(): UserRole | null {
  return role;
}

export function setRole(value: UserRole | null): void {
  if (value === role) return;
  const wasMod = isModerator();
  role = value;
  emit();
  // Moderators also get hidden templates when "show unverified" is on.
  if (wasMod !== isModerator() && showUnverified) notifyLibraryChanged();
}

export function isModerator(): boolean {
  return role === "moderator" || role === "admin";
}

/** Query string for GET /templates: verified + draft by default. */
export function libraryQuery(): string {
  if (!showUnverified) return "";
  return isModerator() ? "?include=raw,hidden" : "?include=raw";
}

// ---- filter by the source of the ports (moderators): the review queue

/**
 * all — no filter; manufacturer / community / none — by availPortsOrigin (api-avail,
 * src/avail/portsOrigin.ts); review — the engineers' queue: draft, community ports, level B.
 */
export type PortsFilter = "all" | "manufacturer" | "community" | "none" | "review";
export const PORTS_FILTERS: readonly PortsFilter[] = ["all", "manufacturer", "community", "none", "review"];

/** Option text, one whole string per filter (ready for a translation table). */
export const PORTS_FILTER_LABELS: Readonly<Record<PortsFilter, string>> = {
  all: "Ports: any source",
  manufacturer: "Ports: manufacturer",
  community: "Ports: community",
  none: "Ports: no source",
  review: "Review queue: draft, community, level B",
};

function parsePortsFilter(v: string | null): PortsFilter {
  return (PORTS_FILTERS as readonly string[]).includes(v ?? "") ? (v as PortsFilter) : "all";
}

let portsFilter: PortsFilter = parsePortsFilter(read(KEY_PORTS_FILTER));

export function getPortsFilter(): PortsFilter {
  return portsFilter;
}

export function setPortsFilter(value: PortsFilter): void {
  if (value === portsFilter) return;
  portsFilter = value;
  write(KEY_PORTS_FILTER, value === "all" ? null : value);
  emit();
}

/** availPortsOrigin of a library template; templates the API did not mark count as none. */
export function portsOriginOfTemplate(t: unknown): "manufacturer" | "community" | "none" {
  const o = (t as { availPortsOrigin?: unknown } | null)?.availPortsOrigin;
  return o === "manufacturer" || o === "community" ? o : "none";
}

function levelOfTemplate(t: unknown): string | null {
  const l = (t as { availLevel?: unknown } | null)?.availLevel;
  return typeof l === "string" ? l : null;
}

/** The library list under the ports filter; only moderators in AVAIL mode filter. */
export function filterByPortsOrigin<T>(
  list: readonly T[],
  filter: PortsFilter = portsFilter,
  who: { active: boolean; moderator: boolean } = { active, moderator: isModerator() },
): readonly T[] {
  if (!who.active || !who.moderator || filter === "all") return list;
  if (filter === "review") {
    return list.filter((t) => statusOfTemplate(t) === "draft" && portsOriginOfTemplate(t) === "community" && levelOfTemplate(t) === "B");
  }
  return list.filter((t) => portsOriginOfTemplate(t) === filter);
}

// ---- selection for bulk actions (moderators)

let selectMode = false;
let selected = new Set<string>();

export function isSelectMode(): boolean {
  return selectMode;
}

export function setSelectMode(value: boolean): void {
  if (value === selectMode) return;
  selectMode = value;
  if (!value) selected = new Set();
  emit();
}

export function isSelected(templateId: string): boolean {
  return selected.has(templateId);
}

export function toggleSelected(templateId: string, value = !selected.has(templateId)): void {
  if (value === selected.has(templateId)) return;
  selected = new Set(selected);
  if (value) selected.add(templateId);
  else selected.delete(templateId);
  emit();
}

export function getSelected(): string[] {
  return [...selected];
}

export function clearSelection(): void {
  if (selected.size === 0) return;
  selected = new Set();
  emit();
}

/** Test helper: back to a fresh page load. */
export function resetForTests(): void {
  active = read(KEY_MODE) === "1";
  showUnverified = read(KEY_SHOW_UNVERIFIED) === "1";
  portsFilter = parsePortsFilter(read(KEY_PORTS_FILTER));
  role = null;
  statuses = new Map();
  statusesLoaded = false;
  selectMode = false;
  selected = new Set();
  listeners.clear();
  reloaders.clear();
}
