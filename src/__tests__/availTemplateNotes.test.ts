/**
 * Moderator notes in the Review card (step 1.8b): vendor answers are stored as upstream
 * template notes; fetchTemplateNotes reads GET /templates/:id/notes with the session cookie.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTemplateNotes } from "../avail/api";

afterEach(() => vi.unstubAllGlobals());

describe("fetchTemplateNotes", () => {
  it("reads the notes with credentials", async () => {
    const notes = [{ id: "n", body: "vendor: System full load", authorName: "Vendor responses", createdAt: "2026-11-24 10:00:00" }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(notes), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchTemplateNotes("a b")).toEqual(notes);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/templates\/a%20b\/notes$/);
    expect(init.credentials).toBe("include");
  });

  it("no notes when not a moderator or offline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    expect(await fetchTemplateNotes("x")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchTemplateNotes("x")).toEqual([]);
  });
});
