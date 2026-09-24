"use client";

// Replaces the root layout when it fails, so neither the intl provider nor
// globals.css reaches it: the copy is read straight from the English catalog,
// and the styles are inline. It draws the shared error state on ink, as the
// mockup does: the failed glyph tile, the heading, one line, Try again and the
// trace line. Try again is Next's `retry`, which re-fetches and then resets.
// Open an incident is left out, because its dialog needs the intl provider.
import { CircleAlert } from "lucide-react";
import type { CSSProperties } from "react";
import messages from "../../messages/en.json";

/** The house tokens on ink, as globals.css resolves them in dark mode. */
const INK = {
  canvas: "#09090B",
  panel: "#18181B",
  text: "#FFFFFF",
  muted: "#A1A1AA",
  dim: "#71717A",
  failedMark: "rgba(192, 69, 60, 0.4)",
  failedText: "oklch(0.7 0.16 25)",
  gold: "#D4AF37",
} as const;

const SANS = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const tile: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 44,
  height: 44,
  margin: "0 auto 14px",
  borderRadius: 12,
  border: `1px solid ${INK.failedMark}`,
  background: INK.panel,
  color: INK.failedText,
};

const retryButton: CSSProperties = {
  minHeight: 32,
  padding: "6px 13px",
  borderRadius: 9,
  border: `1px solid ${INK.gold}`,
  background: INK.gold,
  color: INK.canvas,
  font: `600 13px ${SANS}`,
  cursor: "pointer",
};

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = messages.globalError;
  const trace =
    error.digest === undefined
      ? t.traceUnrecorded
      : t.trace.replace("{trace}", error.digest);
  return (
    <html lang="en" dir="ltr" style={{ colorScheme: "dark" }}>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          background: INK.canvas,
          color: INK.text,
          fontFamily: SANS,
        }}
      >
        <title>{t.title}</title>
        <main
          id="main"
          style={{
            display: "grid",
            placeItems: "center",
            minHeight: "100dvh",
            padding: "60px 20px",
            boxSizing: "border-box",
            textAlign: "center",
          }}
        >
          <section role="alert" aria-labelledby="global-error-title">
            <div aria-hidden="true" style={tile}>
              <CircleAlert size={20} />
            </div>
            <h1
              id="global-error-title"
              style={{ margin: "0 0 7px", fontSize: 18, fontWeight: 600 }}
            >
              {t.title}
            </h1>
            <p
              style={{
                margin: "0 auto 16px",
                maxWidth: "52ch",
                fontSize: 13,
                color: INK.muted,
              }}
            >
              {t.body}
            </p>
            <button type="button" onClick={retry} style={retryButton}>
              {t.retry}
            </button>
            <p
              data-testid="global-error-trace"
              style={{
                margin: "16px 0 0",
                fontFamily: MONO,
                fontSize: 11.5,
                color: INK.dim,
              }}
            >
              <span data-recorded={String(error.digest !== undefined)}>
                {trace}
              </span>
            </p>
          </section>
        </main>
      </body>
    </html>
  );
}
