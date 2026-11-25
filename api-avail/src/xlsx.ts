/**
 * Minimal .xlsx reader (no dependencies): sheets as rows of cell strings.
 *
 * An .xlsx file is a zip archive of XML parts. This reads the zip central directory, inflates
 * the parts it needs (node:zlib), resolves shared strings and returns each sheet's cells by
 * row. Enough for engineers' worklists: text and numbers, no formulas evaluated (the cached
 * value is used), no styles.
 */
import { inflateRawSync } from "node:zlib";

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  // End of central directory: signature 0x06054b50, searched from the end (comment up to 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("broken zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, { name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): string {
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`broken zip entry ${e.name}`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data.toString("utf8");
  if (e.method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`unsupported zip compression ${e.method} in ${e.name}`);
}

/** Text parts of a zip archive (.xlsx, .vssx): name → content; `only` filters the names. */
export function readZipText(buf: Buffer, only: (name: string) => boolean = () => true): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of zipEntries(buf).values()) if (only(e.name)) out.set(e.name, readEntry(buf, e));
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** Text of an <si> / <is> element: all <t> runs joined (rich text keeps its plain text). */
function runText(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join("");
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export type Sheet = string[][];

/** Every sheet of the workbook by name: rows of cell strings (empty cells are ""). */
export function readXlsx(buf: Buffer): Map<string, Sheet> {
  const entries = zipEntries(buf);
  const part = (name: string) => {
    const e = entries.get(name);
    return e ? readEntry(buf, e) : undefined;
  };
  const shared = [...(part("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]));
  const workbook = part("xl/workbook.xml") ?? "";
  const rels = part("xl/_rels/workbook.xml.rels") ?? "";
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1] ?? "";
    const t = /\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? "";
    return [id, t.startsWith("/") ? t.slice(1) : `xl/${t}`];
  }));
  const sheets = new Map<string, Sheet>();
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescapeXml(/\bname="([^"]+)"/.exec(m[0])?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
    const xml = part(target.get(rid) ?? "") ?? "";
    const rows: Sheet = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNo = Number(/\br="(\d+)"/.exec(r[0])?.[1] ?? rows.length + 1) - 1;
      const cells: string[] = [];
      for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "";
        const body = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let text = "";
        if (type === "s" && v !== undefined) text = shared[Number(v)] ?? "";
        else if (type === "inlineStr") text = runText(body);
        else if (v !== undefined) text = unescapeXml(v);
        const col = ref ? columnIndex(ref) : cells.length;
        while (cells.length < col) cells.push("");
        cells[col] = text;
      }
      while (rows.length < rowNo) rows.push([]);
      rows[rowNo] = cells;
    }
    sheets.set(name, rows);
  }
  return sheets;
}

/** Rows of a sheet as objects keyed by the header row (first non-empty row). */
export function sheetObjects(sheet: Sheet): Record<string, string>[] {
  const headerAt = sheet.findIndex((r) => r.some((c) => c.trim()));
  if (headerAt < 0) return [];
  const header = sheet[headerAt].map((h) => h.trim());
  return sheet
    .slice(headerAt + 1)
    .filter((r) => r.some((c) => c && c.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}
