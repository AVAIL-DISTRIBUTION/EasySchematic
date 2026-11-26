/**
 * API errors with what the page can act on (step 2.4): a 409 "duplicate" answer carries the
 * existing template ({ duplicateOf: {id, label}, link }), so its name in the message becomes a link
 * to its card in the library workspace (/library?template=<id>). Pure, for the pages and tests.
 */

export interface DuplicateOf {
  id: string;
  label: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly duplicateOf: DuplicateOf | null;
  readonly link: string | null;
  constructor(message: string, status: number, duplicateOf: DuplicateOf | null = null, link: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.duplicateOf = duplicateOf;
    this.link = link;
  }
}

/** The error for a failed response's JSON body. */
export function apiError(status: number, body: unknown): ApiError {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; duplicateOf?: unknown; link?: unknown };
  const message = typeof b.error === "string" && b.error ? b.error : `HTTP ${status}`;
  const d = b.duplicateOf as { id?: unknown; label?: unknown } | undefined;
  const dup = d && typeof d.id === "string" && typeof d.label === "string" ? { id: d.id, label: d.label } : null;
  const link = dup ? (typeof b.link === "string" && b.link.startsWith("/") ? b.link : templateLink(dup.id)) : null;
  return new ApiError(message, status, dup, link);
}

/** The library workspace with that template's card open. */
export const templateLink = (id: string) => `/library?template=${encodeURIComponent(id)}`;

export type MessagePart = { text: string } | { text: string; href: string; templateId: string };

/**
 * The message in parts: the existing template's name (its last mention) as a link to its card;
 * other errors — one plain part. A message without the name gets " Open <name>." with the link.
 */
export function errorParts(e: unknown): MessagePart[] {
  const message = e instanceof Error ? e.message : String(e);
  if (!(e instanceof ApiError) || !e.duplicateOf || !e.link) return [{ text: message }];
  const { label, id } = e.duplicateOf;
  const link = { text: label, href: e.link, templateId: id };
  const at = label ? message.lastIndexOf(label) : -1;
  if (at < 0) return [{ text: `${message} Open ` }, link, { text: "." }];
  return [{ text: message.slice(0, at) }, link, { text: message.slice(at + label.length) }].filter((p) => p.text !== "");
}
