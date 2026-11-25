import { useState } from "react";
import { forceFullReset } from "../sw-register";
import "./avail.css";
import {
  AVAIL_APP_NAME,
  AVAIL_LOGO,
  AVAIL_LOGO_WHITE,
  AVAIL_MARK,
  FORK_SOURCE_URL,
  LICENSE_NAME,
  LICENSE_URL,
  UPSTREAM_AUTHOR,
  UPSTREAM_NAME,
  UPSTREAM_URL,
  sourceUrlFor,
} from "./brand";

declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

/** The AVAIL logo, blue on the light theme and white on the dark one. */
export function AvailLogo({ className }: { className?: string }) {
  return (
    <>
      <img src={AVAIL_LOGO} alt="AVAIL" className={`avail-logo-light ${className ?? ""}`} />
      <img src={AVAIL_LOGO_WHITE} alt="AVAIL" className={`avail-logo-dark ${className ?? ""}`} />
    </>
  );
}

/** Menu bar brand: the AVAIL mark and the app name. */
export function AvailHeaderBrand() {
  return (
    <div className="flex items-center gap-2 px-3 shrink-0" data-testid="avail-header-brand">
      <img src={AVAIL_MARK} alt="AVAIL" className="w-5 h-5" />
      <span className="text-xs font-semibold text-[var(--color-text-heading)] tracking-tight">
        {AVAIL_APP_NAME}
      </span>
    </div>
  );
}

/**
 * About for the AVAIL build. AGPL-3.0 asks that network users are told the work is
 * based on EasySchematic and are offered the source of the version they use.
 */
export function AvailAboutDialog({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting] = useState(false);
  const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
  const hash = typeof __BUILD_HASH__ !== "undefined" ? __BUILD_HASH__ : "local";
  const shortHash = hash.length > 7 ? hash.slice(0, 7) : hash;

  const copyDebugInfo = async () => {
    const info = [
      `${AVAIL_APP_NAME} v${version} (${shortHash})`,
      `UA: ${navigator.userAgent}`,
      `Viewport: ${window.innerWidth}×${window.innerHeight}`,
      `Date: ${new Date().toISOString().split("T")[0]}`,
    ].join("\n");
    await navigator.clipboard.writeText(info);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleForceUpdate = async () => {
    if (resetting) return;
    const ok = window.confirm(
      "Force update: this unregisters the service worker and clears the app cache, then reloads. Your schematics are not affected. Continue?",
    );
    if (!ok) return;
    setResetting(true);
    await forceFullReset();
  };

  const links = [
    { label: "Source code of this version", href: sourceUrlFor(hash) },
    { label: `${UPSTREAM_NAME} (upstream)`, href: UPSTREAM_URL },
    { label: `License (${LICENSE_NAME})`, href: LICENSE_URL },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        data-testid="avail-about"
        className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-2xl w-[420px] max-w-[calc(100vw-32px)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <span className="text-sm font-semibold text-[var(--color-text-heading)]">About {AVAIL_APP_NAME}</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg leading-none cursor-pointer"
          >
            &times;
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col items-center text-center gap-4">
          <AvailLogo className="h-14 w-auto" />
          <div>
            <div className="text-base font-semibold text-[var(--color-text-heading)]">{AVAIL_APP_NAME}</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
              Version {version} ({shortHash})
            </div>
          </div>
          <p className="text-xs text-[var(--color-text)] leading-relaxed max-w-[320px]">
            AV signal flow schematics for AVAIL DISTRIBUTION engineers.
          </p>

          <div className="w-full h-px bg-[var(--color-border)]" />

          <p className="text-xs text-[var(--color-text)]">
            Based on {UPSTREAM_NAME} by {UPSTREAM_AUTHOR} ({LICENSE_NAME})
          </p>
          <div className="flex flex-col gap-1 text-xs">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
            Fork source: {FORK_SOURCE_URL.replace(/^https:\/\//, "")}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--color-border)]">
          <button
            onClick={handleForceUpdate}
            disabled={resetting}
            title="Unregister the service worker, clear the app cache, and reload. Schematic data is preserved."
            className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer text-[var(--color-text-muted)] disabled:opacity-50 disabled:cursor-wait"
          >
            {resetting ? "Reloading…" : "Force Update"}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={copyDebugInfo}
              className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer text-[var(--color-text)]"
            >
              {copied ? "Copied!" : "Copy Debug Info"}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
