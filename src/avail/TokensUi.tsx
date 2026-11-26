/**
 * Access tokens of an AI Assistant user on the Users page (admin; step 2.5, api-avail/src/accessTokens.ts):
 * the list with last use and state, a new token (name and expiry required; its value is shown
 * once), and Revoke.
 */
import { useCallback, useEffect, useState } from "react";
import { createToken, expiryDate, fetchTokens, revokeToken, TOKEN_EXPIRY_DAYS, type AccessToken, type AvailUser } from "./adminApi";

const STATE_TEXT: Readonly<Record<AccessToken["state"], string>> = { active: "Active", expired: "Expired", revoked: "Revoked" };
const STATE_CLASS: Readonly<Record<AccessToken["state"], string>> = { active: "text-green-700", expired: "text-amber-800", revoked: "text-red-700" };
const EXPIRY_LABELS: Readonly<Record<(typeof TOKEN_EXPIRY_DAYS)[number], string>> = { 30: "30 days", 90: "90 days", 365: "1 year" };

const day = (t: string | null) => (t ? t.slice(0, 16) : "never");

export function TokensPanel({ user, onChanged }: { user: AvailUser; onChanged: () => void }) {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [expires, setExpires] = useState(() => expiryDate(90));
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    fetchTokens(user.id).then(setTokens, (e: Error) => setError(e.message));
  }, [user.id]);
  useEffect(load, [load]);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const r = await createToken(user.id, name.trim(), expires);
      setCreated({ name: r.token.name, value: r.value });
      setCopied(false);
      setName("");
    });

  const input = "border border-[var(--color-border)] rounded px-1.5 py-0.5 bg-transparent";
  return (
    <div data-testid="avail-tokens" className="flex flex-col gap-2 py-2">
      {created && (
        <div data-testid="avail-token-value" className="border border-green-300 bg-green-50 rounded p-2 flex flex-col gap-1">
          <div className="font-semibold text-green-900">Token “{created.name}” created. Copy it now: it is not shown again.</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all bg-white border border-green-200 rounded px-1.5 py-1 select-all">{created.value}</code>
            <button
              className="underline cursor-pointer"
              onClick={() => {
                void navigator.clipboard?.writeText(created.value).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="underline cursor-pointer" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
          <div className="text-[var(--color-text-muted)]">Use it as an HTTP header: Authorization: Bearer &lt;token&gt;</div>
        </div>
      )}
      {error && <div className="text-red-700 font-semibold">{error}</div>}
      {!tokens && !error && <div className="text-[var(--color-text-muted)]">Loading tokens…</div>}
      {tokens && tokens.length === 0 && <div className="text-[var(--color-text-muted)]">No tokens yet.</div>}
      {tokens && tokens.length > 0 && (
        <table className="w-full">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="py-1 font-medium">Token</th>
              <th className="px-2 py-1 font-medium">Created</th>
              <th className="px-2 py-1 font-medium">Expires</th>
              <th className="px-2 py-1 font-medium">Last used</th>
              <th className="px-2 py-1 font-medium">State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} data-testid="avail-token-row" className="border-t border-[var(--color-border)]">
                <td className="py-1">
                  <span className="font-semibold">{t.name}</span> <span className="text-[var(--color-text-muted)] font-mono">…{t.hint}</span>
                </td>
                <td className="px-2 py-1">
                  {day(t.createdAt)} <span className="text-[var(--color-text-muted)]">by {t.createdBy}</span>
                </td>
                <td className="px-2 py-1">{t.expiresAt.slice(0, 10)}</td>
                <td className="px-2 py-1">{day(t.lastUsedAt)}</td>
                <td className={`px-2 py-1 ${STATE_CLASS[t.state]}`} title={t.revokedAt ? `${t.revokedReason ?? ""} — ${t.revokedBy ?? ""}, ${t.revokedAt}` : undefined}>
                  {STATE_TEXT[t.state]}
                </td>
                <td className="px-2 py-1 text-right">
                  {t.state === "active" && (
                    <button className="underline cursor-pointer text-red-700 disabled:opacity-40" disabled={busy} onClick={() => run(async () => void (await revokeToken(t.id)))}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {user.active ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">New token:</span>
          <input
            aria-label="Token name"
            placeholder="Name: what it is for, e.g. Claude Code — library review"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className={`${input} flex-1 min-w-[240px]`}
          />
          <label className="flex items-center gap-1">
            Expires
            <input aria-label="Expires on" type="date" required value={expires} onChange={(e) => setExpires(e.target.value)} className={input} />
          </label>
          {TOKEN_EXPIRY_DAYS.map((d) => (
            <button key={d} className="underline cursor-pointer" onClick={() => setExpires(expiryDate(d))}>
              {EXPIRY_LABELS[d]}
            </button>
          ))}
          <button
            className="px-2 py-0.5 rounded border border-blue-600 bg-blue-600 text-white cursor-pointer disabled:opacity-40"
            disabled={busy || !name.trim() || !expires}
            onClick={() => void create()}
          >
            Create token
          </button>
        </div>
      ) : (
        <div className="text-[var(--color-text-muted)]">The user is disabled: their tokens are revoked. Enable them to create a new one.</div>
      )}
    </div>
  );
}
