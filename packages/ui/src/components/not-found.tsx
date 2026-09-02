/**
 * NotFoundPage — shared 404 surface for every Oxagen Next.js app.
 *
 * Rendered by each app's `app/not-found.tsx`. Intentionally a plain Server
 * Component: NO hooks, NO next-themes, NO client context. Next.js statically
 * exports `/_not-found` at build time, so anything that reads React context
 * here (e.g. a theme provider) crashes the export worker. Keep it inert.
 *
 * Styling uses the @oxagen/ui theme tokens (plain CSS variables — no React
 * context), so it reads correctly in both light and dark.
 *
 * Uses a plain anchor (not `next/link`) to avoid coupling `@oxagen/ui` to a
 * `next` dependency — a 404 → home full navigation is fine.
 */
export function NotFoundPage({ homeHref = "/" }: { homeHref?: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-md rounded-xl border bg-card p-10 text-center text-card-foreground shadow">
        <p className="text-6xl font-semibold tracking-tight text-muted-foreground">
          404
        </p>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you’re looking for doesn’t exist or has moved.
        </p>
        <a
          href={homeHref}
          className="mt-8 inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
        >
          Back to home
        </a>
      </section>
    </main>
  );
}
