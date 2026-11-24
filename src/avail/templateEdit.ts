/**
 * Editing a library template from the AVAIL review flow with upstream's Device Editor.
 *
 * The editor works on a device on the canvas, so "Edit" places a provisional copy of the
 * template (store.createAndEditDevice, the same path as "create device") and remembers
 * here that this node is an edit session for template X. The editor shows
 * AvailTemplateEditBar (live linter, "Save to library"); saving turns the form back into
 * a template (deviceDataToTemplate) and PUTs it to /templates/:id. Closing the editor
 * discards the provisional copy, as upstream does for any unapplied new device.
 *
 * A session ends on save. One left by a cancelled editor is harmless: its node was
 * discarded, and node ids are never reused. (Ending it in an effect cleanup would break
 * under React StrictMode, which runs cleanups on mount in development.)
 *
 * No React here.
 */
import type { DeviceTemplate } from "../types";

/** Template fields the Device Editor form shows: the form is the source for these. */
export const EDITOR_TEMPLATE_FIELDS = [
  "label", "shortName", "deviceType", "category", "manufacturer", "modelNumber", "referenceUrl", "color",
  "searchTerms", "hostname", "powerDrawW", "powerCapacityW", "voltage", "thermalBtuh", "poeBudgetW", "poeDrawW",
  "unitCost", "heightMm", "widthMm", "depthMm", "weightKg", "isVenueProvided", "auxiliaryData",
] as const;

/** Fields of a library answer that are not template data. */
const NOT_TEMPLATE_DATA = ["id", "version", "availStatus"];

type Obj = Record<string, unknown>;

/**
 * The template to save from the editor's device data. Editor fields come from the form
 * (a field cleared in the form is removed); everything the form does not show (slot
 * definitions, slot family, image…) is kept from the stored template. Ports of cards
 * installed in the provisional copy's slots belong to the cards and are left out.
 */
export function deviceDataToTemplate(
  data: Obj,
  original: DeviceTemplate,
  slotPortIds: ReadonlySet<string> = new Set(),
): Omit<DeviceTemplate, "id" | "version"> {
  const out: Obj = { ...(original as unknown as Obj) };
  for (const k of NOT_TEMPLATE_DATA) delete out[k];
  for (const k of EDITOR_TEMPLATE_FIELDS) {
    const v = data[k];
    if (v === undefined || v === null || v === "") delete out[k];
    else out[k] = v;
  }
  const ports = Array.isArray(data.ports) ? (data.ports as Obj[]) : [];
  out.ports = ports.filter((p) => !slotPortIds.has(String(p.id)));
  return out as unknown as Omit<DeviceTemplate, "id" | "version">;
}

export interface EditSession {
  templateId: string;
  /** The template as loaded from the API when the session started. */
  original: DeviceTemplate;
}

const sessions = new Map<string, EditSession>();

/** Marks a canvas node as the provisional copy for editing a library template. */
export function startEditSession(nodeId: string, original: DeviceTemplate): void {
  if (!original.id) throw new Error("template has no id");
  sessions.set(nodeId, { templateId: original.id, original });
}

export function editSessionFor(nodeId: string | null | undefined): EditSession | undefined {
  return nodeId ? sessions.get(nodeId) : undefined;
}

export function endEditSession(nodeId: string): void {
  sessions.delete(nodeId);
}

/**
 * Device data with a (normalized) template's editor fields written over it, for the Normalize
 * button: the canvas copy takes the normalized values and the editor re-reads its form. Node-only
 * fields (templateId, hidden ports, notes…) are kept; a field the template no longer has is removed.
 */
export function applyTemplateToDeviceData(data: Obj, template: Obj): Obj {
  const out: Obj = { ...data };
  for (const k of EDITOR_TEMPLATE_FIELDS) {
    if (template[k] === undefined || template[k] === null || template[k] === "") delete out[k];
    else out[k] = template[k];
  }
  if (Array.isArray(template.ports)) out.ports = template.ports;
  return out;
}
