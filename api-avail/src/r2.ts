/**
 * R2 shim over the local filesystem.
 *
 * Layout under the root directory (DATA_DIR/r2):
 *   objects/<encoded key>       object bytes
 *   meta/<encoded key>.json     { key, version, size, etag, uploaded, httpMetadata, customMetadata }
 *
 * Keys are flattened with encodeURIComponent (plus "." → "%2E"), so "/" in a key never
 * creates directories and a key can't escape the root ("../x" becomes "%2E%2E%2Fx").
 * Writes go to a temp file and are renamed into place, so a reader never sees half an
 * object.
 *
 * Implemented: get, put, delete, list (prefix, limit, cursor, delimiter, include), head.
 * Not implemented (unused by api/src): get/put conditionals (onlyIf), ranged get,
 * multipart uploads, storage classes, checksums other than md5, SSE-C.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

type PutValue = string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null;

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
  md5?: ArrayBuffer | string;
  onlyIf?: unknown;
}

export interface R2ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  delimiter?: string;
  include?: ("httpMetadata" | "customMetadata")[];
}

interface StoredMeta {
  key: string;
  version: string;
  size: number;
  etag: string;
  uploaded: string;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
}

const MAX_KEY_BYTES = 1024;
// Most filesystems cap a name at 255 bytes; ".json" + temp suffix need headroom.
const MAX_ENCODED_NAME = 200;

export function encodeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("R2 shim: key must be a non-empty string");
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new TypeError("R2 shim: key exceeds 1024 bytes");
  const encoded = encodeURIComponent(key).replace(/\./g, "%2E").replace(/\*/g, "%2A");
  if (encoded.length > MAX_ENCODED_NAME) {
    throw new TypeError(`R2 shim: key too long for the file store (${encoded.length} encoded chars, max ${MAX_ENCODED_NAME})`);
  }
  return encoded;
}

function httpMetadataFrom(input: R2HTTPMetadata | Headers | undefined): R2HTTPMetadata {
  if (!input) return {};
  if (input instanceof Headers) {
    const m: R2HTTPMetadata = {};
    const get = (h: string) => input.get(h) ?? undefined;
    if (get("content-type")) m.contentType = get("content-type");
    if (get("content-language")) m.contentLanguage = get("content-language");
    if (get("content-disposition")) m.contentDisposition = get("content-disposition");
    if (get("content-encoding")) m.contentEncoding = get("content-encoding");
    if (get("cache-control")) m.cacheControl = get("cache-control");
    const expires = get("expires");
    if (expires) m.cacheExpiry = new Date(expires);
    return m;
  }
  return { ...input };
}

async function toBuffer(value: PutValue): Promise<Buffer> {
  if (value === null) return Buffer.alloc(0);
  if (typeof value === "string") return Buffer.from(value, "utf-8");
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  if (value instanceof ReadableStream) return Buffer.from(await new Response(value).arrayBuffer());
  throw new TypeError("R2 shim: unsupported value type for put()");
}

export class R2ObjectShim {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly checksums: { md5?: ArrayBuffer; toJSON(): Record<string, string> };
  readonly storageClass = "Standard";

  constructor(meta: StoredMeta, include: { http: boolean; custom: boolean } = { http: true, custom: true }) {
    this.key = meta.key;
    this.version = meta.version;
    this.size = meta.size;
    this.etag = meta.etag;
    this.httpEtag = `"${meta.etag}"`;
    this.uploaded = new Date(meta.uploaded);
    if (include.http) {
      this.httpMetadata = { ...meta.httpMetadata };
      if (meta.httpMetadata.cacheExpiry) this.httpMetadata.cacheExpiry = new Date(meta.httpMetadata.cacheExpiry);
    }
    if (include.custom) this.customMetadata = { ...meta.customMetadata };
    const md5 = Buffer.from(meta.etag, "hex");
    this.checksums = {
      md5: md5.buffer.slice(md5.byteOffset, md5.byteOffset + md5.byteLength),
      toJSON: () => ({ md5: meta.etag }),
    };
  }

  writeHttpMetadata(headers: Headers): void {
    const m = this.httpMetadata ?? {};
    if (m.contentType) headers.set("content-type", m.contentType);
    if (m.contentLanguage) headers.set("content-language", m.contentLanguage);
    if (m.contentDisposition) headers.set("content-disposition", m.contentDisposition);
    if (m.contentEncoding) headers.set("content-encoding", m.contentEncoding);
    if (m.cacheControl) headers.set("cache-control", m.cacheControl);
    if (m.cacheExpiry) headers.set("expires", new Date(m.cacheExpiry).toUTCString());
  }
}

export class R2ObjectBodyShim extends R2ObjectShim {
  private readonly data: Buffer;
  private used = false;

  constructor(meta: StoredMeta, data: Buffer) {
    super(meta);
    this.data = data;
  }

  get body(): ReadableStream<Uint8Array> {
    this.used = true;
    return new Blob([this.data]).stream();
  }

