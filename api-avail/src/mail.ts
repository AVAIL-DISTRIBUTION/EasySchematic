/**
 * Outbound mail is disabled on our server.
 *
 * api/src sends mail by calling https://api.resend.com/emails with fetch() directly
 * (magic-link login and support replies). We don't use either — sign-in is Google
 * only — and api/src stays unmodified, so the stub sits at the fetch layer: requests
 * to api.resend.com never leave the process, get logged (recipient and subject only,
 * never the body, which for magic links holds a login token) and answered with a fake
 * 200 so the calling route completes. Every other request goes to the real fetch.
 */
export const RESEND_HOST = "api.resend.com";

type Fetch = typeof globalThis.fetch;

export function createMailStubFetch(realFetch: Fetch, log: (msg: string) => void): Fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== RESEND_HOST) return realFetch(input, init);

    let to = "?";
    let subject = "?";
    try {
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
      const body = JSON.parse(raw) as { to?: string | string[]; subject?: string };
      to = Array.isArray(body.to) ? body.to.join(", ") : (body.to ?? "?");
      subject = body.subject ?? "?";
    } catch {
      // Unparseable body: still swallow the request, just log less.
    }
    log(`[mail disabled] not sent: to=${to} subject=${JSON.stringify(subject)}`);
    return new Response(JSON.stringify({ id: `disabled-${crypto.randomUUID()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

let installed = false;

/** Replace globalThis.fetch with the stub. Idempotent. */
export function installMailStub(log: (msg: string) => void = console.log): void {
  if (installed) return;
  globalThis.fetch = createMailStubFetch(globalThis.fetch.bind(globalThis), log);
  installed = true;
}
