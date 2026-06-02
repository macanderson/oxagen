/**
 * NotFoundPage — shared 404 surface for every Oxagen Next.js app.
 *
 * Rendered by each app's `app/not-found.tsx`. Intentionally a plain Server
 * Component: NO hooks, NO next-themes, NO client context. Next.js statically
 * exports `/_not-found` at build time, so anything that reads React context
 * here (e.g. a theme provider) crashes the export worker. Keep it inert.
 *
 * Styling is theme-agnostic (explicit dark palette) so it reads correctly even
 * when the surrounding ThemeProvider has not applied a `class` yet.
 *
 * Uses a plain anchor (not `next/link`) to avoid coupling `@oxagen/ui` to a
 * `next` dependency — a 404 → home full navigation is fine.
 */
export function NotFoundPage({ homeHref = "/" }: { homeHref?: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0f] px-6 text-white">
      <section className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl shadow-[0_30px_120px_-30px_rgba(0,0,0,0.6)]">
        <p className="bg-gradient-to-r from-indigo-400 to-emerald-400 bg-clip-text text-6xl font-semibold tracking-tight text-transparent">
          404
        </p>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-white/60">
          The page you’re looking for doesn’t exist or has moved.
        </p>
        <a
          href={homeHref}
          className="mt-8 inline-flex h-10 items-center justify-center rounded-xl bg-white/10 px-5 text-sm font-medium text-white transition-colors hover:bg-white/20"
        >
          Back to home
        </a>
      </section>
    </main>
  );
}
