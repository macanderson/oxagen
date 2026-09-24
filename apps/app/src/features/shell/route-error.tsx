"use client";
// The error boundary each route draws when its page throws: the shared error
// state, named for the page, with the code the kernel gives that page's
// unclassified failure (`PAGE_FAILURES`, the same row `toRead` answers with).
// It replaces the page, so it carries the page's landmark and h1, and the
// shell stays around it. Try again is Next's `retry`, which re-fetches the
// segment and then resets the boundary. The error's digest is the trace id.
//
// The boundaries live together in the shell because an `error.tsx` must be a
// client module, and a client module in `src/app` may import only `ui` and
// `shared` (INV-21), neither of which can read `PAGE_FAILURES`. Each route's
// `error.tsx` carries no directive and re-exports its boundary from the shell
// barrel, so the table stays the one source of every code.
import { useTranslations } from "next-intl";
import { PAGE_FAILURES, type PageKey } from "@/data/read";
import { ErrorState } from "@/ui/page-state";

type RouteErrorProps = {
  error: Error & { digest?: string };
  retry: () => void;
};

/** The page each boundary names, as its `pages` title key. */
const PAGE_TITLE = {
  fleet: "fleet",
  run: "run",
  agents: "agents",
  onboarding: "register",
  billing: "billing",
  spend: "spend",
  audit: "audit",
  steering: "steering",
  mandates: "mandate",
  tools: "tools",
  repositories: "repositories",
  runtimes: "runtimes",
} as const satisfies Partial<Record<PageKey, string>>;

type TitledPage = keyof typeof PAGE_TITLE;

function RouteError({
  error,
  retry,
  page,
  what,
}: RouteErrorProps & { page: PageKey; what: string }) {
  const { code, status } = PAGE_FAILURES[page].error;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <ErrorState
        heading="h1"
        what={what}
        code={`${status} ${code}`}
        onRetry={retry}
        trace={error.digest}
      />
    </main>
  );
}

function PageRouteError({
  page,
  ...props
}: RouteErrorProps & { page: TitledPage }) {
  const t = useTranslations("pages");
  return <RouteError {...props} page={page} what={t(PAGE_TITLE[page])} />;
}

/**
 * The organization and workspace levels, for a page with no boundary of its
 * own and for the workspace gate. Either may be any page, so it names none.
 */
export function ShellRouteError(props: RouteErrorProps) {
  const t = useTranslations("ui.pageState.error");
  return <RouteError {...props} page="shell" what={t("thisPage")} />;
}

export const FleetRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="fleet" />
);
export const RunRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="run" />
);
export const AgentsRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="agents" />
);
export const RegisterRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="onboarding" />
);
export const BillingRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="billing" />
);
export const SpendRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="spend" />
);
export const AuditRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="audit" />
);
export const SteeringRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="steering" />
);
export const MandateRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="mandates" />
);
export const ToolsRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="tools" />
);
export const RepositoriesRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="repositories" />
);
export const RuntimesRouteError = (props: RouteErrorProps) => (
  <PageRouteError {...props} page="runtimes" />
);
