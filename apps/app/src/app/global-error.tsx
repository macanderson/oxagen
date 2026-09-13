"use client";

// Replaces the root layout when it fails, so no intl provider is available here:
// the copy is read straight from the English catalog.
import messages from "../../messages/en.json";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = messages.globalError;
  return (
    <html lang="en" dir="ltr">
      <body>
        <main id="main">
          <h1>{t.title}</h1>
          <p>{t.body}</p>
          <button type="button" onClick={reset}>
            {t.retry}
          </button>
        </main>
      </body>
    </html>
  );
}
