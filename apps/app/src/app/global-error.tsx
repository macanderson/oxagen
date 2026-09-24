"use client";

// Replaces the root layout when it fails, so nothing the layout provides is
// here: no intl provider (the copy is read straight from the English catalog)
// and no stylesheet (it imports globals.css itself, for the house tokens and
// fonts). Dark mode follows the operating system through the tokens' own
// prefers-color-scheme block, because the theme script lives in the shell.
// The body is the design's error state, drawn by the shared `StateWrap`,
// which needs no provider.
import messages from "../../messages/en.json";
import { buttonPrimary } from "@/ui/control-styles";
import { StateWrap } from "@/ui/state-wrap";
import "./globals.css";

export default function GlobalError({
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /**
   * Re-fetches the failed tree and renders it again, where `reset` only
   * renders it again (Next 16.3 docs, error.js). Try again prefers it, since
   * a root layout that failed on a read needs the read made again.
   */
  retry?: () => void;
}) {
  const t = messages.globalError;
  return (
    <html lang="en" dir="ltr">
      <body className="min-h-dvh bg-app-canvas font-sans text-foreground antialiased">
        <main id="main" className="grid min-h-dvh place-items-center px-4">
          <StateWrap
            heading="h1"
            testId="global-error"
            tone="failed"
            title={t.title}
            actions={
              <button
                type="button"
                className={buttonPrimary}
                onClick={() => {
                  (retry ?? reset)();
                }}
              >
                {t.retry}
              </button>
            }
          >
            {t.body}
          </StateWrap>
        </main>
      </body>
    </html>
  );
}
