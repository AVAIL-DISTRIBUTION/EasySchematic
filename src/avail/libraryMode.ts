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

/** Badge text: verified — none, draft — «черновик», raw — «не проверен», hidden — «скрыт». */
export function statusBadge(status: TemplateStatus | null): string | null {
  if (status === "draft") return "черновик";
  if (status === "raw") return "не проверен";
  if (status === "hidden") return "скрыт";
  return null;
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

/** Test helper: back to a fresh page load. */
export function resetForTests(): void {
  active = read(KEY_MODE) === "1";
  showUnverified = read(KEY_SHOW_UNVERIFIED) === "1";
  role = null;
  statuses = new Map();
  statusesLoaded = false;
  listeners.clear();
  reloaders.clear();
}
