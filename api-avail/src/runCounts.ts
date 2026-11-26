/**
 * Totals of each CLI for its summary entry in the audit log (audit.ts writeRunAudit): created,
 * updated, hidden, approved, deleted where the command does that, plus a few of its own.
 */
import type { RunCounts } from "./audit";
import type { ApproveCatalogReport } from "./approveCatalog";
import type { ApplyWorklistReport } from "./applyWorklist";
import type { GenericPlanReport } from "./genericPlan";
import type { ImportAvailReport } from "./importAvail";
import type { ImportCatalogReport } from "./importCatalog";
import type { ImportReport } from "./importUpstream";
import type { NormalizeLibraryReport } from "./normalizeLibrary";
import type { VendorCleanupReport } from "./vendorCleanup";
import type { VendorResponsesReport } from "./vendorResponses";

export const upstreamRunCounts = (r: ImportReport): RunCounts => ({
  created: r.inserted, updated: r.updated, unchanged: r.unchanged, received: r.received, invalid: r.invalid,
});

export const availRunCounts = (r: ImportAvailReport): RunCounts => ({
  created: r.inserted, updated: r.updated, unchanged: r.unchanged,
  hidden: r.hidden.filter((h) => h.action === "hidden").length, invalid: r.invalid,
});

export const normalizeRunCounts = (r: NormalizeLibraryReport): RunCounts => ({
  updated: r.improved, processed: r.processed, notWritten: r.sameLevelNotWritten,
});

export const vendorCleanupRunCounts = (r: VendorCleanupReport): RunCounts => ({
  created: r.genericCreated.length,
  updated: r.renamed.reduce((n, x) => n + x.count, 0),
  deleted: r.deletedTotal,
  before: r.before,
  after: r.after,
});

export const genericPlanRunCounts = (r: GenericPlanReport): RunCounts => ({
  updated: r.renamed.length, deleted: r.deleted.length, unchanged: r.unchanged,
});

export const worklistRunCounts = (r: ApplyWorklistReport): RunCounts => ({
  updated: r.templatesChanged + r.followups.templatesChanged, actions: r.actionsApplied, manual: r.manual.length,
});

export const vendorResponsesRunCounts = (r: VendorResponsesReport): RunCounts => ({
  updated: r.updated.length, deleted: r.deleted.length, unchanged: r.unchanged,
});

export const catalogRunCounts = (r: ImportCatalogReport): RunCounts => ({
  created: r.counts.inserted,
  updated: r.counts.updated,
  hidden: r.superseded.filter((s) => s.action === "hidden").length,
  deleted: r.removed.length,
  unchanged: r.counts.unchanged,
  belowMin: r.counts["below-min"],
});

export const approveRunCounts = (r: ApproveCatalogReport): RunCounts => ({
  approved: r.rows.filter((x) => x.result === "approved").length,
  leftForReview: r.rows.filter((x) => x.result !== "approved").length,
});
