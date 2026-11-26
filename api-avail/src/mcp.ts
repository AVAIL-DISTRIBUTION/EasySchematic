/**
 * Remote MCP server of the AVAIL library (step 2.6): POST /mcp (/api/mcp behind Caddy), MCP
 * Streamable HTTP, stateless — every POST carries one JSON-RPC message (or a batch) and gets a JSON
 * answer; no session, no server-sent stream (GET and DELETE: 405).
 *
 * Sign-in: an AI Assistant access token only (Authorization: Bearer avail_ai_…, accessTokens.ts);
 * without one: 401. The tools call the API's own routes as the token's user (server.ts hands in
 * `call`), so the role's rights, the duplicate check (409 with a link) and the audit log apply as
 * in the UI. Reading is not logged; creating is (draft: "created", proposal: "proposed", with the
 * token's name).
 *
 * Tools: search_templates, get_template, lint_template, normalize_template, create_draft_template,
 * propose_change, review_queue, possible_duplicates, audit_log. Answers are compact JSON.
 */
import type Database from "better-sqlite3";
import { auditChanges, type AuditRecord } from "../../src/avail/auditText";
import { describeChange, portLabelMap, portsBySection } from "../../src/avail/libraryView";
import type { NormalizeChange } from "../../src/avail/normalize";
import { buildRows, builtInFilters, EMPTY_FILTER, filterRows, type WsFilter, type WsRow, type WsTemplate } from "../../src/avail/workspaceModel";
import { applyTemplatePatch, describeEditChanges, editChanges, NO_CHANGE_ERROR, noChanges, storedForm } from "../../src/avail/templatePatch";
import { writeAudit } from "./audit";

export const MCP_PATH = "/mcp";
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SERVER_INFO = { name: "avail-library", title: "AVAIL device library", version: "1.0.0" };

