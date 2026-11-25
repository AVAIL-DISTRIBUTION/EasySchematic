/**
 * AVAIL library UI: status badges, the "Show unverified" switch, taxonomy grouping,
 * the moderator review card, template editing and the report notice. Each component
 * renders nothing outside AVAIL mode (see libraryMode.ts), so the upstream files they
 * are mounted in behave as upstream against upstream's API.
 *
 * All text is English and kept as whole strings (no sentences glued from pieces), so it
 * can move to a translation table later.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { lintBlock, type BlockLintResult } from "./blockLint";
import {
  changeTemplatesStatus,
  changeTemplateStatus,
  fetchTemplateNotes,
  fetchTemplateStatus,
  saveLibraryTemplate,
  type BatchStatusResult,
  type StatusChangeError,
  type TemplateNote,
  type TemplateStatusInfo,
} from "./api";
import {
  blockStatus,
  clearSelection,
  isSelected,
  notifyLibraryChanged,
  PORTS_FILTER_LABELS,
  PORTS_FILTERS,
  setPortsFilter,
  setSelectMode,
  setShowUnverified,
  statusBadge,
  statusOfTemplate,
  toggleSelected,
  type PortsFilter,
  type TemplateStatus,
} from "./libraryMode";
import { describeChange, deviceCardRows, portLabelMap, groupByTaxonomy, portsBySection, REVIEW_CHECKLIST, unverifiedBlocks } from "./libraryView";
import { appliedChanges, normalizeBlock, type NormalizeResult } from "./normalize";
import { applyTemplateToDeviceData, deviceDataToTemplate, editSessionFor, endEditSession } from "./templateEdit";
import { useAvailState, useStartTemplateEdit } from "./useAvail";
import { useSchematicStore } from "../store";
import { slotOwnedPortIds } from "../slotDefinitions";
import type { DeviceTemplate } from "../types";
import "./avail.css";

const BADGE_CLASS: Record<TemplateStatus, string> = {
  verified: "",
  draft: "bg-amber-100 text-amber-800",
  raw: "bg-red-100 text-red-700",
  hidden: "bg-gray-200 text-gray-700",
};

export function AvailStatusBadge({ status, className = "" }: { status: TemplateStatus | null; className?: string }) {
  const text = statusBadge(status);
  if (!text || !status) return null;
  return (
    <span className={`text-[8px] rounded px-1 py-px font-normal shrink-0 whitespace-nowrap ${BADGE_CLASS[status]} ${className}`}>{text}</span>
  );
}

/** Badge over a device block on the schematic (just above its top right corner, not exported). */
export function AvailBlockBadge({ templateId }: { templateId?: string }) {
  useAvailState();
  const status = blockStatus(templateId);
  if (!statusBadge(status)) return null;
  return (
    <div className="avail-export-hide absolute bottom-full right-0 mb-px z-10 pointer-events-none leading-none">
      <AvailStatusBadge status={status} className="shadow-sm" />
    </div>
  );
}

const smallBtn =
  "text-[8px] rounded px-1 py-px font-normal shrink-0 text-blue-600 hover:bg-blue-50 opacity-0 group-hover:opacity-100 cursor-pointer";

/** Library list item extras: status badge and, for moderators, Review and Edit. */
export function AvailTemplateExtras({ template }: { template: DeviceTemplate }) {
  const { active, moderator, selectMode } = useAvailState();
  const [reviewing, setReviewing] = useState(false);
  const edit = useStartTemplateEdit();
  if (!active) return null;
  const status = statusOfTemplate(template);
  if (!statusBadge(status) && !(moderator && template.id)) return null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <span className="flex items-center gap-1">
      {moderator && selectMode && template.id && (
        <input
          type="checkbox"
          aria-label={`Select ${template.label}`}
          checked={isSelected(template.id)}
          onChange={(e) => toggleSelected(template.id!, e.target.checked)}
          onClick={stop}
          onMouseDown={stop}
          className="cursor-pointer"
        />
      )}
      <AvailStatusBadge status={status} />
      {moderator && template.id && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setReviewing(true);
            }}
            onMouseDown={stop}
            className={smallBtn}
            title="Review this template"
          >
            Review
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              void edit.start(template.id!);
            }}
            onMouseDown={stop}
            disabled={edit.busy}
            className={smallBtn}
            title={edit.error ?? "Edit this template in the Device Editor"}
          >
            Edit
          </button>
        </>
      )}
      {reviewing && createPortal(<AvailReviewDialog template={template} onClose={() => setReviewing(false)} />, document.body)}
    </span>
  );
}

