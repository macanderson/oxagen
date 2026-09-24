// The frame every sign-in and organization-creation screen sits in (mockup
// `obShell`): the brand on the top bar, a faint 48px grid that fades out down
// the page, and one centred column.
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
  pending = false,
}: {
  children: ReactNode;
  aside?: ReactNode;
  /**
   * The column is a loading fallback: a busy region, not `main#main`. While
   * the page streams in, the fallback and the page are in the document
   * together, and only the page may own the skip link's target.
   */
  pending?: boolean;
}) {
  const column = "flex w-full max-w-xl flex-col items-center pt-8 sm:pt-11";
  return (
    <div className="relative isolate flex min-h-dvh flex-col items-center bg-background px-4 pb-14 sm:px-5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-50 [background:repeating-linear-gradient(0deg,transparent_0_47px,var(--border)_47px_48px),repeating-linear-gradient(90deg,transparent_0_47px,var(--border)_47px_48px)] [mask-image:linear-gradient(180deg,#000_0%,transparent_78%)]"
      />
      <header className="flex w-full max-w-5xl items-center gap-3 pt-6">
        <Brandmark />
        {aside ? (
          <div className="ml-auto flex min-w-0 items-center gap-3">{aside}</div>
        ) : null}
      </header>
      {pending ? (
        <div aria-busy="true" className={column}>
          {children}
        </div>
      ) : (
        <main id="main" className={column}>
          {children}
        </main>
      )}
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