export interface McpContext {
  /** A request to this API as the token's user: path with query, e.g. "/avail/audit?limit=5". */
  call: (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Response>;
  token: { name: string; userId: string; email: string };
  sqlite: Database.Database;
  /** The app's public origin for links (https://sch.avail-int.com), or "" for relative links. */
  appOrigin: string;
}

type Json = Record<string, unknown>;
type ToolResult = { data: unknown; isError?: boolean };

class ToolError extends Error {
  constructor(
    message: string,
    readonly extra: Json = {},
  ) {
    super(message);
  }
}

class InvalidParams extends Error {}

// ---------------------------------------------------------------------------- arguments

const str = (a: Json, k: string): string | undefined => {
  const v = a[k];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new InvalidParams(`${k} must be a string`);
  return v;
};
const int = (a: Json, k: string, def: number, min: number, max: number): number => {
  const v = a[k];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new InvalidParams(`${k} must be an integer from ${min} to ${max}`);
  return v;
};
const oneOf = <T extends string>(a: Json, k: string, values: readonly T[]): T | undefined => {
  const v = str(a, k);
  if (v !== undefined && !(values as readonly string[]).includes(v)) throw new InvalidParams(`${k} must be one of ${values.join(", ")}`);
  return v as T | undefined;
};
const obj = (a: Json, k: string): Json => {
  const v = a[k];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InvalidParams(`${k} must be an object (a device template)`);
  return v as Json;
};

// ---------------------------------------------------------------------------- library data

const STATUSES = ["verified", "draft", "raw", "hidden"] as const;
const LEVELS = ["A", "B", "FIX"] as const;
const ORIGINS = ["manufacturer", "community", "none"] as const;

/** Workspace rows, rebuilt only when the library or the audit log changed (ETag). */
let cache: { etag: string; rows: WsRow[] } | null = null;

async function libraryRows(ctx: McpContext): Promise<WsRow[]> {
  const res = await ctx.call("/avail/workspace/templates", { headers: cache ? { "If-None-Match": cache.etag } : {} });
  if (res.status === 304 && cache) return cache.rows;
  if (!res.ok) throw new ToolError(await errorText(res));
  const body = (await res.json()) as { templates: WsTemplate[] };
  const rows = buildRows(body.templates);
  const etag = res.headers.get("ETag");
  cache = etag ? { etag, rows } : null;
  return rows;
}

/** For tests: forget the cached rows. */
export function resetMcpCache(): void {
  cache = null;
}

async function errorText(res: Response): Promise<string> {
  const b = (await res.json().catch(() => ({}))) as { error?: string };
  return b.error ?? `HTTP ${res.status}`;
}

const link = (ctx: McpContext, id: string) => `${ctx.appOrigin}/library?template=${encodeURIComponent(id)}`;

/** One line of a list: what an assistant needs to pick a template. */
function brief(r: WsRow) {
  return {
    id: r.id,
    label: r.template.label,
    part: r.partNumber || undefined,
    category: r.category || undefined,
    type: r.deviceType,
    status: r.status,
    level: r.level,
    ports: r.template.avail.portsOrigin,
  };
}

function page<T>(items: readonly T[], a: Json) {
  const offset = int(a, "offset", 0, 0, 1_000_000);
  const limit = int(a, "limit", 25, 1, 100);
  return { total: items.length, offset, items: items.slice(offset, offset + limit) };
}

function searchFilter(a: Json): { filter: WsFilter; rule?: string } {
  const vendor = str(a, "vendor");
  const category = str(a, "category");
  const type = str(a, "device_type");
  const status = oneOf(a, "status", STATUSES);
  const level = oneOf(a, "level", LEVELS);
  const origin = oneOf(a, "ports_source", ORIGINS);
  return {
    filter: {
      ...EMPTY_FILTER,
      vendors: vendor ? [vendor] : [],
      categories: category ? [category] : [],
      deviceTypes: type ? [type] : [],
      statuses: status ? [status] : [],
      levels: level ? [level] : [],
      origins: origin ? [origin] : [],
      text: str(a, "text") ?? "",
    },
    rule: str(a, "lint_rule")?.toLowerCase(),
  };
}

const matchVendor = (rows: WsRow[], vendor?: string) => (vendor ? rows.filter((r) => r.vendor.toLowerCase() === vendor.toLowerCase()) : rows);

/** The template as stored (get_template raw): every data field, ports with ids; no workspace data. */
function rawTemplate(t: WsRow["template"]): Json {
  const { avail: _a, ...raw } = t as unknown as Json & { avail?: unknown };
  return raw;
}

function historyEntry(r: AuditRecord) {
  return { at: r.at, actor: r.actor, token: r.token ?? undefined, action: r.action, changes: auditChanges(r) };
}

// ---------------------------------------------------------------------------- tools

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  readOnly: boolean;
  run: (args: Json, ctx: McpContext) => Promise<unknown>;
}

const TEMPLATE_SCHEMA = {
  type: "object",
  description: "Device template as in the library: label, manufacturer, modelNumber, deviceType, category, ports[], power, dimensions",
};
const PAGE_PROPS = {
  offset: { type: "integer", minimum: 0, description: "Items to skip (default 0)" },
  limit: { type: "integer", minimum: 1, maximum: 100, description: "Items to return (default 25)" },
};

