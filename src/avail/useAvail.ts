/**
 * React side of src/avail/libraryMode.ts.
 */
import { useEffect, useSyncExternalStore } from "react";
import { loadRole } from "./api";
import {
  getRole,
  getShowUnverified,
  getVersion,
  isAvailLibrary,
  isModerator,
  onLibraryChanged,
  subscribe,
} from "./libraryMode";
import { invalidateTemplates } from "../templateApi";

/** Re-renders on any AVAIL library state change. */
export function useAvailState() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return {
    active: isAvailLibrary(),
    showUnverified: getShowUnverified(),
    role: getRole(),
    moderator: isModerator(),
  };
}

/**
 * For a library panel: refetch through `load` when statuses or the switch change
 * (the template cache is dropped first), and learn the user's role once.
 */
export function useAvailLibraryReload(load: () => void): void {
  useEffect(() => {
    void loadRole();
    return onLibraryChanged(() => {
      invalidateTemplates();
      load();
    });
  }, [load]);
}
