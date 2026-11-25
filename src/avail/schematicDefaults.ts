/**
 * AVAIL build: what a new schematic starts with. Every value is an ordinary schematic
 * setting the engineer can change afterwards (Colors panel, Title Block, Print View).
 *
 *   - signal palette: video magenta, Ethernet blue, Dante/AVB green, USB dark gray,
 *     analog and speaker-level audio orange, fiber gray dashed;
 *   - title block: company AVAIL DISTRIBUTION, FZCO (a Company row on top of upstream's
 *     layout, which has none), engineer = the signed-in user, today;
 *   - sheet: A3 landscape.
 *
 * The first visit opens an empty sheet with these settings instead of upstream's demo.
 */
import type { LineStyle, SignalType, TitleBlock, TitleBlockLayout } from "../types";
import { createDefaultLayout } from "../titleBlockLayout";
import { AVAIL_COMPANY, isAvailBuild } from "./brand";
import { displayNameOf, getSignedInUser, type SessionUser } from "./session";

const VIDEO = "#aa00aa";
const ETHERNET = "#0055cc";
const AUDIO_NETWORK = "#007700";
const USB = "#333333";
const ANALOG_AUDIO = "#cc6600";
const FIBER = "#808080";

/**
 * Line colors by signal type. PoE is not a signal type in the editor (it is a port
 * property on Ethernet ports), so PoE links take the Ethernet color.
 */
export const AVAIL_SIGNAL_COLORS: Readonly<Partial<Record<SignalType, string>>> = {
  // video
  hdmi: VIDEO,
  hdbaset: VIDEO,
  dxlink: VIDEO,
  sdi: VIDEO,
  displayport: VIDEO,
  dvi: VIDEO,
  vga: VIDEO,
  composite: VIDEO,
  "component-video": VIDEO,
  "s-video": VIDEO,
  // networks
  ethernet: ETHERNET,
  dante: AUDIO_NETWORK,
  avb: AUDIO_NETWORK,
  aes67: AUDIO_NETWORK,
  // USB
  usb: USB,
  // audio
  "analog-audio": ANALOG_AUDIO,
  "speaker-level": ANALOG_AUDIO,
  // fiber (dashed, below)
  fiber: FIBER,
};

export const AVAIL_SIGNAL_LINE_STYLES: Readonly<Partial<Record<SignalType, LineStyle>>> = {
  fiber: "dashed",
};

export const AVAIL_PAPER_ID = "iso-a3";
export const AVAIL_ORIENTATION = "landscape" as const;

/** Local date as YYYY-MM-DD (the format the title block suggests). */
export function isoLocalDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function availTitleBlock(user: SessionUser | null, now: Date): TitleBlock {
  return {
    showName: "",
    venue: "",
    designer: "",
    engineer: displayNameOf(user),
    date: isoLocalDate(now),
    drawingTitle: "",
    company: AVAIL_COMPANY,
    revision: "",
    logo: "",
    customFields: [],
  };
}

/** Upstream's default title block layout with a Company row on top. */
export function availTitleBlockLayout(): TitleBlockLayout {
  const base = createDefaultLayout();
  const rowCount = base.rows.length + 1;
  const top = base.cells.find((c) => c.row === 0) ?? base.cells[0];
  const company = {
    ...top,
    id: "avail-company",
    row: 0,
    col: 0,
    colSpan: base.columns.length,
    rowSpan: 1,
    content: { type: "field" as const, field: "company" },
    fontSize: 8,
    fontWeight: "bold" as const,
    align: "center" as const,
  };
  return {
    ...base,
    rows: Array.from({ length: rowCount }, () => 1 / rowCount),
    heightIn: (base.heightIn * rowCount) / base.rows.length,
    cells: [company, ...base.cells.map((c) => ({ ...c, row: c.row + 1 }))],
  };
}

export interface AvailNewSchematicDefaults {
  /** Applied with the store's setSignalColors (also updates the CSS variables). */
  signalColors: Partial<Record<SignalType, string>>;
  signalLineStyles: Partial<Record<SignalType, LineStyle>>;
  /** Plain store fields for a blank schematic. */
  state: {
    titleBlock: TitleBlock;
    titleBlockLayout: TitleBlockLayout;
    printPaperId: string;
    printOrientation: typeof AVAIL_ORIENTATION;
  };
}

/** Defaults for a blank schematic in the AVAIL build; null in upstream builds. */
export function availNewSchematicDefaults(
  options: { avail?: boolean; user?: SessionUser | null; now?: Date } = {},
): AvailNewSchematicDefaults | null {
  if (!(options.avail ?? isAvailBuild())) return null;
  const user = options.user === undefined ? getSignedInUser() : options.user;
  return {
    signalColors: { ...AVAIL_SIGNAL_COLORS },
    signalLineStyles: { ...AVAIL_SIGNAL_LINE_STYLES },
    state: {
      titleBlock: availTitleBlock(user, options.now ?? new Date()),
      titleBlockLayout: availTitleBlockLayout(),
      printPaperId: AVAIL_PAPER_ID,
      printOrientation: AVAIL_ORIENTATION,
    },
  };
}

/** AVAIL build: the first visit opens an empty sheet, not upstream's demo schematic. */
export function skipDemoSchematic(avail: boolean = isAvailBuild()): boolean {
  return avail;
}
