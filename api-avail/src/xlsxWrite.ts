/**
 * Minimal .xlsx writer (no dependencies): one sheet of strings and numbers, a bold header row,
 * column widths. The counterpart of xlsx.ts (reader) for reports engineers open in Excel.
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of the given files (deflated). */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(8, 8); // deflate
    h.writeUInt32LE(0, 10); // time, date
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(f.data.length, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    local.push(h, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** .xlsx with one sheet: the header row (bold) and the rows; widths in characters per column. */
export function writeXlsx(sheetName: string, header: readonly string[], rows: readonly (string | number)[][], widths: readonly number[] = []): Buffer {
  const cell = (v: string | number, ref: string, style = 0) =>
    typeof v === "number"
      ? `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  const all = [header as readonly (string | number)[], ...rows];
  const sheetRows = all
    .map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(v, `${colName(j)}${i + 1}`, i === 0 ? 1 : 2)).join("")}</row>`)
    .join("");
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `${cols}<sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${colName(header.length - 1)}${all.length}"/></worksheet>`;
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${esc(sheetName)}'!$A$1:$${colName(header.length - 1)}$${all.length}</definedName></definedNames></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "utf8") })));
}
