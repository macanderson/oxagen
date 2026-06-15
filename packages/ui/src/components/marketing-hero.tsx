import { Button } from "./button";
import { OxagenLogo } from "./brand";

/**
 * MarketingHeroPage — shared landing-page component used by apps/website and
 * apps/docs. A dark-leaning deep-space hero on the jewel-tone brand: ambient
 * mesh background, vertical Oxagen lockup, gradient-clipped headline, and a
 * primary gradient CTA paired with an outline secondary action.
 *
 * Keep this component free of app-specific routing or metadata; consuming apps
 * set their own <Metadata> export and wrap this in their root layout.
 */
export function MarketingHeroPage() {
  return (
    <main className="app-bg relative flex min-h-screen flex-col items-center justify-center bg-background px-6 py-24 text-center text-foreground">
      <section className="flex w-full max-w-2xl flex-col items-center">
        <OxagenLogo variant="vertical" size={56} />
        <p className="ox-eyebrow mt-8">Secure context for AI agents</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
          <span className="ox-gradient-text">Secure context for AI agents</span>
        </h1>
        <p className="mt-4 max-w-lg text-base text-muted-foreground">
          Typed knowledge graph · RBAC-scoped retrieval.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button variant="gradient" size="lg">
            Get started
          </Button>
          <Button variant="outline" size="lg">
            Read the docs
          </Button>
        </div>
      </section>
    </main>
  );
}
