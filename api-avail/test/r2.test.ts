import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { R2BucketShim, encodeKey } from "../src/r2";

let dir: string;
let bucket: R2BucketShim;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "r2-shim-"));
  bucket = new R2BucketShim(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("R2 shim", () => {
  it("put/get round-trips bytes and metadata", async () => {
    const put = await bucket.put("schematics/a.json", '{"x":1}', {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { owner: "u1" },
    });
    expect(put.key).toBe("schematics/a.json");
    expect(put.size).toBe(7);
    expect(put.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(put.httpEtag).toBe(`"${put.etag}"`);

    const obj = await bucket.get("schematics/a.json");
    expect(obj).not.toBeNull();
    expect(await obj!.json()).toEqual({ x: 1 });
    expect(obj!.httpMetadata?.contentType).toBe("application/json; charset=utf-8");
    expect(obj!.customMetadata).toEqual({ owner: "u1" });
    expect(obj!.etag).toBe(put.etag);
    expect(obj!.uploaded).toBeInstanceOf(Date);
  });

  it("body is a ReadableStream usable as a Response body", async () => {
    await bucket.put("k", new TextEncoder().encode("hello"));
    const obj = await bucket.get("k");
    expect(await new Response(obj!.body).text()).toBe("hello");
    expect(obj!.bodyUsed).toBe(true);
  });

  it("accepts ArrayBuffer, Blob, ReadableStream and Headers metadata", async () => {
    const ab = new ArrayBuffer(1);
    new Uint8Array(ab)[0] = 0x31; // "1"
    await bucket.put("ab", ab);
    await bucket.put("blob", new Blob(["2"]));
    await bucket.put("stream", new Blob(["3"]).stream());
    await bucket.put("hdr", "4", { httpMetadata: new Headers({ "content-type": "text/plain" }) });
    expect(await (await bucket.get("ab"))!.text()).toBe("1");
    expect(await (await bucket.get("blob"))!.text()).toBe("2");
    expect(await (await bucket.get("stream"))!.text()).toBe("3");
    const h = new Headers();
    (await bucket.head("hdr"))!.writeHttpMetadata(h);
    expect(h.get("content-type")).toBe("text/plain");
  });

  it("put overwrites, with a new version and etag", async () => {
    const a = await bucket.put("k", "one");
    const b = await bucket.put("k", "two");
    expect(b.version).not.toBe(a.version);
    expect(b.etag).not.toBe(a.etag);
    expect(await (await bucket.get("k"))!.text()).toBe("two");
  });

  it("get/head return null for a missing key", async () => {
    expect(await bucket.get("nope")).toBeNull();
    expect(await bucket.head("nope")).toBeNull();
  });

  it("head returns metadata without a body", async () => {
    await bucket.put("k", "abc", { customMetadata: { a: "b" } });
    const h = await bucket.head("k");
    expect(h!.size).toBe(3);
    expect(h!.customMetadata).toEqual({ a: "b" });
    expect("body" in h!).toBe(false);
  });

  it("delete removes one or many keys and ignores missing ones", async () => {
    await bucket.put("a", "1");
    await bucket.put("b", "2");
    await bucket.put("c", "3");
    await bucket.delete("a");
    await bucket.delete(["b", "missing"]);
    expect(await bucket.get("a")).toBeNull();
    expect(await bucket.get("b")).toBeNull();
    expect(await bucket.get("c")).not.toBeNull();
  });

  it("list filters by prefix, pages with limit/cursor, and groups by delimiter", async () => {
    for (const k of ["schematics/1.json", "schematics/2.json", "schematics/3.json", "other/x", "top"]) {
      await bucket.put(k, k, { customMetadata: { k } });
    }
    const all = await bucket.list({ prefix: "schematics/" });
    expect(all.objects.map((o) => o.key)).toEqual(["schematics/1.json", "schematics/2.json", "schematics/3.json"]);
    expect(all.truncated).toBe(false);
    expect(all.objects[0].customMetadata).toBeUndefined(); // only with include

    const p1 = await bucket.list({ prefix: "schematics/", limit: 2, include: ["customMetadata"] });
    expect(p1.objects.map((o) => o.key)).toEqual(["schematics/1.json", "schematics/2.json"]);
    expect(p1.truncated).toBe(true);
    expect(p1.objects[0].customMetadata).toEqual({ k: "schematics/1.json" });
    const p2 = await bucket.list({ prefix: "schematics/", limit: 2, cursor: p1.cursor });
    expect(p2.objects.map((o) => o.key)).toEqual(["schematics/3.json"]);
    expect(p2.truncated).toBe(false);

    const grouped = await bucket.list({ delimiter: "/" });
    expect(grouped.objects.map((o) => o.key)).toEqual(["top"]);
    expect(grouped.delimitedPrefixes.sort()).toEqual(["other/", "schematics/"]);
  });

  it("keys can't escape the root directory", async () => {
    await bucket.put("../../etc/evil", "x");
    await bucket.put("..", "y");
    expect(readdirSync(dir).sort()).toEqual(["meta", "objects"]);
    expect(encodeKey("../a")).not.toContain("/");
    expect(encodeKey("..")).toBe("%2E%2E");
    expect(await (await bucket.get("../../etc/evil"))!.text()).toBe("x");
    expect((await bucket.list()).objects.map((o) => o.key).sort()).toEqual(["..", "../../etc/evil"]);
  });

  it("rejects empty keys", async () => {
    await expect(bucket.put("", "x")).rejects.toThrow(/non-empty/);
  });

  it("persists across instances on the same directory", async () => {
    await bucket.put("k", "persisted");
    const again = new R2BucketShim(dir);
    expect(await (await again.get("k"))!.text()).toBe("persisted");
  });
});
