/**
 * AVAIL account menu entries and admin pages (step 2.1): the user's role, Users (admin) and the
 * Audit log (librarian and admin). Mounted from upstream's UserMenuButton: the entries inside its
 * dropdown, the dialogs next to it (they outlive the dropdown).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AUDIT_ACTION_LABELS, auditChanges, fetchAudit, fetchUsers, setUserActive, setUserRole, type AuditRecord, type AvailUser } from "./adminApi";
import { openAdminPage, useAdminPage, type AdminPage } from "./adminPages";
import { loadRole } from "./api";
import { isAvailBuild } from "./brand";
import { useAvailState, useStartTemplateEdit } from "./useAvail";
import { AVAIL_ROLES, availRoleOf, ROLE_DESCRIPTIONS, ROLE_LABELS, type AvailRole } from "./roles";

// ---------------------------------------------------------------------------- menu entries

const itemClass = "w-full text-left px-3 py-2 text-xs hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer";

/** Role line and the Users / Audit log entries of the account menu. */
export function AvailAccountMenuItems({ onPick }: { onPick: () => void }) {
  const { role } = useAvailState();
  useEffect(() => {
    void loadRole();
  }, []);
  if (!isAvailBuild() || !role) return null;
  const r = availRoleOf(role);
  const pick = (p: AdminPage) => () => {
    onPick();
    openAdminPage(p);
  };
  return (
    <>
      <div data-testid="avail-role" className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
        Role: {ROLE_LABELS[r]}
      </div>
      {r === "admin" && (
        <button onClick={pick("users")} className={itemClass} style={{ color: "var(--color-text)" }}>
          Users
        </button>
      )}
      {(r === "admin" || r === "librarian") && (
        <a href="/library" onClick={onPick} className={`block ${itemClass}`} style={{ color: "var(--color-text)" }}>
          Library workspace
        </a>
      )}
      {(r === "admin" || r === "librarian") && (
        <button onClick={pick("audit")} className={itemClass} style={{ color: "var(--color-text)" }}>
          Audit log
        </button>
      )}
    </>
  );
}

/** The open admin page, if any. */
export function AvailAdminDialogs() {
  const p = useAdminPage();
  if (!isAvailBuild()) return null;
  if (!p) return <AvailEditFromUrl />;
  const close = () => openAdminPage(null);
  return createPortal(p === "users" ? <UsersDialog onClose={close} /> : <AuditLogDialog onClose={close} />, document.body);
}

/**
 * Edit from the library workspace: /?availEdit=<template id> opens upstream's Device Editor on
 * that library template (the same Edit session as the Review card), then drops the parameter.
 */
function AvailEditFromUrl() {
  const { start, error } = useStartTemplateEdit();
  const [id] = useState(() => new URLSearchParams(window.location.search).get(EDIT_PARAM));
  const started = useRef(false);
  useEffect(() => {
    if (!id || started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete(EDIT_PARAM);
    window.history.replaceState(null, "", url.toString());
    void start(id);
  }, [id, start]);
  if (!error) return null;
  return createPortal(
    <div role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-red-50 border border-red-300 text-red-800 rounded px-3 py-2 text-xs">
      Could not open the template for editing: {error}
    </div>,
    document.body,
  );
}

/** Query parameter of the workspace's Edit button. */
export const EDIT_PARAM = "availEdit";

// ---------------------------------------------------------------------------- shared frame

function Dialog({ title, onClose, children, testId }: { title: string; onClose: () => void; children: React.ReactNode; testId: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose} onMouseDown={(e) => e.stopPropagation()}>
      <div
        data-testid={testId}
        className="bg-white border border-[var(--color-border)] rounded-lg shadow-2xl w-[960px] max-w-[95vw] max-h-[85vh] flex flex-col cursor-default text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center">
          <h2 className="text-sm font-semibold text-[var(--color-text-heading)] flex-1">{title}</h2>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-heading)] text-lg leading-none cursor-pointer" title="Close">
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const when = (s: string | null) => (s ? `${s} UTC` : "Never");

// ---------------------------------------------------------------------------- Users

