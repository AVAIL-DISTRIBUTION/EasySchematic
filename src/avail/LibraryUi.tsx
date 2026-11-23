/**
 * AVAIL library UI: status badges, the "show unverified" switch, taxonomy grouping,
 * the moderator review card and the report notice. Each component renders nothing
 * outside AVAIL mode (see libraryMode.ts), so the upstream files they are mounted in
 * behave as upstream against upstream's API.
 */
import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { lintBlock } from "./blockLint";
import { changeTemplateStatus, type StatusChangeError } from "./api";
import { blockStatus, notifyLibraryChanged, setShowUnverified, statusBadge, statusOfTemplate, type TemplateStatus } from "./libraryMode";
import { groupByTaxonomy, REVIEW_CHECKLIST, unverifiedBlocks } from "./libraryView";
import { useAvailState } from "./useAvail";
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

/** Library list item extras: status badge and, for moderators, the review button. */
export function AvailTemplateExtras({ template }: { template: DeviceTemplate }) {
  const { active, moderator } = useAvailState();
  const [reviewing, setReviewing] = useState(false);
  if (!active) return null;
  const status = statusOfTemplate(template);
  if (!statusBadge(status) && !(moderator && template.id)) return null;
  return (
    <span className="flex items-center gap-1">
      <AvailStatusBadge status={status} />
      {moderator && template.id && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setReviewing(true);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="text-[8px] rounded px-1 py-px font-normal shrink-0 text-blue-600 hover:bg-blue-50 opacity-0 group-hover:opacity-100 cursor-pointer"
          title="Ревью шаблона"
        >
          ревью
        </button>
      )}
      {reviewing && createPortal(<AvailReviewDialog template={template} onClose={() => setReviewing(false)} />, document.body)}
    </span>
  );
}

/** «Показать непроверенные» in the library panel; remembered in the browser. */
export function AvailLibraryToggle() {
  const { active, showUnverified, moderator } = useAvailState();
  if (!active) return null;
  return (
    <label
      className="flex items-center gap-1.5 px-1 text-[10px] text-[var(--color-text-muted)] cursor-pointer select-none"
      title={moderator ? "Добавить в библиотеку шаблоны raw и hidden" : "Добавить в библиотеку шаблоны raw (не проверены AVAIL)"}
    >
      <input type="checkbox" checked={showUnverified} onChange={(e) => setShowUnverified(e.target.checked)} className="cursor-pointer" />
      Показать непроверенные
    </label>
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

/** Moderator's review card: linter result, the standard's checklist, status buttons. */
export function AvailReviewDialog({ template, onClose }: { template: DeviceTemplate; onClose: () => void }) {
  const lint = useMemo(() => lintBlock(template), [template]);
  const status = statusOfTemplate(template);
  const [checked, setChecked] = useState<boolean[]>(() => REVIEW_CHECKLIST.map(() => false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StatusChangeError | null>(null);
  const allChecked = checked.every(Boolean);
  const canVerify = lint.level === "A" && allChecked;

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

  const levelClass = lint.level === "A" ? "bg-green-100 text-green-800" : lint.level === "B" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700";
  const btn = "px-3 py-1.5 rounded text-xs border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose} onMouseDown={(e) => e.stopPropagation()}>
      <div
        className="bg-white border border-[var(--color-border)] rounded-lg shadow-2xl w-[560px] max-h-[85vh] flex flex-col cursor-default"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      >
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text-heading)] truncate">{template.label}</h2>
          <AvailStatusBadge status={status} />
          <div className="flex-1" />
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-heading)] text-lg leading-none cursor-pointer" title="Закрыть">
            &times;
          </button>
        </div>

        <div className="px-4 py-3 overflow-y-auto text-xs flex flex-col gap-3">
          <div className="text-[var(--color-text-muted)]">
            {[template.manufacturer, template.modelNumber, template.category ?? "без категории"].filter(Boolean).join(" · ")}
          </div>

          <section>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-semibold text-[var(--color-text-heading)]">Линтер</span>
              <span className={`rounded px-1.5 py-px font-semibold ${levelClass}`}>{lint.level}</span>
              <span className="text-[var(--color-text-muted)]">ошибок {lint.errors.length}, предупреждений {lint.warnings.length}</span>
            </div>
            {lint.errors.length > 0 && (
              <ul className="list-disc pl-5 text-red-700">{lint.errors.map((m, i) => <li key={`e${i}`}>{m}</li>)}</ul>
            )}
            {lint.warnings.length > 0 && (
              <ul className="list-disc pl-5 text-amber-800">{lint.warnings.map((m, i) => <li key={`w${i}`}>{m}</li>)}</ul>
            )}
            {lint.level === "A" && <div className="text-green-800">Формальные правила стандарта выполнены.</div>}
          </section>

          <section>
            <div className="font-semibold text-[var(--color-text-heading)] mb-1">Чек-лист инженера (стандарт, п. 8)</div>
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

          {error && (
            <div className="border border-red-200 bg-red-50 rounded p-2 text-red-700">
              <div className="font-semibold">{error.message}</div>
              {[...(error.errors ?? []).map((m) => `E ${m}`), ...(error.warnings ?? []).map((m) => `W ${m}`)].map((m, i) => (
                <div key={i}>{m}</div>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-text-muted)] flex-1">
            {lint.level !== "A" ? "Утвердить можно только шаблон уровня A." : !allChecked ? "Отметьте все пункты чек-листа." : ""}
          </span>
          <button disabled={busy || status === "draft"} onClick={() => apply("draft")} className={`${btn} border-amber-300 text-amber-800 hover:bg-amber-50`}>
            В черновик
          </button>
          <button disabled={busy || status === "hidden"} onClick={() => apply("hidden")} className={`${btn} border-gray-300 text-gray-700 hover:bg-gray-50`}>
            Скрыть
          </button>
          <button disabled={busy || !canVerify || status === "verified"} onClick={() => apply("verified")} className={`${btn} border-green-600 bg-green-600 text-white hover:bg-green-700`}>
            Утвердить
          </button>
        </div>
      </div>
    </div>
  );
}

/** Warning in the schematic reports when the project has blocks from unverified templates. */
export function AvailUnverifiedNotice({ nodes }: { nodes: readonly { id: string; type?: string; data: unknown }[] }) {
  useAvailState();
  const blocks = useMemo(() => unverifiedBlocks(nodes), [nodes]);
  if (blocks.length === 0) return null;
  const names = blocks.slice(0, 8).map((b) => b.label).join(", ");
  return (
    <div className="px-4 py-2 border-b border-red-200 bg-red-50 text-xs text-red-700 shrink-0">
      <span className="font-semibold">В проекте {blocks.length} {plural(blocks.length)} из непроверенных шаблонов</span>
      {" "}(не проверены AVAIL): {names}
      {blocks.length > 8 ? ` и ещё ${blocks.length - 8}` : ""}. Перед выдачей заказчику замените их или отправьте шаблоны на ревью.
    </div>
  );
}

function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "блок";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "блока";
  return "блоков";
}