  get bodyUsed(): boolean {
    return this.used;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.used = true;
    return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength) as ArrayBuffer;
  }

  async bytes(): Promise<Uint8Array> {
    this.used = true;
    return new Uint8Array(this.data);
  }

  async text(): Promise<string> {
    this.used = true;
    return this.data.toString("utf-8");
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async blob(): Promise<Blob> {
    this.used = true;
    return new Blob([this.data], this.httpMetadata?.contentType ? { type: this.httpMetadata.contentType } : {});
  }
}

export class R2BucketShim {
  private readonly objectsDir: string;
  private readonly metaDir: string;
  private ready: Promise<void> | null = null;

  constructor(readonly root: string) {
    this.objectsDir = path.join(root, "objects");
    this.metaDir = path.join(root, "meta");
  }

  private ensureDirs(): Promise<void> {
    this.ready ??= Promise.all([
      mkdir(this.objectsDir, { recursive: true }),
      mkdir(this.metaDir, { recursive: true }),
    ]).then(() => undefined);
    return this.ready;
  }

  private paths(key: string) {
    const name = encodeKey(key);
    return { object: path.join(this.objectsDir, name), meta: path.join(this.metaDir, `${name}.json`) };
  }

  private async readMeta(key: string): Promise<StoredMeta | null> {
    try {
      return JSON.parse(await readFile(this.paths(key).meta, "utf-8")) as StoredMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async head(key: string): Promise<R2ObjectShim | null> {
    const meta = await this.readMeta(key);
    return meta ? new R2ObjectShim(meta) : null;
  }

  async get(key: string, _options?: unknown): Promise<R2ObjectBodyShim | null> {
    const meta = await this.readMeta(key);
    if (!meta) return null;
    try {
      return new R2ObjectBodyShim(meta, await readFile(this.paths(key).object));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key: string, value: PutValue, options: R2PutOptions = {}): Promise<R2ObjectShim> {
    await this.ensureDirs();
    const { object, meta: metaPath } = this.paths(key);
    const data = await toBuffer(value);
    const etag = createHash("md5").update(data).digest("hex");
    if (options.md5 !== undefined) {
      const expected = typeof options.md5 === "string" ? options.md5.toLowerCase() : Buffer.from(options.md5).toString("hex");
      if (expected !== etag) throw new Error("R2 shim: put() md5 mismatch");
    }
    const meta: StoredMeta = {
      key,
      version: randomUUID().replace(/-/g, ""),
      size: data.byteLength,
      etag,
      uploaded: new Date().toISOString(),
      httpMetadata: httpMetadataFrom(options.httpMetadata),
      customMetadata: { ...(options.customMetadata ?? {}) },
    };
    const tmp = `.${randomUUID()}.tmp`;
    // Object first, then metadata: metadata is what makes an object visible.
    await writeFile(object + tmp, data);
    await rename(object + tmp, object);
    await writeFile(metaPath + tmp, JSON.stringify(meta));
    await rename(metaPath + tmp, metaPath);
    return new R2ObjectShim(meta);
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      const { object, meta } = this.paths(key);
      // Metadata first, so a crash in between leaves an invisible orphan, not a broken object.
      await rm(meta, { force: true });
      await rm(object, { force: true });
    }
  }

  async list(options: R2ListOptions = {}) {
    await this.ensureDirs();
    const prefix = options.prefix ?? "";
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
    const include = {
      http: options.include?.includes("httpMetadata") ?? false,
      custom: options.include?.includes("customMetadata") ?? false,
    };
    const after = options.cursor ? Buffer.from(options.cursor, "base64url").toString("utf-8") : null;

    const keys = (await readdir(this.metaDir))
      .filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
      .map((f) => decodeURIComponent(f.slice(0, -".json".length)))
      .filter((k) => k.startsWith(prefix))
      .sort();

    const objects: R2ObjectShim[] = [];
    const delimitedPrefixes = new Set<string>();
    let truncated = false;
    let lastKey: string | null = null;

    for (const key of keys) {
      if (after !== null && key <= after) continue;
      let group: string | null = null;
      if (options.delimiter) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(options.delimiter);
        if (idx >= 0) group = prefix + rest.slice(0, idx + options.delimiter.length);
      }
      if (group !== null && delimitedPrefixes.has(group)) {
        lastKey = key;
        continue;
      }
      if (objects.length + delimitedPrefixes.size >= limit) {
        truncated = true;
        break;
      }
      if (group !== null) {
        delimitedPrefixes.add(group);
        lastKey = key;
        continue;
      }
      const meta = await this.readMeta(key);
      if (!meta) continue;
      objects.push(new R2ObjectShim(meta, include));
      lastKey = key;
    }

    return {
      objects,
      delimitedPrefixes: [...delimitedPrefixes],
      truncated,
      ...(truncated && lastKey !== null ? { cursor: Buffer.from(lastKey, "utf-8").toString("base64url") } : {}),
    };
  }
}
