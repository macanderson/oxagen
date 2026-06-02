/**
 * MarketingHeroPage — shared landing-page component used by apps/website and
 * apps/docs. Stock shadcn neutral card centred on the page background.
 *
 * Keep this component free of app-specific routing or metadata; consuming apps
 * set their own <Metadata> export and wrap this in their root layout.
 */
export function MarketingHeroPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-xl rounded-xl border bg-card p-10 text-center text-card-foreground shadow">
        <h1 className="text-4xl font-semibold tracking-tight">Oxagen</h1>
        <p className="mt-4 text-base text-muted-foreground">
          Build smarter products — run agents, automate workflows, and connect
          your data in one place.
        </p>
      </section>
    </main>
  );
}