export const TOOLS: readonly Tool[] = [
  {
    name: "search_templates",
    title: "Search templates",
    description:
      "Find library templates. All filters combine. Hidden templates only with status=hidden. Returns {total, offset, items[]}: id, label, part number, category, device type, status, lint level, ports origin.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Words in label, part number, vendor, category, type or search terms" },
        vendor: { type: "string", description: "Manufacturer, exact (e.g. Extron)" },
        category: { type: "string", description: 'Taxonomy group or leaf path, e.g. "AV distribution" or "AV distribution / Switchers"' },
        device_type: { type: "string", description: "deviceType, e.g. switcher" },
        status: { type: "string", enum: [...STATUSES] },
        level: { type: "string", enum: [...LEVELS], description: "Standard level from the linter" },
        ports_source: { type: "string", enum: [...ORIGINS], description: "Where the ports come from: manufacturer document, community database, nothing recorded" },
        lint_rule: { type: "string", description: 'Part of a linter message, e.g. "no power port" or "connectorType"' },
        ...PAGE_PROPS,
      },
      additionalProperties: false,
    },
    readOnly: true,
    run: async (a, ctx) => {
      const { filter, rule } = searchFilter(a);
      const vendor = filter.vendors[0];
      let rows = filterRows(matchVendor(await libraryRows(ctx), vendor), { ...filter, vendors: [] });
      if (!filter.statuses.includes("hidden")) rows = rows.filter((r) => r.status !== "hidden");
      if (rule) rows = rows.filter((r) => r.rules.some((k) => k.toLowerCase().includes(rule)));
      return page(rows.map(brief), a);
    },
  },
  {
    name: "get_template",
    title: "Get template",
    description:
      "One template in full: card, ports by section, linter result, ports source, product and data sheet links, possible duplicates, its history from the audit log, and raw: the template exactly as stored (every field, ports with their ids), the base for propose_change.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Template id" }, history: { type: "integer", minimum: 0, maximum: 100, description: "History entries (default 20)" } },
      required: ["id"],
      additionalProperties: false,
    },
    readOnly: true,
    run: async (a, ctx) => {
      const id = str(a, "id");
      if (!id) throw new InvalidParams("id is required");
      const rows = await libraryRows(ctx);
      const r = rows.find((x) => x.id === id);
      if (!r) throw new ToolError(`Template not found: ${id}`);
      const t = r.template;
      const av = t.avail;
      const n = int(a, "history", 20, 0, 100);
      const history = n ? await ctx.call(`/avail/audit?entity=template&entityId=${encodeURIComponent(id)}&limit=${n}`) : null;
      const group = av.duplicate ? rows.filter((x) => x.template.avail.duplicate?.primary === av.duplicate!.primary && x.id !== id) : [];
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      return {
        id,
        label: t.label,
        manufacturer: t.manufacturer,
        part: t.modelNumber || undefined,
        category: t.category,
        type: t.deviceType,
        status: av.status,
        status_reason: av.statusReason ?? undefined,
        level: r.level,
        lint: { errors: r.lint.errors, warnings: r.lint.warnings },
        ports_source: { origin: av.portsOrigin, kind: av.portsSource ?? undefined, from: av.portsFrom ?? undefined },
        approved: av.approvedBy ? { by: av.approvedBy, via: av.approvedVia, at: av.approvedAt } : undefined,
        power: { draw_w: num(t.powerDrawW), voltage: t.voltage || undefined, poe_draw_w: num(t.poeDrawW) },
        size_mm: t.heightMm || t.widthMm || t.depthMm ? { h: num(t.heightMm), w: num(t.widthMm), d: num(t.depthMm) } : undefined,
        weight_kg: num(t.weightKg),
        links: { product: t.referenceUrl || undefined, datasheet: av.datasheetUrl ?? undefined, library: link(ctx, id) },
        ports: Object.fromEntries(
          portsBySection(t.ports ?? []).map((s) => [
            s.section,
            s.ports.map((p) => ({ label: p.label, dir: p.direction, signal: p.signal, connector: p.connector || undefined, notes: p.notes || undefined })),
          ]),
        ),
        slots: Array.isArray(t.slots) && t.slots.length ? t.slots.length : undefined,
        possible_duplicates: group.length ? group.map((g) => ({ id: g.id, label: g.template.label, status: g.status })) : undefined,
        not_duplicates: av.notDuplicates?.length ? av.notDuplicates.map((d) => ({ id: d.id, label: d.label, comment: d.comment })) : undefined,
        history: history?.ok ? ((await history.json()) as AuditRecord[]).map(historyEntry) : undefined,
        raw: rawTemplate(t),
      };
    },
  },
  {
    name: "lint_template",
    title: "Lint template",
    description: "Check a template against the AVAIL Device Block Standard. Nothing is saved. Returns {level, errors, warnings}; level A is required for verified.",
    inputSchema: { type: "object", properties: { template: TEMPLATE_SCHEMA }, required: ["template"], additionalProperties: false },
    readOnly: true,
    run: async (a, ctx) => {
      const res = await ctx.call("/avail/lint", { method: "POST", body: { template: obj(a, "template") } });
      if (!res.ok) throw new ToolError(await errorText(res));
      const l = (await res.json()) as { level: string; errors: string[]; warnings: string[] };
      return { level: l.level, errors: l.errors, warnings: l.warnings };
    },
  },
  {
    name: "normalize_template",
    title: "Normalize template",
    description:
      "Preview the normalizer on a template (sections, labels, directions, category). Nothing is saved. Returns {level_before, level_after, changes[], manual[], template}; manual lists what needs a human.",
    inputSchema: { type: "object", properties: { template: TEMPLATE_SCHEMA }, required: ["template"], additionalProperties: false },
    readOnly: true,
    run: async (a, ctx) => {
      const template = obj(a, "template");
      const res = await ctx.call("/avail/normalize", { method: "POST", body: { template } });
      if (!res.ok) throw new ToolError(await errorText(res));
      const r = (await res.json()) as { template: Json; changes: NormalizeChange[]; before: { level: string }; after: { level: string } };
      const labels = portLabelMap(template.ports);
      return {
        level_before: r.before.level,
        level_after: r.after.level,
        changes: r.changes.filter((c) => !c.manual).map((c) => describeChange(c, labels)),
        manual: r.changes.filter((c) => c.manual).map((c) => describeChange(c, labels)),
        template: r.template,
      };
    },
  },
  {
    name: "create_draft_template",
    title: "Create draft template",
    description:
      "Add a new template to the library as a draft (a librarian approves it). Refused if a template with the same manufacturer and part number exists: the error names it with a link. Returns {id, status, level, errors, warnings, link}.",
    inputSchema: { type: "object", properties: { template: TEMPLATE_SCHEMA }, required: ["template"], additionalProperties: false },
    readOnly: false,
    run: async (a, ctx) => {
      const res = await ctx.call("/avail/templates/draft", { method: "POST", body: obj(a, "template") });
      const b = (await res.json().catch(() => ({}))) as Json & { template?: { id: string; label: string } };
      if (res.status === 409) {
        const dup = b.duplicateOf as { id: string; label: string };
        throw new ToolError(String(b.error), { duplicate_of: { id: dup.id, label: dup.label, link: link(ctx, dup.id) } });
      }
      if (!res.ok) throw new ToolError(String(b.error ?? `HTTP ${res.status}`));
      const id = b.template!.id;
      return { id, label: b.template!.label, status: b.status, level: b.level, errors: b.errors, warnings: b.warnings, link: link(ctx, id) };
    },
  },
  {
    name: "propose_change",
    title: "Propose change",
    description:
      "Propose an edit of a template for librarian review. Prefer patch (only what changes; the rest stays as stored); a whole template removes every field it leaves out. " +
      "An edit that changes nothing is refused. Comment: what is wrong and the source. Returns {proposal_id, status, changes}.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "Id of the template to change" },
        patch: {
          type: "object",
          description:
            'Fields to change (null removes one); ports by id: {update: [{id, ...fields}], add: [port with id], remove: [id]}. E.g. {"thermalBtuh": 2.6, "ports": {"update": [{"id": "p1", "notes": "4-pole"}]}}. Ids from get_template raw.ports',
        },
        template: { ...TEMPLATE_SCHEMA, description: "Instead of patch: the whole edited template (start from get_template's raw)" },
        comment: { type: "string", description: "What is wrong and where the right value comes from" },
      },
      required: ["template_id", "comment"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (a, ctx) => {
      const id = str(a, "template_id");
      const comment = str(a, "comment")?.trim();
      if (!id) throw new InvalidParams("template_id is required");
      if (!comment) throw new InvalidParams("comment is required");
      const hasPatch = a.patch !== undefined;
      const hasTemplate = a.template !== undefined;
      if (hasPatch === hasTemplate) throw new InvalidParams("Send either patch (preferred) or template");
      const current = await ctx.call(`/templates/${encodeURIComponent(id)}`);
      if (!current.ok) throw new ToolError(`Template not found: ${id}`);
      const stored = (await current.json()) as Json & { label?: string };
      const label = stored.label ?? id;
      let data: Json;
      if (hasPatch) {
        const r = applyTemplatePatch(stored, obj(a, "patch"));
        if ("error" in r) throw new ToolError(r.error);
        data = r.template;
      } else data = storedForm(obj(a, "template"));
      const changes = editChanges(stored, data);
      if (noChanges(changes)) throw new ToolError(NO_CHANGE_ERROR);
      const res = await ctx.call("/submissions", { method: "POST", body: { action: "update", templateId: id, data, submitterNote: comment, source: "manual" } });
      const b = (await res.json().catch(() => ({}))) as Json;
      if (!res.ok) throw new ToolError(String(b.error ?? `HTTP ${res.status}`));
      const lines = describeEditChanges(changes);
      writeAudit(ctx.sqlite, [{
        actor: ctx.token.email, actorId: ctx.token.userId, entity: "template", entityId: id, entityLabel: label, action: "proposed",
        after: { proposal: b.id, comment, changes: lines },
      }]);
      return { proposal_id: b.id, status: b.status ?? "pending", changes: lines, template: { id, link: link(ctx, id) } };
    },
  },
  {
    name: "review_queue",
    title: "Review queue",
    description: "Drafts at level A waiting for a librarian's approval (the workspace's Review queue). Returns {total, offset, items[]}.",
    inputSchema: { type: "object", properties: { vendor: { type: "string", description: "Manufacturer, exact" }, ...PAGE_PROPS }, additionalProperties: false },
    readOnly: true,
    run: async (a, ctx) => {
      const queue = builtInFilters(null).find((f) => f.name === "Review queue")!.filter;
      return page(filterRows(matchVendor(await libraryRows(ctx), str(a, "vendor")), queue).map(brief), a);
    },
  },
  {
    name: "possible_duplicates",
    title: "Possible duplicates",
    description:
      "Groups of templates that are probably the same product (same manufacturer and part number, or the same model). The first member is the proposed primary. Returns {total, offset, items[]: {why, members[]}}.",
    inputSchema: { type: "object", properties: { vendor: { type: "string", description: "Manufacturer, exact" }, ...PAGE_PROPS }, additionalProperties: false },
    readOnly: true,
    run: async (a, ctx) => {
      const groups = new Map<string, WsRow[]>();
      for (const r of matchVendor(await libraryRows(ctx), str(a, "vendor"))) {
        const p = r.template.avail.duplicate?.primary;
        if (p) groups.set(p, [...(groups.get(p) ?? []), r]);
      }
      const items = [...groups].map(([primary, members]) => ({
        primary,
        members: members.sort((x, y) => (x.id === primary ? -1 : y.id === primary ? 1 : 0)).map((m) => ({ id: m.id, label: m.template.label, part: m.partNumber || undefined, status: m.status, level: m.level })),
      }));
      items.sort((x, y) => y.members.length - x.members.length || x.members[0].label.localeCompare(y.members[0].label));
      return page(items, a);
    },
  },
  {
    name: "audit_log",
    title: "Audit log",
    description: "Who changed what and when, newest first. Filters combine; page with before = the last id you got. Returns {items[]: id, at, actor, token, entity, entity_id, label, action, changes}.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["template", "user", "run"] },
        entity_id: { type: "string", description: "Template or user id" },
        actor: { type: "string", description: "Email of who made the change" },
        before: { type: "integer", minimum: 1, description: "Only entries with a smaller id" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Entries to return (default 25)" },
      },
      additionalProperties: false,
    },
    readOnly: true,
    run: async (a, ctx) => {
      const q = new URLSearchParams();
      const entity = oneOf(a, "entity", ["template", "user", "run"] as const);
      if (entity) q.set("entity", entity);
      for (const [k, p] of [["entity_id", "entityId"], ["actor", "actor"]] as const) {
        const v = str(a, k);
        if (v) q.set(p, v);
      }
      const before = int(a, "before", 0, 0, Number.MAX_SAFE_INTEGER);
      if (before) q.set("before", String(before));
      q.set("limit", String(int(a, "limit", 25, 1, 100)));
      const res = await ctx.call(`/avail/audit?${q}`);
      if (!res.ok) throw new ToolError(await errorText(res));
      const list = (await res.json()) as AuditRecord[];
      return { items: list.map((r) => ({ id: r.id, entity: r.entity, entity_id: r.entityId, label: r.entityLabel ?? undefined, ...historyEntry(r) })) };
    },
  },
];

