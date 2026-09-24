// The Billing landmark. It lives here, above loading.tsx's Suspense boundary,
// so the skeleton and the page share one <main id="main">: while the page
// streams in, Next keeps the fallback in the DOM beside it, and two landmarks
// with the same id would break the skip link and every `main#main` lookup.
import type { ReactNode } from "react";

export default function BillingLayout({ children }: { children: ReactNode }) {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      {children}
    </main>
  );
}
