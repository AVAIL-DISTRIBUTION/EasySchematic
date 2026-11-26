/**
 * An API error message; for a 409 "duplicate" answer the existing template's name links to its
 * card in the library workspace (apiError.ts). `onOpen` opens the card in place (on /library);
 * without it the link opens a new tab.
 */
import { errorParts } from "./apiError";

export function ErrorText({ error, onOpen }: { error: unknown; onOpen?: (templateId: string) => void }) {
  return (
    <>
      {errorParts(error).map((p, i) =>
        "href" in p ? (
          <a
            key={i}
            href={p.href}
            target={onOpen ? undefined : "_blank"}
            rel="noreferrer"
            className="underline"
            data-testid="avail-duplicate-link"
            onClick={(ev) => {
              if (!onOpen) return;
              ev.preventDefault();
              onOpen(p.templateId);
            }}
          >
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