/** "Show unverified" in the library panel (remembered in the browser); for moderators, Select + Approve. */
export function AvailLibraryToggle() {
  const { active, showUnverified, moderator, selectMode, selected, portsFilter } = useAvailState();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!active) return null;
  const label = "flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] cursor-pointer select-none";

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await changeTemplatesStatus(selected, "verified");
      setResult(r);
      clearSelection();
      notifyLibraryChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-1 flex-wrap">
      <label className={label} title={moderator ? "Also list raw and hidden templates" : "Also list raw templates (not checked by AVAIL)"}>
        <input type="checkbox" checked={showUnverified} onChange={(e) => setShowUnverified(e.target.checked)} className="cursor-pointer" />
        Show unverified
      </label>
      {moderator && (
        <select
          data-testid="avail-ports-filter"
          value={portsFilter}
          onChange={(e) => setPortsFilter(e.target.value as PortsFilter)}
          className="text-[10px] text-[var(--color-text-muted)] bg-transparent border border-[var(--color-border)] rounded px-1 py-px cursor-pointer"
          title="Where the template's ports come from: the manufacturer's documents, the community database, or nothing recorded"
        >
          {PORTS_FILTERS.map((f) => (
            <option key={f} value={f}>
              {PORTS_FILTER_LABELS[f]}
            </option>
          ))}
        </select>
      )}
      {moderator && (
        <label className={label} title="Select templates to approve them together">
          <input type="checkbox" checked={selectMode} onChange={(e) => setSelectMode(e.target.checked)} className="cursor-pointer" />
          Select
        </label>
      )}
      {moderator && selectMode && (
        <button
          onClick={approve}
          disabled={busy || selected.length === 0}
          className="text-[10px] rounded px-1.5 py-px border border-green-600 bg-green-600 text-white hover:bg-green-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          title="Verify the selected templates; the server checks level A for each"
        >
          {selected.length === 1 ? "Approve 1 template" : `Approve ${selected.length} templates`}
        </button>
      )}
      {error && <span className="text-[10px] text-red-700">{error}</span>}
      {result && createPortal(<AvailBulkResultDialog result={result} onClose={() => setResult(null)} />, document.body)}
    </div>
  );
}

