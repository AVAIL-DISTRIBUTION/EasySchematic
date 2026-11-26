/**
 * Library workspace API calls (/library page, step 2.2): the workspace data, bulk category, and
 * proposals on upstream's submissions. Status changes use changeTemplatesStatus (api.ts).
 */
import type { DeviceTemplate } from "../types";
import { apiUrl } from "./api";
import type { WsTemplate } from "./workspaceModel";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** GET /avail/workspace/templates: every template with its workspace data. */
export async function fetchWorkspace(): Promise<WsTemplate[]> {
  return (await call<{ templates: WsTemplate[] }>("/avail/workspace/templates")).templates;
}

export interface CategoryBatchResult {
  category: string;
  updated: string[];
  unchanged: string[];
  failed: { id: string; reason: string }[];
}

export const changeTemplatesCategory = (ids: string[], category: string) =>
  call<CategoryBatchResult>("/avail/templates/category/batch", { method: "POST", body: JSON.stringify({ ids, category }) });

/** An upstream submission: a proposed template edit (action "update") with the engineer's comment. */
export interface Proposal {
  id: string;
  action: "create" | "update";
  templateId: string | null;
  data: DeviceTemplate;
  status: "pending" | "deferred" | "approved" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
  reviewerNote: string | null;
  submitterEmail?: string;
  submitterName?: string;
  submitterNote?: string;
}

export const fetchPendingProposals = () => call<Proposal[]>("/submissions/pending");
export const fetchMyProposals = () => call<Proposal[]>("/submissions/mine");

export const acceptProposal = (id: string) => call<{ ok?: boolean }>(`/submissions/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" });

export const rejectProposal = (id: string, note: string) =>
  call<{ ok?: boolean }>(`/submissions/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify({ note }) });

/** POST /submissions (action update): an engineer proposes an edited copy of a library template. */
export const proposeChange = (templateId: string, data: Omit<DeviceTemplate, "id" | "version">, comment: string) =>
  call<Proposal>("/submissions", { method: "POST", body: JSON.stringify({ action: "update", templateId, data, submitterNote: comment, source: "manual" }) });
