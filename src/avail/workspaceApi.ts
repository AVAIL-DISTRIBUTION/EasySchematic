/**
 * Library workspace API calls (/library page, step 2.2): the workspace data, bulk category, and
 * proposals on upstream's submissions. Status changes use changeTemplatesStatus (api.ts).
 */
import type { DeviceTemplate } from "../types";
import { apiUrl } from "./api";
import { apiError } from "./apiError";
import type { LifecycleInfo } from "./lifecycle";
import type { WsTemplate } from "./workspaceModel";
import type { PatchConflict, Resolution, TemplatePatch } from "./templatePatch";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw apiError(res.status, body);
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

export interface LifecycleBatchResult {
  lifecycle: LifecycleInfo;
  updated: string[];
  unchanged: string[];
  failed: { id: string; reason: string }[];
  /** Verified templates that fell below level A with the new lifecycle and became draft. */
  demoted: string[];
}

/** POST /avail/templates/lifecycle/batch: upcoming (availableFrom), active or eol (eolDate). */
export const setTemplatesLifecycle = (ids: string[], lifecycle: LifecycleInfo) =>
  call<LifecycleBatchResult>("/avail/templates/lifecycle/batch", { method: "POST", body: JSON.stringify({ ids, ...lifecycle }) });

/** POST /avail/templates/merge: the ids become hidden "duplicate of <primary>" (step 2.4). */
export const mergeTemplates = (primary: string, ids: string[]) =>
  call<{ primary: string; updated: string[]; unchanged: string[]; failed: { id: string; reason: string }[] }>("/avail/templates/merge", {
    method: "POST",
    body: JSON.stringify({ primary, ids }),
  });

/** POST /avail/templates/not-duplicates: every pair of the ids is decided "not duplicates" (step 2.4). */
export const markNotDuplicates = (ids: string[], comment: string) =>
  call<{ pairs: [string, string][]; unchanged: [string, string][] }>("/avail/templates/not-duplicates", { method: "POST", body: JSON.stringify({ ids, comment }) });

/** POST /avail/templates/not-duplicates/undo: the decision on the pair is removed. */
export const undoNotDuplicates = (a: string, b: string) =>
  call<{ removed: [string, string] }>("/avail/templates/not-duplicates/undo", { method: "POST", body: JSON.stringify({ a, b }) });

/** An upstream submission: a proposed template edit (action "update") with the engineer's comment. */
export interface Proposal {
  id: string;
  action: "create" | "update";
  templateId: string | null;
  data: DeviceTemplate;
  status: "pending" | "deferred" | "approved" | "rejected" | "withdrawn";
  createdAt: string;
  reviewedAt: string | null;
  reviewerNote: string | null;
  submitterEmail?: string;
  submitterName?: string;
  submitterNote?: string;
}

export const fetchPendingProposals = () => call<Proposal[]>("/submissions/pending");
export const fetchMyProposals = () => call<Proposal[]>("/submissions/mine");

/** Accept; with a proposal stored as a patch, `resolutions` choose the side of each conflict. */
export const acceptProposal = (id: string, resolutions: Record<string, Resolution> = {}) =>
  call<{ ok?: boolean }>(`/submissions/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ resolutions }) });

/** A pending proposal as its edit (api-avail/src/proposals.ts): base, patch, what changes, conflicts with the template now. */
export type ProposalPatchInfo =
  | { id: string; templateId: string | null; legacy: true }
  | {
      id: string;
      templateId: string;
      legacy: false;
      baseVersion: number;
      currentVersion: number;
      base: Record<string, unknown>;
      patch: TemplatePatch;
      changes: string[];
      conflicts: PatchConflict[];
    };

export const fetchProposalPatches = () => call<ProposalPatchInfo[]>("/avail/proposals/pending");

/** The author withdraws a pending proposal. */
export const withdrawProposal = (id: string) => call<{ id: string; status: string }>(`/avail/proposals/${encodeURIComponent(id)}/withdraw`, { method: "POST", body: "{}" });

export const rejectProposal = (id: string, note: string) =>
  call<{ ok?: boolean }>(`/submissions/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify({ note }) });

/** POST /submissions (action update): an engineer proposes an edited copy of a library template. */
export const proposeChange = (templateId: string, data: Omit<DeviceTemplate, "id" | "version">, comment: string) =>
  call<Proposal>("/submissions", { method: "POST", body: JSON.stringify({ action: "update", templateId, data, submitterNote: comment, source: "manual" }) });

/** An override of a template (step 2.7): a decided value imports keep (src/avail/overrides.ts). */
export interface TemplateOverride {
  /** "db:<id>" or "file:<n>" (only in docs/avail/overrides.json). */
  key: string;
  kind: "field" | "port";
  text: string;
  source: string;
  comment: string;
  acceptedBy: string;
  acceptedAt: string | null;
  fromFile: boolean;
}

/** GET /avail/templates/:id/overrides: the overrides in force for the template. */
export const fetchOverrides = async (templateId: string) =>
  (await call<{ overrides: TemplateOverride[] }>(`/avail/templates/${encodeURIComponent(templateId)}/overrides`)).overrides;

/** POST /avail/templates/:id/overrides/remove: the override no longer applies (the value stays). */
export const removeOverride = (templateId: string, key: string) =>
  call<{ removed: string }>(`/avail/templates/${encodeURIComponent(templateId)}/overrides/remove`, { method: "POST", body: JSON.stringify({ key }) });
