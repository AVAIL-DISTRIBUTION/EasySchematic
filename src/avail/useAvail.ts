/**
 * React side of src/avail/libraryMode.ts.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fetchLibraryTemplate, loadRole } from "./api";
import { startEditSession } from "./templateEdit";
import { useSchematicStore } from "../store";
import {
  filterByPortsOrigin,
  getPortsFilter,
  getRole,
  getSelected,
  isSelectMode,
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
    selectMode: isSelectMode(),
    selected: getSelected(),
    portsFilter: getPortsFilter(),
  };
}

/** The library list under the moderator's ports filter (unchanged for everyone else). */
export function useAvailFilteredTemplates<T>(list: readonly T[]): readonly T[] {
  const { portsFilter, moderator, active } = useAvailState();
  return useMemo(() => filterByPortsOrigin(list, portsFilter, { active, moderator }), [list, portsFilter, moderator, active]);
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

/**
 * Opens upstream's Device Editor on a provisional copy of the stored template (see
 * templateEdit.ts). Returns the starter and the last error.
 */
export function useStartTemplateEdit(): { start: (templateId: string) => Promise<boolean>; error: string | null; busy: boolean } {
  const createAndEditDevice = useSchematicStore((s) => s.createAndEditDevice);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = useCallback(
    async (templateId: string) => {
      setBusy(true);
      setError(null);
      try {
        const template = await fetchLibraryTemplate(templateId);
        createAndEditDevice(template, { x: 0, y: 0 });
        const nodeId = useSchematicStore.getState().creatingNodeId;
        if (!nodeId) throw new Error("The device editor did not open");
        startEditSession(nodeId, template);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [createAndEditDevice],
  );
  return { start, error, busy };
}