// ---------------------------------------------------------------------------- JSON-RPC

interface RpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });

export const INSTRUCTIONS =
  "AVAIL device library. Read with search_templates, get_template, review_queue, possible_duplicates, audit_log. " +
  "Check work with lint_template and normalize_template (nothing is saved). Write only through create_draft_template (new drafts) and propose_change (edits for librarian review: send a patch with only what changes, built on get_template's raw); approving is for librarians. " +
  "Data comes from manufacturer documents first: never guess ports or specs; cite the source in comments.";

async function callTool(name: string, args: Json, ctx: McpContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new InvalidParams(`Unknown tool: ${name}`);
  try {
    return { data: await tool.run(args, ctx) };
  } catch (e) {
    if (e instanceof InvalidParams) throw e;
    if (e instanceof ToolError) return { data: { error: e.message, ...e.extra }, isError: true };
    throw e;
  }
}

async function answer(m: RpcMessage, ctx: McpContext, version: string): Promise<unknown | null> {
  const isRequest = m.id !== undefined && m.id !== null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return isRequest ? rpcError(m.id, -32600, "Invalid request") : null;
  if (!isRequest) return null; // notifications (initialized, cancelled…): nothing to answer
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Json;
  try {
    switch (m.method) {
      case "initialize":
        return rpcResult(m.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      case "ping":
        return rpcResult(m.id, {});
      case "tools/list":
        return rpcResult(m.id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
          })),
        });
      case "tools/call": {
        if (typeof params.name !== "string") return rpcError(m.id, -32602, "params.name is required");
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json;
        const r = await callTool(params.name, args, ctx);
        return rpcResult(m.id, { content: [{ type: "text", text: JSON.stringify(r.data) }], ...(r.isError ? { isError: true } : {}) });
      }
      default:
        return rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  } catch (e) {
    if (e instanceof InvalidParams) return rpcError(m.id, -32602, e.message);
    return rpcError(m.id, -32603, e instanceof Error ? e.message : String(e));
  }
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

