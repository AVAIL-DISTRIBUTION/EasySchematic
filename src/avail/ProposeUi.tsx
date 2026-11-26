/**
 * Propose change (step 2.2): in upstream's Device Editor an engineer editing a block that came
 * from a library template can send the edited copy with a comment as a proposal (an upstream
 * submission, action "update"). Librarians review it in the library workspace (/library,
 * Proposals tab). The engineer sees their earlier proposals for the template with the decision.
 * Rendered by AvailTemplateEditBar when there is no Edit session.
 */
import { useEffect, useState } from "react";
import { slotOwnedPortIds } from "../slotDefinitions";
import { useSchematicStore } from "../store";
import { fetchLibraryTemplate } from "./api";
import { isAvailLibrary } from "./libraryMode";
import { deviceDataToTemplate } from "./templateEdit";
import { useAvailState } from "./useAvail";
import { fetchMyProposals, proposeChange, type Proposal } from "./workspaceApi";

const STATUS_TEXT: Readonly<Record<Proposal["status"], string>> = {
  pending: "waiting for review",
  deferred: "deferred",
  approved: "accepted",
  rejected: "rejected",
};

export function AvailProposeChange({ nodeId, build }: { nodeId: string | null; build: () => Record<string, unknown> | null }) {
  const { role } = useAvailState();
  const node = useSchematicStore((s) => (nodeId ? s.nodes.find((n) => n.id === nodeId) : undefined));
  const templateId = (node?.data as { templateId?: string } | undefined)?.templateId;
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [mine, setMine] = useState<Proposal[]>([]);

  const engineer = role === "contributor";
  useEffect(() => {
    if (!engineer || !templateId || !isAvailLibrary()) return;
    let live = true;
    fetchMyProposals().then(
      (list) => live && setMine(list.filter((p) => p.templateId === templateId).slice(0, 3)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [engineer, templateId, message]);

  if (!engineer || !templateId || !isAvailLibrary()) return null;

  const send = async () => {
    const data = build();
    if (!data) return;
    setBusy(true);
    setMessage(null);
    try {
      const original = await fetchLibraryTemplate(templateId);
      const slots = (node?.data as { slots?: Parameters<typeof slotOwnedPortIds>[0] } | undefined)?.slots;
      const template = deviceDataToTemplate(data, original, slotOwnedPortIds(slots));
      await proposeChange(templateId, template, comment.trim());
      setMessage({ ok: true, text: "Proposal sent. A librarian will review it; the decision shows here." });
      setOpen(false);
      setComment("");
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const btn = "px-3 py-1.5 rounded text-xs border cursor-pointer disabled:opacity-40";
  return (
    <div data-testid="avail-propose" className="px-4 py-2 border-t border-[var(--color-border)] text-xs flex flex-col gap-1.5">
      {!open && (
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-text-muted)] flex-1">Found a mistake in this library block? Propose the fix to the librarians.</span>
          <button onClick={() => setOpen(true)} className={`${btn} border-blue-300 text-blue-700 hover:bg-blue-50`}>
            Propose change
          </button>
        </div>
      )}
      {open && (
        <>
          <div className="text-[var(--color-text-heading)] font-semibold">Propose this edited block as a change to the library template</div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What is wrong and where the right value comes from (data sheet, panel photo…)"
            className="border border-[var(--color-border)] rounded p-1 h-16"
            aria-label="Comment for the librarians"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setOpen(false)} disabled={busy} className={`${btn} border-gray-300 text-gray-700 hover:bg-gray-50`}>
              Cancel
            </button>
            <button onClick={() => void send()} disabled={busy || !comment.trim()} className={`${btn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}>
              {busy ? "Sending…" : "Send proposal"}
            </button>
          </div>
        </>
      )}
      {message && <div className={message.ok ? "text-green-800" : "text-red-700 font-semibold"}>{message.text}</div>}
      {mine.length > 0 && (
        <div className="text-[var(--color-text-muted)]">
          {mine.map((p) => (
            <div key={p.id}>
              Your proposal of {p.createdAt}: {STATUS_TEXT[p.status]}
              {p.reviewerNote ? ` — “${p.reviewerNote}”` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
