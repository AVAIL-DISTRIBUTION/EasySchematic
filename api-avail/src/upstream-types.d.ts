// Type-only patch so `tsc` passes over api/src, which api-avail imports.
//
// api/src/index.ts hands a ForwardableEmailMessage to handleEmail(), whose local
// EmailMessage type says forward() returns Promise<void>; current
// @cloudflare/workers-types says Promise<EmailSendResult>. Upstream never type-checks
// api/ in CI, so the mismatch sits there unnoticed. This overload (declaration merging)
// makes the two compatible without touching api/src. The email() entry point isn't
// wired up under Node anyway.
interface ForwardableEmailMessage {
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}