/** The protocol version to answer with: the client's, when we speak it, else our latest. */
function negotiate(messages: RpcMessage[]): string {
  const init = messages.find((m) => m.method === "initialize");
  const asked = (init?.params as Json | undefined)?.protocolVersion;
  return typeof asked === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
}

/** An MCP request (signed in: ctx). */
export async function handleMcp(request: Request, ctx: McpContext): Promise<Response> {
  if (request.method !== "POST") return jsonResponse(rpcError(null, -32000, "Method not allowed: this server answers POST only (no SSE stream)"), 405, { Allow: "POST" });
  const header = request.headers.get("MCP-Protocol-Version");
  if (header && !(PROTOCOL_VERSIONS as readonly string[]).includes(header)) {
    return jsonResponse(rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${header}; supported: ${PROTOCOL_VERSIONS.join(", ")}`), 400);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcMessage[];
  if (!messages.length) return jsonResponse(rpcError(null, -32600, "Invalid request"), 400);
  const version = negotiate(messages);
  const answers = (await Promise.all(messages.map((m) => answer(m && typeof m === "object" ? m : {}, ctx, version)))).filter((a) => a !== null);
  if (!answers.length) return new Response(null, { status: 202 });
  return jsonResponse(batch ? answers : answers[0]);
}

/** 401 for a request without an access token. */
export function mcpUnauthorized(): Response {
  return jsonResponse(
    { error: "Sign in with an AI Assistant access token: Authorization: Bearer avail_ai_… (an admin creates it in Users)." },
    401,
    { "WWW-Authenticate": 'Bearer realm="avail", error="invalid_token"' },
  );
}
