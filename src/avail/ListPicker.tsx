/**
 * Choice from a reference list (src/avail/referenceLists.ts): a text box that searches the list, grouped
 * options, keyboard (↑ ↓ Enter Esc). Only a listed option can be picked: typing a name or an alias
 * exactly and leaving the box picks it, anything else goes back to the current value. A current
 * value outside the list stays as it is, marked "not in the list".
 *
 * AvailCategoryField and AvailManufacturerField are the Device Editor's fields in the AVAIL build.
 */
import { useId, useMemo, useRef, useState } from "react";
import { categoryOptions, exactOption, filterOptions, groupOptions, inList, NOT_IN_LIST, vendorOptions, type PickOption } from "./referenceLists";

const inputClass =
  "w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1.5 text-xs text-[var(--color-text-heading)] outline-none focus:border-blue-500";

export function AvailListPicker({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  testId,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly PickOption[];
  placeholder?: string;
  ariaLabel: string;
  testId?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(autoFocus);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const groups = useMemo(() => groupOptions(shown), [shown]);
  const outside = value.trim() !== "" && !inList(options, value);

  const pick = (o: PickOption) => {
    onChange(o.value);
    setOpen(false);
    setQuery("");
  };
  const close = () => {
    // An exact name or alias typed in picks that option; anything else keeps the current value.
    const exact = exactOption(options, query);
    if (exact && exact.value !== value) onChange(exact.value);
    setOpen(false);
    setQuery("");
  };
  const move = (by: number) => {
    const n = shown.length;
    if (!n) return;
    const next = (active + by + n) % n;
    setActive(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="relative" data-testid={testId}>
      <div className="relative">
        <input
          className={`${inputClass} ${outside && !open ? "pr-20" : ""}`}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoFocus={autoFocus}
          value={open ? query : value}
          placeholder={open ? (value || placeholder) : placeholder}
          onFocus={() => {
            setOpen(true);
            setQuery("");
            setActive(0);
          }}
          onBlur={close}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            if (!open) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) setOpen(true);
              else move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const o = exactOption(options, query) ?? shown[active];
              if (o) pick(o);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setQuery("");
            }
          }}
        />
        {outside && !open && (
          <span
            data-testid="avail-not-in-list"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] rounded px-1 bg-amber-100 text-amber-800 pointer-events-none"
            title="This value is not in the reference list. Pick a value from the list; a new value outside it cannot be saved."
          >
            {NOT_IN_LIST}
          </span>
        )}
      </div>
      {open && (
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          className="absolute z-50 mt-0.5 w-full max-h-64 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg text-xs"
        >
          {shown.length === 0 && <div className="px-2 py-1.5 text-[var(--color-text-muted)]">Nothing in the list matches.</div>}
          {groups.map((g) => (
            <div key={g.group}>
              <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{g.group}</div>
              {g.options.map((o) => {
                const i = shown.indexOf(o);
                return (
                  <div
                    key={o.value}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    onMouseDown={(e) => {
                      // Before the input's blur, which would close the list.
                      e.preventDefault();
                      pick(o);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={`pl-4 pr-2 py-0.5 cursor-pointer flex items-center gap-1.5 ${i === active ? "bg-blue-100 text-blue-900" : ""} ${o.value === value ? "font-semibold" : ""}`}
                  >
                    <span className="truncate">{o.label}</span>
                    {o.hint && <span className="text-[10px] text-[var(--color-text-muted)] truncate">{o.hint}</span>}
                    {o.tag && (
                      <span className="ml-auto shrink-0 text-[9px] rounded px-1 bg-gray-200 text-gray-700" title="Not a schematic block: the item appears only in the BoQ / BoM">
                        {o.tag}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CATEGORY_OPTIONS = categoryOptions();
const VENDOR_OPTIONS = vendorOptions();

/** Category of the Device Editor (AVAIL build): a leaf of the taxonomy. */
export function AvailCategoryField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <AvailListPicker value={value} onChange={onChange} options={CATEGORY_OPTIONS} placeholder="Search categories…" ariaLabel="Category" testId="avail-category-field" />;
}

/** Manufacturer of the Device Editor (AVAIL build): a vendor of the list; an alias picks its canonical name. */
export function AvailManufacturerField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <AvailListPicker value={value} onChange={onChange} options={VENDOR_OPTIONS} placeholder="Search vendors…" ariaLabel="Manufacturer" testId="avail-manufacturer-field" />;
}
