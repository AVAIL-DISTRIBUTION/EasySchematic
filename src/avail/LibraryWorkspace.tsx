/**
 * Library workspace (step 2.2): the /library page for librarians and admins. A virtualized
 * table of every template with combinable filters and saved filters, bulk actions with a
 * summary before and a report after, a details panel, and the Proposals tab (engineers' block
 * edits on upstream submissions). Model: workspaceModel.ts; API: workspaceApi.ts, api.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DeviceTemplate } from "../types";
import { changeTemplatesStatus, loadRole, saveLibraryTemplate } from "./api";
import { auditChanges, AUDIT_ACTION_LABELS, fetchAudit, type AuditRecord } from "./adminApi";
import { AVAIL_APP_NAME } from "./brand";
import { AvailLogo } from "./BrandUi";
import { lintBlock } from "./blockLint";
import { TAXONOMY } from "./library";
import { AvailLintResult } from "./LibraryUi";
import { describeChange, deviceCardRows, portLabelMap, portsBySection } from "./libraryView";
import { appliedChanges, normalizeBlock } from "./normalize";
import { isLibrarianOrAdmin } from "./roles";
import { getSignedInUser } from "./session";
import {
  acceptProposal,
  changeTemplatesCategory,
  fetchPendingProposals,
  fetchWorkspace,
  rejectProposal,
  type Proposal,
  mergeTemplates,
} from "./workspaceApi";
import {
  activeFilterCount,
  buildRows,
  builtInFilters,
  BULK_LABELS,
  BULK_STATUS,
  APPROVAL_LABELS,
  categoryTree,
  COLUMNS,
  completeFilter,
  DEFAULT_COLUMNS,
  diffIsEmpty,
  diffTemplates,
  EMPTY_FILTER,
  exportTable,
  facet,
  filterRows,
  LEVELS,
  ORIGIN_LABELS,
  planBulk,
  planMerge,
  suggestedPrimary,
  ruleLabel,
  sortRows,
  STATUS_LABELS,
  WS_STATUSES,
  type BulkAction,
  type BulkPlan,
  type ColumnId,
  type SavedFilter,
  type WsFilter,
  type WsRow,
} from "./workspaceModel";
import { BULK_BATCH, bulkReport, chunks, runBulk, selectionAfter } from "./workspaceBulk";
import { buildXlsx } from "./xlsxWrite";
import "./avail.css";

const ROW_HEIGHT = 28;
const FILTERS_KEY = "avail.workspace.filters";
const COLUMNS_KEY = "avail.workspace.columns";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: the setting lasts for this page only */
  }
}

const btn = "px-2.5 py-1 rounded border text-xs cursor-pointer disabled:opacity-40 disabled:cursor-default";
const btnPlain = `${btn} border-[var(--color-border)] bg-white hover:bg-[var(--color-surface-hover)]`;
const btnPrimary = `${btn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`;
const LEVEL_CLASS: Record<string, string> = { A: "bg-green-100 text-green-800", B: "bg-amber-100 text-amber-900", FIX: "bg-red-100 text-red-800" };
const STATUS_CLASS: Record<string, string> = { verified: "text-green-700", draft: "text-amber-800", raw: "text-gray-600", hidden: "text-gray-400" };

// ============================================================================ page

type Tab = "templates" | "proposals";

