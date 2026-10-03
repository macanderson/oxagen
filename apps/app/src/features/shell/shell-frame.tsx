// The static frame of the organization shell: a two-column grid on desktop
// (rail | top bar over the page), a single column with a bottom bar on a phone.
// It streams immediately; the chrome's data swaps in from its <Suspense>.
//
// The frame owns the page's one <main id="main">, the skip link's target
// (ADR-227). It sits above the organization layout's <Suspense>, so it is in
// the document from the first byte and stays there while a loading fallback,
// a streaming page, an error or a not-found fills it. No page or page state
// under the shell renders a `main` of its own (arch/loading-landmarks.test.ts).
import { getTranslations } from "next-intl/server";
import { type ReactNode, Suspense } from "react";
import { ShellRoutePageName } from "./route-page-name";
import { THEME_SCRIPT } from "./theme";

function ChromeSkeleton({ loading }: { loading: string }) {
  return (
    <>
      <div
        aria-hidden="true"
        className="sticky top-0 hidden h-dvh border-r border-sidebar-border bg-sidebar-bg md:col-start-1 md:row-span-2 md:row-start-1 md:block"
      >
        <div className="m-3.5 h-6 w-24 animate-pulse rounded-sm bg-sidebar-accent motion-reduce:animate-none" />
        <div className="mx-3.5 mb-2 h-11 animate-pulse rounded-lg bg-sidebar-accent motion-reduce:animate-none" />
        <div className="mx-3.5 h-11 animate-pulse rounded-lg bg-sidebar-accent motion-reduce:animate-none" />
      </div>
      <div
        role="status"
        data-testid="shell-loading"
        className="sticky top-0 z-30 flex h-13.25 items-center border-b border-app-topbar-border bg-app-topbar-bg px-4 md:col-start-2 md:row-start-1"
      >
        <span className="sr-only">{loading}</span>
        <div
          aria-hidden="true"
          className="h-4 w-48 animate-pulse rounded-sm bg-muted motion-reduce:animate-none"
        />
      </div>
    </>
  );
}

export async function ShellFrame({
  chrome,
  children,
}: {
  chrome: ReactNode;
  children: ReactNode;
}) {
  const t = await getTranslations("shell");
  return (
    <div
      data-testid="shell"
      className="min-h-dvh bg-app-panel-bg text-app-panel-fg md:grid md:grid-cols-shell md:grid-rows-shell"
    >
      {/* Before first paint: apply the stored theme so the page never flashes the wrong one. */}
      <script
        // A static string from a Server Component, parsed by the browser, not rendered by React.
        // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- constant pre-paint theme script, no user input
        dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
      />
      <Suspense fallback={<ChromeSkeleton loading={t("loading")} />}>
        {chrome}
      </Suspense>
      <div
        data-shell-page=""
        className="min-w-0 pb-(--frame-pad-bottom) md:col-start-2 md:row-start-2 md:pb-0"
      >
        <main id="main" className="mx-auto flex w-full flex-col gap-4">
          <ShellRoutePageName>{children}</ShellRoutePageName>
        </main>
      </div>
    </div>
  );
}