export function UsersDialog({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<AvailUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetchUsers().then(setUsers, (e: Error) => setError(e.message));
  }, []);

  const apply = async (id: string, change: () => Promise<AvailUser>) => {
    setBusy(id);
    setError(null);
    try {
      const updated = await change();
      setUsers((list) => list?.map((u) => (u.id === id ? updated : u)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog title="Users" onClose={onClose} testId="avail-users">
      <div className="px-4 py-2 border-b border-[var(--color-border)] text-[var(--color-text-muted)] flex flex-col gap-0.5">
        {AVAIL_ROLES.map((r) => (
          <div key={r}>
            <span className="font-semibold">{ROLE_LABELS[r]}:</span> {ROLE_DESCRIPTIONS[r]}
          </div>
        ))}
      </div>
      {error && <div className="px-4 py-2 bg-red-50 text-red-800 border-b border-red-200">{error}</div>}
      <div className="overflow-y-auto">
        {!users && !error && <div className="px-4 py-3 text-[var(--color-text-muted)]">Loading…</div>}
        {users && (
          <table className="w-full">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium">Email</th>
                <th className="px-2 py-2 font-medium">Role</th>
                <th className="px-2 py-2 font-medium">Last sign-in</th>
                <th className="px-2 py-2 font-medium">Access</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} data-testid="avail-user-row" className={`border-t border-[var(--color-border)] ${u.active ? "" : "text-[var(--color-text-muted)]"}`}>
                  <td className="px-4 py-1.5">{u.name || "—"}</td>
                  <td className="px-2 py-1.5">{u.email}</td>
                  <td className="px-2 py-1.5">
                    {u.system ? (
                      <span
                        data-testid="avail-user-system"
                        className="rounded px-1.5 py-px bg-gray-100 text-gray-700"
                        title="System account: its role and access cannot be changed"
                      >
                        System
                      </span>
                    ) : (
                      <select
                        aria-label={`Role of ${u.email}`}
                        value={u.role}
                        disabled={busy === u.id}
                        onChange={(e) => apply(u.id, () => setUserRole(u.id, e.target.value as AvailRole))}
                        className="border border-[var(--color-border)] rounded px-1 py-0.5 bg-transparent cursor-pointer"
                      >
                        {AVAIL_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-2 py-1.5">{when(u.lastLoginAt)}</td>
                  <td className="px-2 py-1.5">
                    {u.system ? (
                      <span className="text-[var(--color-text-muted)]">System</span>
                    ) : (
                      <>
                        <span className={u.active ? "text-green-700" : "text-red-700"}>{u.active ? "Active" : "Disabled"}</span>{" "}
                        <button
                          disabled={busy === u.id}
                          onClick={() => apply(u.id, () => setUserActive(u.id, !u.active))}
                          className="ml-1 underline cursor-pointer disabled:opacity-40"
                        >
                          {u.active ? "Disable" : "Enable"}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Audit log

const PAGE = 100;
type EntityFilter = "all" | "user" | "template" | "run";
const ENTITY_FILTER_LABELS: Readonly<Record<EntityFilter, string>> = { all: "Everything", user: "Users", template: "Templates", run: "Command runs" };

export function AuditLogDialog({ onClose }: { onClose: () => void }) {
  const [entity, setEntity] = useState<EntityFilter>("all");
  const [rows, setRows] = useState<AuditRecord[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await fetchAudit({ entity: entity === "all" ? undefined : entity, before, limit: PAGE });
        setRows((r) => (before ? [...r, ...page] : page));
        setMore(page.length === PAGE);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [entity],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Dialog title="Audit log" onClose={onClose} testId="avail-audit">
      <div className="px-4 py-2 border-b border-[var(--color-border)] flex items-center gap-2">
        <label className="text-[var(--color-text-muted)]" htmlFor="avail-audit-entity">
          Show
        </label>
        <select
          id="avail-audit-entity"
          value={entity}
          onChange={(e) => setEntity(e.target.value as EntityFilter)}
          className="border border-[var(--color-border)] rounded px-1 py-0.5 bg-transparent cursor-pointer"
        >
          {(Object.keys(ENTITY_FILTER_LABELS) as EntityFilter[]).map((f) => (
            <option key={f} value={f}>
              {ENTITY_FILTER_LABELS[f]}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="px-4 py-2 bg-red-50 text-red-800 border-b border-red-200">{error}</div>}
      <div className="overflow-y-auto">
        <table className="w-full">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-medium whitespace-nowrap">When (UTC)</th>
              <th className="px-2 py-2 font-medium">Who</th>
              <th className="px-2 py-2 font-medium">What</th>
              <th className="px-2 py-2 font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid="avail-audit-row" className="border-t border-[var(--color-border)] align-top">
                <td className="px-4 py-1.5 whitespace-nowrap">{r.at}</td>
                <td className="px-2 py-1.5">{r.actor}</td>
                <td className="px-2 py-1.5">
                  <div>{AUDIT_ACTION_LABELS[r.action]}</div>
                  <div className="text-[var(--color-text-muted)]">{r.entityLabel ?? r.entityId}</div>
                </td>
                <td className="px-2 py-1.5 font-mono text-[10px] break-all">
                  {auditChanges(r).map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && !error && <div className="px-4 py-3 text-[var(--color-text-muted)]">No changes recorded yet.</div>}
        {loading && <div className="px-4 py-3 text-[var(--color-text-muted)]">Loading…</div>}
        {more && !loading && (
          <button onClick={() => load(rows[rows.length - 1]?.id)} className="mx-4 my-2 underline cursor-pointer">
            Load older entries
          </button>
        )}
      </div>
    </Dialog>
  );
}
