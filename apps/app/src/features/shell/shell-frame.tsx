// The static frame of the organization shell: a two-column grid on desktop
// (rail | top bar over the page), a single column with a bottom bar on a phone.
// It streams immediately; the chrome's data swaps in from its <Suspense>.
import { getTranslations } from "next-intl/server";
import { type ReactNode, Suspense } from "react";
import { THEME_SCRIPT } from "./theme";

export async function ChromeSkeleton() {
  const t = await getTranslations("shell");
  return (
    <>
      <div
        aria-hidden="true"
        className="sticky top-0 hidden h-dvh border-r border-sidebar-border bg-sidebar-bg md:col-start-1 md:row-span-2 md:row-start-1 md:block"
      >
        <div className="m-3.5 h-6 w-24 animate-pulse rounded bg-sidebar-accent motion-reduce:animate-none" />
        <div className="mx-3.5 mb-2 h-11 animate-pulse rounded-lg bg-sidebar-accent motion-reduce:animate-none" />
        <div className="mx-3.5 h-11 animate-pulse rounded-lg bg-sidebar-accent motion-reduce:animate-none" />
      </div>
      <div
        role="status"
        data-testid="shell-loading"
        className="sticky top-0 z-30 flex h-[53px] items-center border-b border-app-topbar-border bg-app-topbar-bg px-4 md:col-start-2 md:row-start-1"
      >
        <span className="sr-only">{t("loading")}</span>
        <div
          aria-hidden="true"
          className="h-4 w-48 animate-pulse rounded bg-muted motion-reduce:animate-none"
        />
      </div>
    </>
  );
}

export function ShellFrame({
  chrome,
  children,
}: {
  chrome: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="shell"
      className="min-h-dvh bg-app-panel-bg text-app-panel-fg md:grid md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)] md:grid-rows-[auto_1fr]"
    >
      {/* Before first paint: apply the stored theme so the page never flashes the wrong one. */}
      <script
        // A static string from a Server Component, parsed by the browser, not rendered by React.
        // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- constant pre-paint theme script, no user input
        dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
      />
      <Suspense fallback={<ChromeSkeleton />}>{chrome}</Suspense>
      <div className="min-w-0 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:col-start-2 md:row-start-2 md:pb-0">
        {children}
      </div>
    </div>
  );
}
