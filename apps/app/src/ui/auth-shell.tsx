// The frame every sign-in and organization-creation screen sits in (mockup `obShell` @
// mc-baseline-w1): the brand on the top bar, a faint gold wash, and one centred
// column.
import { OxagenWordmark } from "@oxagen/ui";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

async function Brandmark() {
  const t = await getTranslations("ui.brand");
  return (
    <Link
      href="/"
      aria-label={t("home")}
      className="inline-flex items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
    >
      <OxagenWordmark className="h-6" />
    </Link>
  );
}

export function AuthShell({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col items-center bg-background px-4 pb-14 sm:px-5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(760px_420px_at_50%_-6%,color-mix(in_oklch,var(--foreground)_14%,transparent),transparent_70%)]"
      />
      <header className="flex w-full max-w-5xl items-center gap-3 pt-6">
        <Brandmark />
        {aside ? (
          <div className="ml-auto flex min-w-0 items-center gap-3">{aside}</div>
        ) : null}
      </header>
      <main
        id="main"
        className="flex w-full max-w-xl flex-col items-center pt-8 sm:pt-11"
      >
        {children}
      </main>
    </div>
  );
}

/** One sign-in screen's column: the page's PageHeader, then the panel and footer the page passes. */
export function AuthColumn({
  wide = false,
  children,
}: {
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex w-full min-w-0 flex-col gap-5 ${wide ? "max-w-xl" : "max-w-md"}`}
    >
      {children}
    </div>
  );
}

export function AuthFooter({ children }: { children: ReactNode }) {
  return (
    <p className="text-center text-sm text-muted-foreground">{children}</p>
  );
}

/** The Suspense fallback while a sign-in screen reads its search params. */
export function AuthSkeleton() {
  return (
    <div
      data-testid="page-state-loading"
      aria-busy="true"
      className="flex w-full max-w-md flex-col gap-4"
    >
      <div className="h-3 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-8 w-3/4 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      <div className="h-72 w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
    </div>
  );
}