export default function LibraryWorkspace() {
  const [role, setRole] = useState<string | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("templates");
  useEffect(() => {
    void loadRole().then((r) => setRole(r));
  }, []);

  if (role === undefined) return <Center>Loading…</Center>;
  if (!isLibrarianOrAdmin(role)) {
    return (
      <Center>
        <div className="flex flex-col items-center gap-2">
          <div className="text-sm font-semibold">The library workspace is for librarians and admins.</div>
          <a href="/" className="underline">
            Back to the editor
          </a>
        </div>
      </Center>
    );
  }
  return (
    <div data-testid="avail-workspace" className="h-screen flex flex-col bg-white text-xs text-[var(--color-text)]">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)]">
        <AvailLogo className="h-5" />
        <span className="text-sm font-semibold text-[var(--color-text-heading)]">Library workspace</span>
        <nav className="flex gap-1 ml-4" role="tablist">
          {(["templates", "proposals"] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded cursor-pointer ${tab === t ? "bg-[var(--color-text-heading)] text-white" : "hover:bg-[var(--color-surface-hover)]"}`}
            >
              {t === "templates" ? "Templates" : "Proposals"}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <span className="text-[var(--color-text-muted)]">{getSignedInUser()?.email}</span>
        <a href="/" className="underline">
          Back to {AVAIL_APP_NAME}
        </a>
      </header>
      {tab === "templates" ? <TemplatesTab /> : <ProposalsTab />}
    </div>
  );
}

function Center({ children }: { children: ReactNode }) {
  return <div className="h-screen flex items-center justify-center text-xs text-[var(--color-text-muted)]">{children}</div>;
}

// ============================================================================ Templates tab

function TemplatesTab() {
  const [rows, setRows] = useState<WsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WsFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<{ by: ColumnId; desc: boolean }>({ by: "vendor", desc: false });
  const [columns, setColumns] = useState<ColumnId[]>(() => load(COLUMNS_KEY, [...DEFAULT_COLUMNS]));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "plan"; plan: BulkPlan }
    | { kind: "report"; lines: string[]; title: string }
    | { kind: "category" }
    | { kind: "merge" }
    | { kind: "columns" }
    | null
  >(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setRows(buildRows(await fetchWorkspace()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one load on mount
    void reload();
  }, [reload]);

  // A link /library?template=<id> (e.g. from a 409 "duplicate" answer) opens that template.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("template");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- once, from the address
    if (id) setFocus(id);
  }, []);
  // Possible duplicates: groups together, primary first.
  const by = filter.duplicates && sort.by !== "duplicateOf" ? { by: "duplicateOf" as ColumnId, desc: false } : sort;
  const shown = useMemo(() => (rows ? sortRows(filterRows(rows, filter), by.by, by.desc) : []), [rows, filter, by.by, by.desc]);
  const selectedRows = useMemo(() => (rows ?? []).filter((r) => selected.has(r.id)), [rows, selected]);
  const focused = useMemo(() => rows?.find((r) => r.id === focus) ?? null, [rows, focus]);

  /** Runs a bulk action in batches of 500 (the API's limit), with progress, then one report. */
  const runPlan = async (plan: BulkPlan, onProgress: (batch: number, of: number) => void) => {
    const send =
      plan.action === "category"
        ? (ids: string[]) => changeTemplatesCategory(ids, plan.category!)
        : plan.action === "merge"
          ? (ids: string[]) => mergeTemplates(plan.primary!.id, ids)
          : (ids: string[]) => changeTemplatesStatus(ids, BULK_STATUS[plan.action as Exclude<BulkAction, "category" | "merge">]);
    const outcome = await runBulk(plan, send, onProgress);
    // Done: the selection is cleared (failed batches stay selected to run again).
    setSelected(selectionAfter(outcome));
    setDialog({ kind: "report", title: `${BULK_LABELS[plan.action]} — report`, lines: bulkReport(plan, outcome) });
    await reload();
  };

  const exportSelection = () => {
    const data = buildXlsx("Templates", exportTable(selectedRows.length ? selectedRows : shown));
    const blob = new Blob([data as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `avail-library-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (error) return <div className="p-4 text-red-700">Could not load the library: {error}</div>;
  if (!rows) return <Center>Loading the library…</Center>;

  return (
    <div className="flex-1 flex min-h-0">
      <FilterSidebar rows={rows} filter={filter} onChange={setFilter} />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)]">
          <span data-testid="avail-ws-count">
            {shown.length} of {rows.length} templates
          </span>
          {selected.size > 0 && <span className="font-semibold">· {selected.size} selected</span>}
          <div className="flex-1" />
          <button className={btnPlain} onClick={() => setSelected(new Set(shown.map((r) => r.id)))} disabled={!shown.length}>
            Select all shown
          </button>
          <button className={btnPlain} onClick={() => setSelected(new Set())} disabled={!selected.size}>
            Clear selection
          </button>
          <button className={btnPlain} onClick={() => setDialog({ kind: "columns" })}>
            Columns
          </button>
          <button className={btnPlain} onClick={() => void reload()}>
            Reload
          </button>
        </div>
        {selected.size > 0 && (
          <div data-testid="avail-ws-bulk" className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-blue-50">
            <span className="font-semibold">Bulk actions for {selected.size}:</span>
            {(["approve", "draft", "hide", "unhide"] as Exclude<BulkAction, "category" | "merge">[]).map((a) => (
              <button key={a} className={btnPlain} onClick={() => setDialog({ kind: "plan", plan: planBulk(a, selectedRows) })}>
                {BULK_LABELS[a]}
              </button>
            ))}
            <button className={btnPlain} onClick={() => setDialog({ kind: "category" })}>
              {BULK_LABELS.category}
            </button>
            <button
              className={btnPlain}
              onClick={() => setDialog({ kind: "merge" })}
              disabled={selected.size < 2}
              title={selected.size < 2 ? "Select the duplicates and the template to keep" : "Keep one template, hide the others as its duplicates"}
            >
              {BULK_LABELS.merge}
            </button>
            <button className={btnPlain} onClick={exportSelection}>
              Export to xlsx
            </button>
          </div>
        )}
        <Table
          rows={shown}
          columns={columns}
          sort={sort}
          onSort={(by) => setSort((s) => ({ by, desc: s.by === by ? !s.desc : false }))}
          selected={selected}
          onToggle={(id, on) =>
            setSelected((s) => {
              const n = new Set(s);
              if (on) n.add(id);
              else n.delete(id);
              return n;
            })
          }
          focus={focus}
          onFocus={setFocus}
        />
        {selected.size === 0 && (
          <div className="px-3 py-1 border-t border-[var(--color-border)] text-[var(--color-text-muted)] flex">
            <span>Tick rows for bulk actions.</span>
            <div className="flex-1" />
            <button className="underline cursor-pointer" onClick={exportSelection}>
              Export the {shown.length} shown to xlsx
            </button>
          </div>
        )}
      </div>
      {focused && <DetailsPanel row={focused} onClose={() => setFocus(null)} onChanged={reload} onReport={(title, lines) => setDialog({ kind: "report", title, lines })} />}

      {dialog?.kind === "plan" && <PlanDialog plan={dialog.plan} onClose={() => setDialog(null)} onRun={runPlan} />}
      {dialog?.kind === "category" && (
        <CategoryDialog
          onClose={() => setDialog(null)}
          onPick={(category) => setDialog({ kind: "plan", plan: planBulk("category", selectedRows, category) })}
        />
      )}
      {dialog?.kind === "merge" && (
        <MergeDialog rows={selectedRows} onClose={() => setDialog(null)} onPick={(primary) => setDialog({ kind: "plan", plan: planMerge(selectedRows, primary) })} />
      )}
      {dialog?.kind === "report" && (
        <Modal title={dialog.title} onClose={() => setDialog(null)} testId="avail-ws-report">
          <div className="p-4 flex flex-col gap-1">
            {dialog.lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </Modal>
      )}
      {dialog?.kind === "columns" && (
        <ColumnsDialog
          columns={columns}
          onClose={() => setDialog(null)}
          onChange={(c) => {
            setColumns(c);
            save(COLUMNS_KEY, c);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- table

function Table({
  rows,
  columns,
  sort,
  onSort,
  selected,
  onToggle,
  focus,
  onFocus,
}: {
  rows: WsRow[];
  columns: ColumnId[];
  sort: { by: ColumnId; desc: boolean };
  onSort: (by: ColumnId) => void;
  selected: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  focus: string | null;
  onFocus: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = columns.map((id) => COLUMNS.find((c) => c.id === id)!).filter(Boolean);
  const width = 32 + cols.reduce((n, c) => n + c.width, 0);
  const first = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 10);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW_HEIGHT) + 10);
  return (
    <div ref={ref} data-testid="avail-ws-table" className="flex-1 overflow-auto relative" onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      <div style={{ width, minWidth: "100%" }}>
        <div className="sticky top-0 z-10 flex bg-white border-b border-[var(--color-border)] font-semibold text-[var(--color-text-heading)]" style={{ height: ROW_HEIGHT }}>
          <div style={{ width: 32 }} />
          {cols.map((c) => (
            <button
              key={c.id}
              onClick={() => onSort(c.id)}
              style={{ width: c.width }}
              className="text-left px-2 truncate cursor-pointer hover:bg-[var(--color-surface-hover)]"
              title={`Sort by ${c.label}`}
            >
              {c.label}
              {sort.by === c.id ? (sort.desc ? " ▼" : " ▲") : ""}
            </button>
          ))}
        </div>
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {rows.slice(first, last).map((r, i) => {
            const top = (first + i) * ROW_HEIGHT;
            const on = selected.has(r.id);
            return (
              <div
                key={r.id}
                data-testid="avail-ws-row"
                onClick={() => onFocus(r.id)}
                className={`absolute left-0 right-0 flex items-center border-b border-gray-100 cursor-pointer ${focus === r.id ? "bg-blue-100" : on ? "bg-blue-50" : "hover:bg-[var(--color-surface-hover)]"}`}
                style={{ top, height: ROW_HEIGHT }}
              >
                <div style={{ width: 32 }} className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${r.template.label}`} checked={on} onChange={(e) => onToggle(r.id, e.target.checked)} />
                </div>
                {cols.map((c) => (
                  <div key={c.id} style={{ width: c.width }} className="px-2 truncate" title={c.value(r)}>
                    {c.id === "level" ? (
                      <span className={`rounded px-1.5 py-px font-semibold ${LEVEL_CLASS[r.level]}`}>{r.level}</span>
                    ) : c.id === "status" ? (
                      <span className={STATUS_CLASS[r.status]}>{c.value(r)}</span>
                    ) : (
                      c.value(r)
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {rows.length === 0 && <div className="p-4 text-[var(--color-text-muted)]">No templates match the filters.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------- filters

function FilterSidebar({ rows, filter, onChange }: { rows: WsRow[]; filter: WsFilter; onChange: (f: WsFilter) => void }) {
  const me = getSignedInUser()?.email ?? null;
  const [custom, setCustom] = useState<SavedFilter[]>(() => load(FILTERS_KEY, []));
  const presets = useMemo(() => [...builtInFilters(me), ...custom], [me, custom]);
  const set = <K extends keyof WsFilter>(k: K, v: WsFilter[K]) => onChange({ ...filter, [k]: v });
  const toggle = <K extends "vendors" | "categories" | "deviceTypes" | "statuses" | "levels" | "portsSources" | "rules" | "approvedBy" | "origins" | "approvedVia">(k: K, v: string) => {
    const list = filter[k] as string[];
    set(k, (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]) as WsFilter[K]);
  };
  const vendors = useMemo(() => facet(rows, (r) => r.vendor), [rows]);
  const types = useMemo(() => facet(rows, (r) => r.deviceType), [rows]);
  const sources = useMemo(() => facet(rows, (r) => r.portsSource), [rows]);
  const rules = useMemo(() => facet(rows, (r) => r.rules), [rows]);
  const approvers = useMemo(() => facet(rows, (r) => r.approvedBy), [rows]);
  const tree = useMemo(() => categoryTree(rows), [rows]);
  const n = activeFilterCount(filter);

  const saveCurrent = () => {
    const name = window.prompt("Name of this filter");
    if (!name?.trim()) return;
    const next = [...custom.filter((f) => f.name !== name.trim()), { name: name.trim(), filter }];
    setCustom(next);
    save(FILTERS_KEY, next);
  };

  return (
    <aside data-testid="avail-ws-filters" className="w-64 shrink-0 border-r border-[var(--color-border)] overflow-y-auto p-2 flex flex-col gap-3">
      <input
        type="search"
        placeholder="Search model, part number, vendor…"
        value={filter.text}
        onChange={(e) => set("text", e.target.value)}
        className="border border-[var(--color-border)] rounded px-2 py-1"
        aria-label="Search"
      />
      <Section title="Saved filters">
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <span key={p.name} className="inline-flex items-center border border-gray-300 rounded">
              <button className="px-1.5 py-0.5 cursor-pointer hover:bg-[var(--color-surface-hover)]" onClick={() => onChange(completeFilter(p.filter))}>
                {p.name}
              </button>
              {!p.builtIn && (
                <button
                  title="Delete this filter"
                  className="px-1 text-[var(--color-text-muted)] cursor-pointer"
                  onClick={() => {
                    const next = custom.filter((f) => f.name !== p.name);
                    setCustom(next);
                    save(FILTERS_KEY, next);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="flex gap-2 mt-1">
          <button className="underline cursor-pointer disabled:opacity-40" disabled={!n} onClick={saveCurrent}>
            Save current filter
          </button>
          <button className="underline cursor-pointer disabled:opacity-40" disabled={!n} onClick={() => onChange(EMPTY_FILTER)}>
            Clear all ({n})
          </button>
        </div>
      </Section>
      <Section title="Status">
        <Chips values={WS_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} on={filter.statuses} onToggle={(v) => toggle("statuses", v)} />
      </Section>
      <Section title="Level">
        <Chips values={LEVELS.map((l) => ({ value: l, label: l }))} on={filter.levels} onToggle={(v) => toggle("levels", v)} />
      </Section>
      <Section title="Vendor">
        <CheckList items={vendors} on={filter.vendors} onToggle={(v) => toggle("vendors", v)} />
      </Section>
      <Section title="Category">
        <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
          {tree.map((g) => (
            <details key={g.group}>
              <summary className="cursor-pointer">
                <label onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={filter.categories.includes(g.group)} onChange={() => toggle("categories", g.group)} /> {g.group}{" "}
                  <span className="text-[var(--color-text-muted)]">{g.count}</span>
                </label>
              </summary>
              <div className="pl-5 flex flex-col">
                {g.leaves.map((l) => (
                  <label key={l.path}>
                    <input type="checkbox" checked={filter.categories.includes(l.path)} onChange={() => toggle("categories", l.path)} /> {l.leaf}{" "}
                    <span className="text-[var(--color-text-muted)]">{l.count}</span>
                  </label>
                ))}
              </div>
            </details>
          ))}
        </div>
      </Section>
      <Section title="Device type">
        <CheckList items={types} on={filter.deviceTypes} onToggle={(v) => toggle("deviceTypes", v)} />
      </Section>
      <Section title="Ports origin">
        <Chips values={(Object.keys(ORIGIN_LABELS) as (keyof typeof ORIGIN_LABELS)[]).map((o) => ({ value: o, label: ORIGIN_LABELS[o] }))} on={filter.origins} onToggle={(v) => toggle("origins", v)} />
      </Section>
      <Section title="Ports source">
        <CheckList items={sources} on={filter.portsSources} onToggle={(v) => toggle("portsSources", v)} />
      </Section>
      <Section title="Linter rule">
        <CheckList items={rules} on={filter.rules} onToggle={(v) => toggle("rules", v)} label={ruleLabel} />
      </Section>
      <Section title="Changed since">
        <input type="date" value={filter.changedSince} onChange={(e) => set("changedSince", e.target.value)} className="border border-[var(--color-border)] rounded px-1" aria-label="Changed since" />
      </Section>
      <Section title="Approved how">
        <Chips values={(Object.keys(APPROVAL_LABELS) as (keyof typeof APPROVAL_LABELS)[]).map((a) => ({ value: a, label: APPROVAL_LABELS[a] }))} on={filter.approvedVia} onToggle={(v) => toggle("approvedVia", v)} />
      </Section>
      <Section title="Approved by">
        <CheckList items={approvers} on={filter.approvedBy} onToggle={(v) => toggle("approvedBy", v)} />
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="font-semibold text-[var(--color-text-heading)] mb-1">{title}</div>
      {children}
    </div>
  );
}

function Chips({ values, on, onToggle }: { values: { value: string; label: string }[]; on: string[]; onToggle: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v) => (
        <button
          key={v.value}
          aria-pressed={on.includes(v.value)}
          onClick={() => onToggle(v.value)}
          className={`px-1.5 py-0.5 rounded border cursor-pointer ${on.includes(v.value) ? "bg-[var(--color-text-heading)] text-white border-[var(--color-text-heading)]" : "border-gray-300"}`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function CheckList({ items, on, onToggle, label = (v) => v }: { items: { value: string; count: number }[]; on: string[]; onToggle: (v: string) => void; label?: (v: string) => string }) {
  const [q, setQ] = useState("");
  const shown = items.filter((i) => !q || label(i.value).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex flex-col gap-0.5">
      {items.length > 8 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find…" className="border border-gray-300 rounded px-1 py-0.5" />}
      <div className="max-h-40 overflow-y-auto flex flex-col">
        {shown.map((i) => (
          <label key={i.value} className="flex gap-1 items-start">
            <input type="checkbox" checked={on.includes(i.value)} onChange={() => onToggle(i.value)} className="mt-0.5" />
            <span className="flex-1">{label(i.value)}</span>
            <span className="text-[var(--color-text-muted)]">{i.count}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- dialogs

function Modal({ title, onClose, children, testId, footer }: { title: string; onClose: () => void; children: ReactNode; testId: string; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={onClose}>
      <div data-testid={testId} className="bg-white rounded-lg shadow-2xl w-[720px] max-w-[95vw] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-2 border-b border-[var(--color-border)] flex items-center">
          <h2 className="text-sm font-semibold text-[var(--color-text-heading)] flex-1">{title}</h2>
          <button onClick={onClose} className="text-lg leading-none cursor-pointer" title="Close">
            ×
          </button>
        </div>
        <div className="overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-2 border-t border-[var(--color-border)] flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/** The summary before a bulk action runs: what changes, what stays, what will be refused. */
/** Merge into…: pick the template to keep among the selection (the suggested primary first). */
function MergeDialog({ rows, onClose, onPick }: { rows: WsRow[]; onClose: () => void; onPick: (primary: WsRow) => void }) {
  const suggested = suggestedPrimary(rows);
  const [pick, setPick] = useState<string>(suggested?.id ?? "");
  const primary = rows.find((r) => r.id === pick);
  return (
    <Modal
      title="Merge into…"
      onClose={onClose}
      testId="avail-ws-merge"
      footer={
        <>
          <button className={btnPlain} onClick={onClose}>
            Cancel
          </button>
          <button className={btnPrimary} disabled={!primary} onClick={() => primary && onPick(primary)}>
            Next
          </button>
        </>
      }
    >
      <div className="p-4 flex flex-col gap-2">
        <div>
          Keep one template; the other {rows.length - 1} become hidden with the reason «duplicate of &lt;its id&gt;», each change in the audit log with a link to the
          one kept.
        </div>
        <div className="flex flex-col gap-1 max-h-[50vh] overflow-y-auto">
          {rows.map((r) => (
            <label key={r.id} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="avail-merge-primary" checked={pick === r.id} onChange={() => setPick(r.id)} />
              <span className="font-semibold">{r.template.label}</span>
              <span className="text-[var(--color-text-muted)]">
                {r.partNumber || "—"} · {STATUS_LABELS[r.status]} · level {r.level} · ports: {r.portsSource || "—"}
                {r.id === suggested?.id ? " · suggested" : ""}
              </span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function PlanDialog({
  plan,
  onClose,
  onRun,
}: {
  plan: BulkPlan;
  onClose: () => void;
  onRun: (p: BulkPlan, onProgress: (batch: number, of: number) => void) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ batch: number; of: number } | null>(null);
  const batches = chunks(plan.change).length;
  const what =
    plan.action === "category"
      ? `${BULK_LABELS.category} to ${plan.category}`
      : plan.action === "merge"
        ? `Merge into ${plan.primary?.template.label ?? "…"}`
        : BULK_LABELS[plan.action];
  return (
    <Modal
      title={`${what} — what will change`}
      onClose={busy ? () => {} : onClose}
      testId="avail-ws-plan"
      footer={
        <>
          <button className={btnPlain} onClick={onClose} disabled={busy} title={busy ? "The batches already sent cannot be undone; wait for the report" : ""}>
            Cancel
          </button>
          <button
            className={btnPrimary}
            disabled={busy || plan.change.length === 0}
            onClick={() => {
              setBusy(true);
              void onRun(plan, (batch, of) => setProgress({ batch, of }));
            }}
          >
            {busy ? (progress ? `Batch ${progress.batch} of ${progress.of}…` : "Working…") : plan.action === "merge" ? `Hide ${plan.change.length} as duplicates` : `${BULK_LABELS[plan.action]} ${plan.change.length}`}
          </button>
        </>
      }
    >
      <div className="p-4 flex flex-col gap-2">
        <div>
          <b>{plan.change.length}</b> will change, <b>{plan.unchanged.length}</b> already as asked, <b>{plan.refused.length}</b> will be refused.
          {plan.action === "approve" && " The server checks level A again for every template."}
          {batches > 1 && ` Sent in ${batches} batches of up to ${BULK_BATCH}.`}
        </div>
        {busy && progress && (
          <div data-testid="avail-ws-progress" className="flex items-center gap-2">
            <progress value={progress.batch - 0.5} max={progress.of} className="flex-1" aria-label="Progress of the bulk action" />
            <span>
              Batch {progress.batch} of {progress.of}
            </span>
          </div>
        )}
        {plan.change.length > 0 && (
          <table className="w-full">
            <tbody>
              {plan.change.slice(0, 200).map((c) => (
                <tr key={c.row.id} className="border-t border-gray-100">
                  <td className="py-0.5 pr-2">{c.row.template.label}</td>
                  <td className="py-0.5 text-[var(--color-text-muted)] whitespace-nowrap">
                    {c.from} → {c.to}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {plan.change.length > 200 && <div className="text-[var(--color-text-muted)]">…and {plan.change.length - 200} more.</div>}
        {plan.refused.length > 0 && (
          <div className="text-red-800">
            <div className="font-semibold">Refused:</div>
            {plan.refused.slice(0, 50).map((x) => (
              <div key={x.row.id}>
                {x.row.template.label}: {x.reason}
              </div>
            ))}
            {plan.refused.length > 50 && <div>…and {plan.refused.length - 50} more.</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function CategoryDialog({ onClose, onPick }: { onClose: () => void; onPick: (path: string) => void }) {
  const leaves = useMemo(() => TAXONOMY.categories.filter((c) => c.leaf).map((c) => c.path), []);
  const [value, setValue] = useState(leaves[0] ?? "");
  return (
    <Modal
      title="Change category"
      onClose={onClose}
      testId="avail-ws-category"
      footer={
        <>
          <button className={btnPlain} onClick={onClose}>
            Cancel
          </button>
          <button className={btnPrimary} onClick={() => onPick(value)}>
            Show what will change
          </button>
        </>
      }
    >
      <div className="p-4">
        <select value={value} onChange={(e) => setValue(e.target.value)} className="border border-[var(--color-border)] rounded px-1 py-0.5 w-full" aria-label="Category">
          {leaves.map((l) => (
            <option key={l} value={l}>
              {l}
              {TAXONOMY.categories.find((c) => c.path === l)?.schematic === false ? " (BoQ only)" : ""}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}

function ColumnsDialog({ columns, onClose, onChange }: { columns: ColumnId[]; onClose: () => void; onChange: (c: ColumnId[]) => void }) {
  return (
    <Modal title="Columns" onClose={onClose} testId="avail-ws-columns">
      <div className="p-4 flex flex-col gap-1">
        {COLUMNS.map((c) => (
          <label key={c.id}>
            <input
              type="checkbox"
              checked={columns.includes(c.id)}
              onChange={(e) => onChange(e.target.checked ? COLUMNS.map((x) => x.id).filter((id) => id === c.id || columns.includes(id)) : columns.filter((x) => x !== c.id))}
            />{" "}
            {c.label}
          </label>
        ))}
        <button className="underline cursor-pointer self-start mt-2" onClick={() => onChange([...DEFAULT_COLUMNS])}>
          Reset to default
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- details panel

function DetailsPanel({ row, onClose, onChanged, onReport }: { row: WsRow; onClose: () => void; onChanged: () => Promise<void>; onReport: (title: string, lines: string[]) => void }) {
  const t = row.template;
  const a = t.avail;
  const [history, setHistory] = useState<AuditRecord[] | null>(null);
  const [normalize, setNormalize] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setHistory(null);
    fetchAudit({ entity: "template", entityId: t.id, limit: 50 }).then(
      (h) => live && setHistory(h),
      () => live && setHistory([]),
    );
    return () => {
      live = false;
    };
  }, [t.id]);
  const plain = useMemo(() => {
    const { avail: _a, id: _i, version: _v, ...rest } = t as DeviceTemplate & { avail: unknown; version?: number };
    return rest;
  }, [t]);
  const normalized = useMemo(() => (normalize ? normalizeBlock(plain as unknown as Record<string, unknown>) : null), [normalize, plain]);
  const after = useMemo(() => (normalized ? lintBlock(normalized.template) : null), [normalized]);

  const setStatus = async (status: "verified" | "hidden") => {
    setBusy(true);
    try {
      const r = await changeTemplatesStatus([t.id!], status);
      if (r.failed.length) onReport(status === "verified" ? "Approve" : "Hide", r.failed.map((f) => `${f.label ?? f.id}: ${f.reason === "not_level_a" ? `level ${f.level}, verified needs A` : "not found"}`));
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const saveNormalized = async () => {
    if (!normalized) return;
    setBusy(true);
    try {
      await saveLibraryTemplate(t.id!, normalized.template as unknown as Omit<DeviceTemplate, "id" | "version">);
      setNormalize(false);
      onReport("Normalize", [`Saved ${appliedChanges(normalized.changes).length} changes to ${t.label}; level ${after?.level}. The edit is in the audit log.`]);
      await onChanged();
    } catch (e) {
      onReport("Normalize", [`Failed: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setBusy(false);
    }
  };

  const labels = portLabelMap(t.ports);
  return (
    <aside data-testid="avail-ws-details" className="w-[420px] shrink-0 border-l border-[var(--color-border)] overflow-y-auto flex flex-col">
      <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-start gap-2">
        <div className="flex-1">
          <div className="text-sm font-semibold text-[var(--color-text-heading)]">{t.label}</div>
          <div className="text-[var(--color-text-muted)]">
            <span className={STATUS_CLASS[a.status]}>{STATUS_LABELS[a.status]}</span> · level {row.level} · ports: {row.portsSource}
          </div>
        </div>
        <button onClick={onClose} className="text-lg leading-none cursor-pointer" title="Close">
          ×
        </button>
      </div>
      <div className="px-3 py-2 flex flex-wrap gap-1.5 border-b border-[var(--color-border)]">
        <button className={btnPlain} onClick={() => window.open(`/?availEdit=${encodeURIComponent(t.id!)}`, "_blank")} title="Open the Device Editor on this template in a new tab">
          Edit
        </button>
        <button className={btnPlain} onClick={() => setNormalize((v) => !v)} disabled={busy}>
          Normalize
        </button>
        <button className={btnPlain} onClick={() => void setStatus("verified")} disabled={busy || a.status === "verified"} title={row.level === "A" ? "" : "Verified needs level A"}>
          Approve
        </button>
        <button className={btnPlain} onClick={() => void setStatus("hidden")} disabled={busy || a.status === "hidden"}>
          Hide
        </button>
      </div>
      {normalized && after && (
        <div data-testid="avail-ws-normalize" className="px-3 py-2 border-b border-blue-200 bg-blue-50 flex flex-col gap-1">
          <div className="font-semibold">
            {appliedChanges(normalized.changes).length === 0 ? "The normalizer has nothing to change." : `Normalizer: ${appliedChanges(normalized.changes).length} changes`} (level {row.lint.level} → {after.level})
          </div>
          <ul className="list-disc pl-5 max-h-40 overflow-y-auto">
            {normalized.changes.map((c, i) => (
              <li key={i} className={c.manual ? "text-amber-900" : ""}>
                {describeChange(c, labels)}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button className={btnPlain} onClick={() => setNormalize(false)}>
              Discard
            </button>
            <button className={btnPrimary} disabled={busy || appliedChanges(normalized.changes).length === 0} onClick={() => void saveNormalized()}>
              Save to library
            </button>
          </div>
        </div>
      )}
      <div className="px-3 py-2 flex flex-col gap-3">
        {a.statusReason && <div className="text-amber-900">Status note: {a.statusReason}</div>}
        <table className="w-full">
          <tbody>
            {deviceCardRows(t as never).map((r) => (
              <tr key={r.label}>
                <td className="text-[var(--color-text-muted)] pr-2 align-top whitespace-nowrap">{r.label}</td>
                <td className="break-all">
                  {r.href ? (
                    <a href={r.href} target="_blank" rel="noreferrer" className="underline">
                      {r.value}
                    </a>
                  ) : (
                    r.value
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td className="text-[var(--color-text-muted)] pr-2">Data sheet</td>
              <td className="break-all">
                {a.datasheetUrl ? (
                  <a href={a.datasheetUrl} target="_blank" rel="noreferrer" className="underline">
                    {a.datasheetUrl}
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
            <tr>
              <td className="text-[var(--color-text-muted)] pr-2">Approved</td>
              <td>{a.approvedBy ? `${a.approvedBy}, ${row.approvedVia}, ${a.approvedAt ?? ""}` : "—"}</td>
            </tr>
          </tbody>
        </table>
        <AvailLintResult lint={row.lint} />
        <div>
          <div className="font-semibold text-[var(--color-text-heading)] mb-1">Ports ({(t.ports ?? []).length})</div>
          {portsBySection(t.ports ?? []).map((s) => (
            <div key={s.section} className="mb-1.5">
              <div className="font-semibold">{s.section}</div>
              {s.ports.map((p, i) => (
                <div key={i} className="pl-2 flex gap-2">
                  <span className="flex-1">{p.label}</span>
                  <span className="text-[var(--color-text-muted)]">
                    {p.direction} · {p.signal} · {p.connector}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {Array.isArray(t.slots) && t.slots.length > 0 && <div className="text-[var(--color-text-muted)]">Slots: {t.slots.length}</div>}
        </div>
        <div>
          <div className="font-semibold text-[var(--color-text-heading)] mb-1">History</div>
          {history === null && <div className="text-[var(--color-text-muted)]">Loading…</div>}
          {history?.length === 0 && <div className="text-[var(--color-text-muted)]">No changes recorded.</div>}
          {history?.map((h) => (
            <div key={h.id} className="border-t border-gray-100 py-1">
              <div>
                <span className="text-[var(--color-text-muted)]">{h.at}</span> · {h.actor} · {AUDIT_ACTION_LABELS[h.action]}
              </div>
              {auditChanges(h).map((l, i) => (
                <div key={i} className="font-mono text-[10px] break-all text-[var(--color-text-muted)]">
                  {l}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

// ============================================================================ Proposals tab

function ProposalsTab() {
  const [list, setList] = useState<Proposal[] | null>(null);
  const [current, setCurrent] = useState<Record<string, DeviceTemplate>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [proposals, templates] = await Promise.all([fetchPendingProposals(), fetchWorkspace()]);
      setList(proposals.filter((p) => p.action === "update"));
      setCurrent(Object.fromEntries(templates.map((t) => [t.id!, t])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const proposal = list?.find((p) => p.id === open) ?? null;
  const before = proposal?.templateId ? current[proposal.templateId] : undefined;
  const diff = useMemo(
    () => (proposal && before ? diffTemplates(before as unknown as Record<string, unknown>, proposal.data as unknown as Record<string, unknown>) : null),
    [proposal, before],
  );
  const lintAfter = useMemo(() => (proposal ? lintBlock(proposal.data) : null), [proposal]);

  const decide = async (accept: boolean) => {
    if (!proposal) return;
    setBusy(true);
    try {
      if (accept) await acceptProposal(proposal.id);
      else await rejectProposal(proposal.id, note.trim());
      setMessage(`${accept ? "Accepted" : "Rejected"}: ${proposal.data.label}. The decision is in the audit log.`);
      setOpen(null);
      setNote("");
      await reload();
    } catch (e) {
      setMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="p-4 text-red-700">Could not load the proposals: {error}</div>;
  if (!list) return <Center>Loading proposals…</Center>;
  return (
    <div className="flex-1 flex min-h-0" data-testid="avail-ws-proposals">
      <div className="w-96 shrink-0 border-r border-[var(--color-border)] overflow-y-auto">
        {message && <div className="px-3 py-2 bg-blue-50 border-b border-blue-200">{message}</div>}
        {list.length === 0 && <div className="p-3 text-[var(--color-text-muted)]">No proposals waiting.</div>}
        {list.map((p) => (
          <button
            key={p.id}
            data-testid="avail-ws-proposal"
            onClick={() => {
              setOpen(p.id);
              setNote("");
            }}
            className={`w-full text-left px-3 py-2 border-b border-gray-100 cursor-pointer ${open === p.id ? "bg-blue-100" : "hover:bg-[var(--color-surface-hover)]"}`}
          >
            <div className="font-semibold">{p.data.label}</div>
            <div className="text-[var(--color-text-muted)]">
              {p.submitterName ?? p.submitterEmail} · {p.createdAt}
            </div>
            {p.submitterNote && <div className="truncate">{p.submitterNote}</div>}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {!proposal && <div className="text-[var(--color-text-muted)]">Pick a proposal to compare it with the library template.</div>}
        {proposal && (
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-sm font-semibold text-[var(--color-text-heading)]">{proposal.data.label}</div>
              <div className="text-[var(--color-text-muted)]">
                Proposed by {proposal.submitterEmail ?? proposal.submitterName} on {proposal.createdAt}
              </div>
              {proposal.submitterNote && <div className="mt-1 p-2 bg-gray-50 border border-gray-200 rounded">“{proposal.submitterNote}”</div>}
            </div>
            {!before && <div className="text-red-700">The template is no longer in the library.</div>}
            {diff && diffIsEmpty(diff) && <div>The proposal changes nothing.</div>}
            {diff && diff.fields.length > 0 && (
              <table className="w-full" data-testid="avail-ws-diff-fields">
                <thead className="text-left text-[var(--color-text-muted)]">
                  <tr>
                    <th className="pr-2">Field</th>
                    <th className="pr-2">Was</th>
                    <th>Becomes</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.fields.map((f) => (
                    <tr key={f.field} className="border-t border-gray-100 align-top">
                      <td className="pr-2 py-0.5">{f.field}</td>
                      <td className="pr-2 py-0.5 bg-red-50 break-all">{f.before}</td>
                      <td className="py-0.5 bg-green-50 break-all">{f.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {diff && diff.ports.length > 0 && (
              <div data-testid="avail-ws-diff-ports">
                <div className="font-semibold text-[var(--color-text-heading)]">Ports</div>
                {diff.ports.map((p, i) => (
                  <div key={i} className="border-t border-gray-100 py-0.5">
                    <span className={p.kind === "added" ? "text-green-700" : p.kind === "removed" ? "text-red-700" : ""}>
                      {p.kind === "added" ? "Added" : p.kind === "removed" ? "Removed" : "Changed"}: {p.label}
                    </span>
                    {p.changes.map((c) => (
                      <div key={c.field} className="pl-3 text-[var(--color-text-muted)]">
                        {c.field}: {c.before} → {c.after}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {diff?.slots && (
              <div>
                Slots: {diff.slots.before} → {diff.slots.after}
              </div>
            )}
            {lintAfter && <AvailLintResult lint={lintAfter} />}
            <div className="flex flex-col gap-1">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Comment to the author (sent with a rejection)"
                className="border border-[var(--color-border)] rounded p-1 h-16"
                aria-label="Comment to the author"
              />
              <div className="flex gap-2 justify-end">
                <button className={btnPlain} disabled={busy || !note.trim()} onClick={() => void decide(false)} title={note.trim() ? "" : "Write a comment for the author first"}>
                  Reject
                </button>
                <button className={btnPrimary} disabled={busy || !before} onClick={() => void decide(true)}>
                  Accept
                </button>
              </div>
              <div className="text-[var(--color-text-muted)]">
                Accept writes the proposed template to the library; its level and status follow the usual rules (a verified template below level A becomes a draft).
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
