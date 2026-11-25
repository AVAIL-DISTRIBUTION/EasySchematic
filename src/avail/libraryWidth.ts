/**
 * AVAIL build: width of the device library panel, dragged with the mouse and remembered
 * per user in this browser (localStorage key per signed-in user id).
 */
import { getSignedInUser } from "./session";

export const LIBRARY_WIDTH_MIN = 200;
export const LIBRARY_WIDTH_MAX = 560;
/** Wider than upstream's 224px: taxonomy group and category names are long. */
export const LIBRARY_WIDTH_DEFAULT = 280;
/** The panel never takes more than this share of the window. */
const MAX_SHARE_OF_VIEWPORT = 0.5;

/** Width kept within [min, max] and within half the window; junk gives the default. */
export function clampLibraryWidth(width: number, viewportWidth?: number): number {
  if (!Number.isFinite(width)) return LIBRARY_WIDTH_DEFAULT;
  let max = LIBRARY_WIDTH_MAX;
  if (viewportWidth && Number.isFinite(viewportWidth)) {
    max = Math.max(LIBRARY_WIDTH_MIN, Math.min(max, Math.floor(viewportWidth * MAX_SHARE_OF_VIEWPORT)));
  }
  return Math.round(Math.min(max, Math.max(LIBRARY_WIDTH_MIN, width)));
}

export function libraryWidthKey(userId: string | null | undefined): string {
  return `avail.libraryWidth.${userId || "anonymous"}`;
}

export function loadLibraryWidth(userId: string | null | undefined = getSignedInUser()?.id): number {
  try {
    const raw = globalThis.localStorage?.getItem(libraryWidthKey(userId));
    if (raw !== null && raw !== undefined && raw !== "") return clampLibraryWidth(Number(raw));
  } catch {
    /* storage blocked */
  }
  return LIBRARY_WIDTH_DEFAULT;
}

export function saveLibraryWidth(width: number, userId: string | null | undefined = getSignedInUser()?.id): void {
  try {
    globalThis.localStorage?.setItem(libraryWidthKey(userId), String(clampLibraryWidth(width)));
  } catch {
    /* storage blocked: the width lives for this page only */
  }
}
