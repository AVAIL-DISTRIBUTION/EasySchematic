/**
 * Claude connections of a user on the Users page (admin; OAuth, api-avail/src/oauth.ts): which client,
 * when access was granted, last use, state, and Revoke. Disabling the user revokes them all.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchClaudeAccess, revokeClaudeAccess, type AvailUser, type ClaudeAccess } from "./adminApi";

const STATE_TEXT: Readonly<Record<ClaudeAccess["state"], string>> = { active: "Active", expired: "Expired", revoked: "Revoked" };
const STATE_CLASS: Readonly<Record<ClaudeAccess["state"], string>> = { active: "text-green-700", expired: "text-amber-800", revoked: "text-red-700" };
const when = (t: string | null) => (t ? t.slice(0, 16) : "never");

export function ClaudeAccessPanel({ user, onChanged }: { user: AvailUser; onChanged: () => void }) {
  const [list, setList] = useState<ClaudeAccess[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchClaudeAccess(user.id).then(setList, (e: Error) => setError(e.message));
  }, [user.id]);
  useEffect(load, [load]);

  const revoke = async (g: ClaudeAccess) => {
    if (!window.confirm(`Revoke ${g.client} access of ${user.email}? Claude stops working for them until they connect again.`)) return;
    setBusy(true);
    setError(null);
    try {
      await revokeClaudeAccess(g.id);
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="avail-claude-access" className="flex flex-col gap-2 py-2">
      <div className="text-[var(--color-text-muted)]">
        Claude connects as {user.email} with their role and rights; what it changes is logged as them, marked “via Claude”.
      </div>
      {error && <div className="text-red-700">{error}</div>}
      {list === null && !error && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {list?.length === 0 && <div className="text-[var(--color-text-muted)]">No Claude connections.</div>}
      {!!list?.length && (
        <table className="w-full">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="py-1 font-medium">Client</th>
              <th className="px-2 py-1 font-medium">Granted</th>
              <th className="px-2 py-1 font-medium">Last used</th>
              <th className="px-2 py-1 font-medium">State</th>
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <tr key={g.id} data-testid="avail-claude-access-row" className="border-t border-[var(--color-border)]">
                <td className="py-1">{g.client}</td>
                <td className="px-2 py-1">{when(g.createdAt)}</td>
                <td className="px-2 py-1">{when(g.lastUsedAt)}</td>
                <td className={`px-2 py-1 ${STATE_CLASS[g.state]}`} title={g.revokedAt ? `${g.revokedBy ?? ""}: ${g.revokedReason ?? ""}` : `Expires ${when(g.expiresAt)} unless used`}>
                  {STATE_TEXT[g.state]}
                  {g.revokedAt ? ` ${when(g.revokedAt)}` : ""}
                </td>
                <td className="px-2 py-1 text-right">
                  {g.state === "active" && (
                    <button className="underline cursor-pointer disabled:opacity-40" disabled={busy} onClick={() => void revoke(g)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
