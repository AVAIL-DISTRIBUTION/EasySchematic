/**
 * AVAIL build: header color of a newly placed device by the top-level group of its
 * accounting-system category (docs/avail/avail-taxonomy.json, `group`).
 *
 * Precedence (stamped once at placement, like upstream's #354 chain):
 *   project preset color > template color > group color > project default > app default.
 *
 * Muted mid-dark tones, so the header text stays readable (DeviceNode picks white or
 * black text by contrast) and the headers do not compete with the signal line colors.
 * "Other" has no group color and falls through to the defaults.
 */
import type { DeviceTemplate } from "../types";
import { normalizeHeaderColor } from "../deviceHeaderColor";
import { isAvailBuild } from "./brand";
import { TAXONOMY, findCategory } from "./library";

export const GROUP_HEADER_COLORS: Readonly<Record<string, string>> = {
  "AV distribution": "#5b4a8b",
  "Audio Products": "#9a5b2e",
  Connectivity: "#5f6b78",
  "Control Systems": "#2f6f68",
  Displays: "#38598a",
  "Integration Tools": "#6f6553",
  "Lighting equipment": "#8a7228",
  Microphones: "#8e4a3e",
  Mounts: "#5a6650",
  Networking: "#22667f",
  Processing: "#734a73",
  Projection: "#4f6596",
  "Streaming and Recording": "#94485a",
  UC: "#3c7350",
  Videocameras: "#7d3d63",
};

const GROUPS = [...new Set(TAXONOMY.categories.map((c) => c.group))];

/**
 * Top-level group of a category path ("AV distribution / Extenders" → "AV distribution").
 * Only "Group / Category" paths count: a bare name such as upstream's "Processing" or
 * "Networking" category is not ours, even when it reads like one of our groups.
 */
export function groupOfCategory(category: string | null | undefined): string | undefined {
  if (!category || !category.includes("/")) return undefined;
  const known = findCategory(category);
  if (known) return known.group;
  const head = category.split("/")[0].trim();
  return GROUPS.find((g) => g.toLowerCase() === head.toLowerCase());
}

/** Header color for a category's group; undefined outside the AVAIL build or without a group color. */
export function groupHeaderColor(category: string | null | undefined, avail: boolean = isAvailBuild()): string | undefined {
  if (!avail) return undefined;
  const group = groupOfCategory(category);
  return group ? GROUP_HEADER_COLORS[group] : undefined;
}

/**
 * The template's rung of the header-color chain: its own saved color, else (AVAIL build)
 * its category group's color. Upstream builds get the template color alone.
 */
export function templateHeaderColor(
  template: Pick<DeviceTemplate, "headerColor" | "category"> | undefined,
  avail: boolean = isAvailBuild(),
): string | undefined {
  if (!template) return undefined;
  return normalizeHeaderColor(template.headerColor) ?? groupHeaderColor(template.category, avail);
}