/** Outcome of a bulk Approve: how many were verified, and every template that was not, with why. */
export function AvailBulkResultDialog({ result, onClose }: { result: BatchStatusResult; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose} onMouseDown={(e) => e.stopPropagation()}>
      <div
        data-testid="avail-bulk-result"
        className="bg-white border border-[var(--color-border)] rounded-lg shadow-2xl w-[640px] max-w-[95vw] max-h-[85vh] flex flex-col cursor-default text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center">
          <h2 className="text-sm font-semibold text-[var(--color-text-heading)] flex-1">Approve</h2>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-heading)] text-lg leading-none cursor-pointer" title="Close">
            &times;
          </button>
        </div>
        <div className="px-4 py-3 overflow-y-auto flex flex-col gap-2">
          <div className="text-green-800">
            {result.updated.length === 1 ? "1 template verified." : `${result.updated.length} templates verified.`}
          </div>
          {result.failed.length > 0 && (
            <>
              <div className="font-semibold text-red-700">
                {result.failed.length === 1 ? "1 template was not verified:" : `${result.failed.length} templates were not verified:`}
              </div>
              <ul className="flex flex-col gap-2">
                {result.failed.map((f) => (
                  <li key={f.id} className="border border-red-200 bg-red-50 rounded p-2">
                    <div className="font-semibold">{f.label ?? f.id}</div>
                    {f.reason === "not_found" ? (
                      <div>Template not found.</div>
                    ) : (
                      <>
                        <div>Standard level {f.level}: verified needs level A.</div>
                        {[...(f.errors ?? []).map((m) => `E ${m}`), ...(f.warnings ?? []).map((m) => `W ${m}`)].map((m, i) => (
                          <div key={i} className="text-red-700">{m}</div>
                        ))}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Library sections grouped by the accounting-system taxonomy: group → subcategory. */
export function AvailCategoryTree<T>({
  categories,
  renderSection,
}: {
  categories: readonly { label: string; templates: T[] }[];
  renderSection: (section: { label: string; path: string; templates: T[] }) => ReactNode;
}) {
  const groups = useMemo(() => groupByTaxonomy(categories), [categories]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <>
      {groups.map((g) => {
        const isOpen = open[g.group] ?? false;
        const count = g.sections.reduce((n, s) => n + s.templates.length, 0);
        return (
          <div key={g.group}>
            <button
              onClick={() => setOpen((o) => ({ ...o, [g.group]: !isOpen }))}
              className="flex items-center gap-1 w-full px-1 mb-0.5 cursor-pointer group/grp"
            >
              <span className={`text-[9px] text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-heading)]">{g.group}</span>
              <span className="text-[10px] text-[var(--color-text-muted)] ml-auto opacity-60">{count}</span>
            </button>
            {isOpen && <div className="pl-2">{g.sections.map((s) => <div key={s.path}>{renderSection(s)}</div>)}</div>}
          </div>
        );
      })}
    </>
  );
}

const LEVEL_CLASS: Record<string, string> = {
  A: "bg-green-100 text-green-800",
  B: "bg-amber-100 text-amber-800",
  FIX: "bg-red-100 text-red-700",
};

/** Linter verdict: level, E/W counts and messages. Used by the review card and the editor. */
export function AvailLintResult({ lint, compact = false }: { lint: BlockLintResult; compact?: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-semibold text-[var(--color-text-heading)]">Linter</span>
        <span className={`rounded px-1.5 py-px font-semibold ${LEVEL_CLASS[lint.level]}`}>{lint.level}</span>
        <span className="text-[var(--color-text-muted)]">
          E {lint.errors.length} · W {lint.warnings.length}
        </span>
      </div>
      {lint.errors.length > 0 && (
        <ul className={`list-disc pl-5 text-red-700 ${compact ? "max-h-24 overflow-y-auto" : ""}`}>
          {lint.errors.map((m, i) => <li key={`e${i}`}>{m}</li>)}
        </ul>
      )}
      {lint.warnings.length > 0 && (
        <ul className={`list-disc pl-5 text-amber-800 ${compact ? "max-h-24 overflow-y-auto" : ""}`}>
          {lint.warnings.map((m, i) => <li key={`w${i}`}>{m}</li>)}
        </ul>
      )}
      {lint.level === "A" && <div className="text-green-800">All formal rules of the standard are met.</div>}
    </div>
  );
}

function DeviceCard({ template }: { template: DeviceTemplate }) {
  return (
    <table className="w-full">
      <tbody>
        {deviceCardRows(template).map((r) => (
          <tr key={r.label}>
            <td className="pr-3 py-px text-[var(--color-text-muted)] whitespace-nowrap align-top">{r.label}</td>
            <td className="py-px break-all">
              {r.href ? (
                <a href={r.href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  {r.value}
                </a>
              ) : (
                r.value
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PortsTable({ template }: { template: DeviceTemplate }) {
  const groups = useMemo(() => portsBySection(template.ports ?? []), [template]);
  if (groups.length === 0) return <div className="text-[var(--color-text-muted)]">No ports.</div>;
  const th = "text-left font-normal text-[var(--color-text-muted)] pr-2 py-px";
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr>
          <th className={th}>Label</th>
          <th className={th}>Direction</th>
          <th className={th}>Signal</th>
          <th className={th}>Connector</th>
          <th className={th}>Notes</th>
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.section}>
          <tr>
            <td colSpan={5} className="pt-2 pb-px font-semibold text-[var(--color-text-heading)]">
              {g.section}
            </td>
          </tr>
          {g.ports.map((p, i) => (
            <tr key={i} className="align-top border-t border-[var(--color-border)]">
              <td className="pr-2 py-px">{p.label}</td>
              <td className="pr-2 py-px">{p.direction}</td>
              <td className="pr-2 py-px">{p.signal}</td>
              <td className={`pr-2 py-px ${p.connector ? "" : "text-red-700"}`}>{p.connector || "—"}</td>
              <td className="py-px text-[var(--color-text-muted)]">{p.notes}</td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

/** Moderator's review card: device card, ports by section, linter, checklist, status buttons. */
export function AvailReviewDialog({ template, onClose }: { template: DeviceTemplate; onClose: () => void }) {
  const lint = useMemo(() => lintBlock(template), [template]);
  const status = statusOfTemplate(template);
  const [checked, setChecked] = useState<boolean[]>(() => REVIEW_CHECKLIST.map(() => false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StatusChangeError | null>(null);
  const [info, setInfo] = useState<TemplateStatusInfo | null>(null);
  const [notes, setNotes] = useState<TemplateNote[]>([]);
  const edit = useStartTemplateEdit();
  const allChecked = checked.every(Boolean);
  const canVerify = lint.level === "A" && allChecked;

  useEffect(() => {
    if (!template.id) return;
    let live = true;
    void fetchTemplateStatus(template.id).then((s) => live && setInfo(s));
    void fetchTemplateNotes(template.id).then((n) => live && setNotes(n));
    return () => {
      live = false;
    };
  }, [template.id]);

  const apply = async (next: TemplateStatus) => {
    if (!template.id) return;
    setBusy(true);
    setError(null);
    try {
      await changeTemplateStatus(template.id, next);
      notifyLibraryChanged();
      onClose();
    } catch (e) {
      setError(e as StatusChangeError);
    } finally {
      setBusy(false);
    }
  };

  const btn = "px-3 py-1.5 rounded text-xs border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
  const hint = lint.level !== "A" ? "Only a level A template can be verified." : !allChecked ? "Tick every checklist item to verify." : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose} onMouseDown={(e) => e.stopPropagation()}>
      <div
        className="bg-white border border-[var(--color-border)] rounded-lg shadow-2xl w-[1040px] max-w-[95vw] max-h-[90vh] flex flex-col cursor-default"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      >
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text-heading)] truncate">Review: {template.label}</h2>
          <AvailStatusBadge status={status} />
          <div className="flex-1" />
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-heading)] text-lg leading-none cursor-pointer" title="Close">
            &times;
          </button>
        </div>

        {status === "verified" && info?.approvedVia && (
          <div data-testid="avail-approved-via" className="px-4 py-2 border-b border-green-200 bg-green-50 text-xs text-green-900">
            {info.approvedVia === "bulk-source"
              ? `Verified by the source of its ports${info.approvedAt ? ` on ${info.approvedAt} UTC` : ""} (approve:catalog): ${info.statusReason ?? "manufacturer's documents"}. The engineer's checklist was not ticked for this template.`
              : info.approvedVia === "bulk"
                ? `Verified with bulk Approve${info.approvedAt ? ` on ${info.approvedAt} UTC` : ""}: the engineer's checklist was not ticked for this template.`
                : `Verified in the Review card${info.approvedAt ? ` on ${info.approvedAt} UTC` : ""}.`}
          </div>
        )}
        {info?.statusReason && !(status === "verified" && info.approvedVia === "bulk-source") && (
          <div className="px-4 py-2 border-b border-amber-200 bg-amber-50 text-xs text-amber-900">
            <span className="font-semibold">Status changed automatically:</span> {info.statusReason}
            {info.statusChangedAt ? ` (${info.statusChangedAt} UTC)` : ""}
          </div>
        )}

        {notes.length > 0 && (
          <div data-testid="avail-template-notes" className="px-4 py-2 border-b border-[var(--color-border)] text-xs text-[var(--color-text)]">
            <div className="font-semibold text-[var(--color-text-heading)]">Notes</div>
            <ul className="mt-1 flex flex-col gap-1">
              {notes.map((n) => (
                <li key={n.id}>
                  {n.body} <span className="text-[var(--color-text-muted)]">({n.authorName}, {n.createdAt} UTC)</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto text-xs grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-4 px-4 py-3">
          <div className="flex flex-col gap-3 min-w-0">
            <section>
              <div className="font-semibold text-[var(--color-text-heading)] mb-1">Device</div>
              <DeviceCard template={template} />
            </section>
            <section>
              <div className="font-semibold text-[var(--color-text-heading)] mb-1">Ports ({template.ports?.length ?? 0})</div>
              <PortsTable template={template} />
            </section>
          </div>

          <div className="flex flex-col gap-3 min-w-0">
            <section>
              <AvailLintResult lint={lint} />
            </section>
            <section>
              <div className="font-semibold text-[var(--color-text-heading)] mb-1">Engineer's checklist (standard, section 8)</div>
              {REVIEW_CHECKLIST.map((item, i) => (
                <label key={item} className="flex items-start gap-2 py-0.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked[i]}
                    onChange={(e) => setChecked((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
                    className="mt-0.5"
                  />
                  <span>{item}</span>
                </label>
              ))}
            </section>
            {(error || edit.error) && (
              <div className="border border-red-200 bg-red-50 rounded p-2 text-red-700">
                <div className="font-semibold">{error?.message ?? edit.error}</div>
                {[...(error?.errors ?? []).map((m) => `E ${m}`), ...(error?.warnings ?? []).map((m) => `W ${m}`)].map((m, i) => (
                  <div key={i}>{m}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center gap-2">
          <button
            disabled={busy || edit.busy || !template.id}
            onClick={async () => {
              if (template.id && (await edit.start(template.id))) onClose();
            }}
            className={`${btn} border-blue-300 text-blue-700 hover:bg-blue-50`}
          >
            Edit
          </button>
          <span className="text-[10px] text-[var(--color-text-muted)] flex-1">{hint}</span>
          <button disabled={busy || status === "draft"} onClick={() => apply("draft")} className={`${btn} border-amber-300 text-amber-800 hover:bg-amber-50`}>
            Move to draft
          </button>
          <button disabled={busy || status === "hidden"} onClick={() => apply("hidden")} className={`${btn} border-gray-300 text-gray-700 hover:bg-gray-50`}>
            Hide
          </button>
          <button disabled={busy || !canVerify || status === "verified"} onClick={() => apply("verified")} className={`${btn} border-green-600 bg-green-600 text-white hover:bg-green-700`}>
            Verify
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Mounted in upstream's Device Editor. Renders only when the editor shows the provisional
 * copy of a library template (the Edit flow): live linter result of the form, and
 * "Save to library" (PUT /templates/:id). After saving, the API re-lints the template and
 * moves a verified one that fell below level A to draft; the bar reports the outcome and
 * closes the editor, which discards the canvas copy.
 */
export function AvailTemplateEditBar({
  nodeId,
  build,
  onSaved,
  onFormReload,
}: {
  nodeId: string | null;
  build: () => Record<string, unknown> | null;
  onSaved: () => void;
  /** Makes the editor re-read its form from the canvas copy (after Normalize is applied). */
  onFormReload?: () => void;
}) {
  const session = editSessionFor(nodeId);
  const addToast = useSchematicStore((s) => s.addToast);
  const updateDevice = useSchematicStore((s) => s.updateDevice);
  const node = useSchematicStore((s) => (nodeId ? s.nodes.find((n) => n.id === nodeId) : undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = useMemo(() => {
    if (!session) return null;
    const data = build();
    if (!data) return null;
    const slots = (node?.data as { slots?: Parameters<typeof slotOwnedPortIds>[0] } | undefined)?.slots;
    return deviceDataToTemplate(data, session.original, slotOwnedPortIds(slots));
  }, [session, build, node]);
  const lint = useMemo(() => (draft ? lintBlock(draft) : null), [draft]);
  const [showNormalize, setShowNormalize] = useState(false);
  const normalized = useMemo(
    () => (showNormalize && draft ? normalizeBlock(draft as unknown as Record<string, unknown>) : null),
    [showNormalize, draft],
  );

  if (!session || !draft || !lint) return null;

  const save = async (template: NonNullable<typeof draft>) => {
    setBusy(true);
    setError(null);
    try {
      await saveLibraryTemplate(session.templateId, template);
      if (nodeId) endEditSession(nodeId);
      const info = await fetchTemplateStatus(session.templateId);
      notifyLibraryChanged();
      if (info?.statusReason && info.status === "draft") {
        addToast(`Saved to the library. ${info.statusReason}. The template is now a draft.`, "info");
      } else {
        addToast(`Saved to the library: level ${info?.lintLevel ?? lintBlock(template).level}, status ${info?.status ?? "unchanged"}.`, "success");
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const btn = "px-3 py-1.5 rounded text-xs border cursor-pointer disabled:opacity-40";
  return (
    <div data-testid="avail-template-edit-bar" className="px-4 py-2 border-t border-blue-200 bg-blue-50 text-xs flex flex-col gap-1.5">
      <div className="text-blue-900">
        Editing library template <span className="font-semibold">{session.original.label}</span>. Save to library writes it for everyone;
        closing the editor discards this canvas copy.
      </div>
      <AvailLintResult lint={lint} compact />
      {lint.level !== "A" && (
        <div className="text-amber-900">A verified template saved below level A becomes a draft.</div>
      )}
      {normalized && <AvailNormalizePreview before={lint} result={normalized} />}
      {error && <div className="text-red-700 font-semibold">{error}</div>}
      <div className="flex justify-end gap-2">
        {normalized ? (
          <>
            <button onClick={() => setShowNormalize(false)} disabled={busy} className={`${btn} border-gray-300 text-gray-700 hover:bg-gray-50`}>
              Discard normalization
            </button>
            <button
              onClick={() => {
                const data = build();
                if (!data || !nodeId) return;
                updateDevice(nodeId, applyTemplateToDeviceData(data, normalized.template) as never);
                setShowNormalize(false);
                onFormReload?.();
              }}
              disabled={busy || appliedChanges(normalized.changes).length === 0}
              className={`${btn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
              title="Write the normalized values into the form; check them and Save to library"
            >
              Apply to form
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setShowNormalize(true)}
              disabled={busy}
              className={`${btn} border-blue-300 text-blue-700 hover:bg-blue-100`}
              title="Run the normalizer on this template and show the changes before saving"
            >
              Normalize
            </button>
            <button onClick={() => save(draft)} disabled={busy} className={`${btn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}>
              Save to library
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** What the normalizer would change in the edited template, and the linter after it. */
function AvailNormalizePreview({ before, result }: { before: BlockLintResult; result: NormalizeResult<Record<string, unknown>> }) {
  const after = useMemo(() => lintBlock(result.template), [result]);
  const labels = useMemo(() => portLabelMap(result.template.ports), [result]);
  const applied = appliedChanges(result.changes);
  const manual = result.changes.filter((c) => c.manual);
  return (
    <div data-testid="avail-normalize-preview" className="border border-blue-200 bg-white rounded p-2 flex flex-col gap-1">
      <div className="font-semibold text-[var(--color-text-heading)]">
        {applied.length === 0 ? "The normalizer has nothing to change." : `Normalizer: ${applied.length} changes`}
        <span className="font-normal text-[var(--color-text-muted)]">
          {" "}
          (level {before.level} → {after.level}, E {before.errors.length} → {after.errors.length}, W {before.warnings.length} → {after.warnings.length})
        </span>
      </div>
      {applied.length > 0 && (
        <ul className="list-disc pl-5 max-h-32 overflow-y-auto">
          {applied.map((c, i) => <li key={i}>{describeChange(c, labels)}</li>)}
        </ul>
      )}
      {manual.length > 0 && (
        <>
          <div className="text-amber-900">Needs a person:</div>
          <ul className="list-disc pl-5 max-h-24 overflow-y-auto text-amber-900">
            {manual.map((c, i) => <li key={i}>{describeChange(c, labels)}</li>)}
          </ul>
        </>
      )}
      <div className="text-[var(--color-text-muted)]">Apply to form writes these changes into the form; nothing is saved until Save to library.</div>
    </div>
  );
}

/** Warning in the schematic reports when the project has blocks from unverified templates. */
export function AvailUnverifiedNotice({ nodes }: { nodes: readonly { id: string; type?: string; data: unknown }[] }) {
  useAvailState();
  const blocks = useMemo(() => unverifiedBlocks(nodes), [nodes]);
  if (blocks.length === 0) return null;
  const names = blocks.slice(0, 8).map((b) => b.label).join(", ");
  const more = blocks.length - 8;
  return (
    <div className="px-4 py-2 border-b border-red-200 bg-red-50 text-xs text-red-700 shrink-0">
      <div className="font-semibold">
        {blocks.length === 1
          ? "This project has 1 block from an unverified template."
          : `This project has ${blocks.length} blocks from unverified templates.`}
      </div>
      <div>Blocks: {names}{more > 0 ? ` (+${more} more)` : ""}</div>
      <div>Before handing the project to a customer, replace them or send their templates for review.</div>
    </div>
  );
}
