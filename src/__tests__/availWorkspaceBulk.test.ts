/**
 * Bulk actions in batches (src/avail/workspaceBulk.ts): a selection over the API's 500-id limit
 * is sent in batches with progress, and the results add up to one report.
 */
import { describe, expect, it } from "vitest";
import { BULK_BATCH, bulkReport, chunks, runBulk, type BatchAnswer } from "../avail/workspaceBulk";
import { buildRows, planBulk, type WsTemplate } from "../avail/workspaceModel";

function templates(n: number, level: "A" | "B" = "A"): WsTemplate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    label: `Extron T${i}`,
    manufacturer: "Extron",
    modelNumber: `60-${i}`,
    deviceType: "switcher",
    category: "AV distribution / Switchers",
    ports: [],
    avail: {
      status: "draft", level, statusReason: null, statusChangedAt: null, updatedAt: null, approvedBy: null, approvedVia: null,
      approvedAt: null, portsOrigin: "none", portsSource: null, portsFrom: null, datasheetUrl: null, source: null, editors: [], lastActor: null, lastAt: null,
    },
  })) as unknown as WsTemplate[];
}

/** A fake API: refuses ids ending in 7, records the batches. */
function fakeApi(failBatch?: number) {
  const calls: string[][] = [];
  const send = async (ids: string[]): Promise<BatchAnswer> => {
    calls.push(ids);
    if (ids.length > BULK_BATCH) throw new Error(`ids must be 1 to ${BULK_BATCH} template ids`);
    if (failBatch === calls.length) throw new Error("HTTP 502");
    return {
      updated: ids.filter((id) => !id.endsWith("7")),
      failed: ids.filter((id) => id.endsWith("7")).map((id) => ({ id, label: null, reason: "not_level_a", level: "B" })),
    };
  };
  return { calls, send };
}

describe("bulk actions over 500 templates", () => {
  it("chunks by 500", () => {
    expect(chunks(Array.from({ length: 1240 }, (_, i) => i)).map((c) => c.length)).toEqual([500, 500, 240]);
    expect(chunks([])).toEqual([]);
  });

  it("approve on 1240: three batches, progress 1..3 of 3, one report over all of them", async () => {
    const plan = planBulk("approve", buildRows(templates(1240)));
    const { calls, send } = fakeApi();
    const progress: string[] = [];
    const o = await runBulk(plan, send, (n, m) => progress.push(`${n}/${m}`));
    expect(calls.map((c) => c.length)).toEqual([500, 500, 240]);
    expect(progress).toEqual(["1/3", "2/3", "3/3"]);
    expect(new Set(calls.flat()).size).toBe(1240);
    expect(o.updated.length + o.refused.length).toBe(1240);
    expect(o.refused).toHaveLength(124);
    const report = bulkReport(plan, o);
    expect(report[0]).toBe("Approve: 1116 changed, 124 refused — 3 batches of up to 500.");
    expect(report).toContain("…and 74 more refused.");
    expect(report[report.length - 1]).toBe("Every change is in the audit log.");
  });

  it("a failed batch does not stop the others and is reported with its size", async () => {
    const plan = planBulk("hide", buildRows(templates(740)));
    const { calls, send } = fakeApi(1);
    const o = await runBulk(plan, send);
    expect(calls.map((c) => c.length)).toEqual([500, 240]);
    expect(o.failedBatches).toEqual([{ batch: 1, ids: calls[0], error: "HTTP 502" }]);
    const report = bulkReport(plan, o);
    expect(report[0]).toBe("Hide: 216 changed, 24 refused, 500 not changed (failed batches) — 2 batches of up to 500.");
    expect(report[1]).toBe("Batch 1 of 2 failed (500 templates, unchanged): HTTP 502. Run the action again for them.");
  });

  it("category and draft / unhide go through the same batches", async () => {
    for (const plan of [
      planBulk("category", buildRows(templates(740)), "AV distribution / Interfaces"),
      planBulk("draft", buildRows(templates(740).map((t) => ({ ...t, avail: { ...t.avail, status: "verified" } })))),
      planBulk("unhide", buildRows(templates(740).map((t) => ({ ...t, avail: { ...t.avail, status: "hidden" } })))),
    ]) {
      const { calls, send } = fakeApi();
      await runBulk(plan, send);
      expect(calls.map((c) => c.length)).toEqual([500, 240]);
    }
    const cat = planBulk("category", buildRows(templates(3)), "AV distribution / Interfaces");
    const o = await runBulk(cat, async (ids) => ({ updated: ids.slice(1), unchanged: ids.slice(0, 1), failed: [] }));
    expect(bulkReport(cat, o)[0]).toBe("Category set to AV distribution / Interfaces: 2 changed, 1 already there, 0 refused — 1 batch of up to 500.");
  });
});
