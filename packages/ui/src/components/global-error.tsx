"use client";
/**
 * GlobalErrorPage — shared top-level error boundary for every Oxagen Next.js
 * app, rendered by each app's `app/global-error.tsx`.
 *
 * Next.js renders `global-error` ENTIRELY OUTSIDE the root layout, so it must
 * supply its own `<html>`/`<body>`. Critically, that also means it runs with no
 * ThemeProvider / next-themes context — which is exactly why it is safe: it
 * cannot trip the `useContext` null crash that breaks `/_global-error` static
 * export when the default (provider-wrapped) error tree is used instead.
 *
 * Styling is fully self-contained (hardcoded light-mode hexes, no theme `class`
 * dependency) so the fallback renders correctly with zero app context. Flat: no
 * radius, no shadow — matching the product skin. Because no tokens are loaded
 * here these hexes cannot follow a reskin: when the palette changes, update
 * them by hand against the light-mode values in
 * packages/ui/src/styles/globals.css.
 */
export function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          background: "#F7F4ED",
          color: "#0A0A0C",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <section
          style={{
            width: "100%",
            maxWidth: "28rem",
            borderRadius: "0",
            border: "1px solid #E6E6E6",
            background: "#FFFFFF",
            padding: "2.5rem",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
            Something went wrong
          </h1>
          <p
            style={{
              marginTop: "0.5rem",
              fontSize: "0.875rem",
              color: "#3E3A34",
            }}
          >
            An unexpected error occurred. You can try again, and if it keeps
            happening we’re already on it.
          </p>
          {error?.digest ? (
            <p
              style={{
                marginTop: "0.75rem",
                fontSize: "0.75rem",
                color: "#5F5A52",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
              }}
            >
              {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: "2rem",
              height: "2.25rem",
              padding: "0 1.25rem",
              borderRadius: "0",
              border: "none",
              background: "#EFC53F",
              color: "#0A0A0C",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </section>
      </body>
    </html>
  );
}
