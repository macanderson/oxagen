"use client";
// The not-loaded states every page shares (mockups/pages/audit-prompt.md
// check 22; engine.js `skeleton()`, `errorState()`, `deniedState()` and
// `emptyState()` for an address nothing answers). Each replaces the page BODY
// and never the shell: the sidebar, the breadcrumbs and the search stay, so a
// person who cannot see a page keeps their bearings. A page lane passes its own
// copy in (its title, its error code, the permission it needed). The sentences
// every page shares live here once, and the frame is `StateWrap`
// (./state-wrap.tsx), which the lanes' own states draw too.
//
// Two controls the design draws have no write behind them yet, and neither is
// stubbed into silence. *Request access* would ask an owner for a role and
// *Open an incident* would file one; no contract does either (#3846, #3847).
// Each renders as a disabled button that says why, so the reader learns the
// route that does exist rather than pressing a control that does nothing.
import { useParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  startTransition,
  use,
  useEffect,
  useId,
  useState,
} from "react";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  kvTerm,
  kvValue,
  mono,
  panel,
  panelBody,
  panelHeader,
  statStrip,
} from "./control-styles";
import { SafeLink, useNavigate } from "./navigation";
import { StateWrap, stateCode, stateFacts, stateTrace } from "./state-wrap";

/** The issue that owns each missing write, carried as a data attribute only. */
const REQUEST_ACCESS_GAP = "#3846";
const OPEN_INCIDENT_GAP = "#3847";

/**
 * `skeleton()`: four tile blocks and a panel of seven rows, each bone the
 * `.sk` shimmer (globals.css `skeleton`). The shape of a page's answer, so
 * nothing moves when the reads land and no zero ever flashes where a figure
 * is coming. The frame carries the padding globals.css gives `main#main`
 * under the shell, because the skeleton stands where that `main` will be
 * rather than inside it.
 */
export function PageSkeleton({ label }: { label?: string }) {
  const t = useTranslations("ui.pageState");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="page-skeleton"
      className="flex w-full max-w-[1500px] flex-col gap-4 px-6 pt-[22px] pb-20 max-md:px-4 max-md:pt-4 max-md:pb-[88px]"
    >
      <span className="sr-only">{label ?? t("loading")}</span>
      <div
        aria-hidden="true"
        data-testid="page-skeleton-tiles"
        className={statStrip}
      >
        {[0, 1, 2, 3].map((tile) => (
          <span
            key={tile}
            data-skeleton-tile=""
            className="skeleton h-16 rounded-[11px]"
          />
        ))}
      </div>
      <div aria-hidden="true" className={panel}>
        <div className={panelHeader}>
          <span className="skeleton h-[22px] w-[180px] max-w-full rounded-[7px]" />
        </div>
        <div className={`${panelBody} flex flex-col gap-2`}>
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <span
              key={row}
              data-skeleton-row=""
              className="skeleton h-[38px] rounded-[9px]"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * `errorState(what, code)`: the page could not be read. The title is the
 * page's own ("Fleet could not be loaded"); the code is the one the read path
 * answered, as `503 run_index_unavailable`.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function PageError({
  title,
  status,
  code: errorCode,
  trace,
  onRetry,
}: {
  title: string;
  status: number;
  code: string;
  /**
   * The trace line. `at` is the instant the read failed, formatted by the
   * caller (a component may not read a clock during render). A read error
   * records no trace id or region yet (#3847), so each is drawn only when the
   * caller has one.
   */
  trace: { at: string; id?: string | null; region?: string | null };
  /** What Try again does; a refresh of the route when absent. */
  onRetry?: () => void;
}) {
  const t = useTranslations("ui.pageState.error");
  const navigate = useNavigate();
  const noteId = useId();
  const line = [
    trace.id ? t("trace", { id: trace.id }) : null,
    trace.region ?? null,
    trace.at,
  ].filter((part): part is string => part !== null && part !== "");
  return (
    <StateWrap
      testId="page-error"
      tone="failed"
      title={title}
      actions={
        <>
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => {
              if (onRetry) onRetry();
              else navigate.refresh();
            }}
          >
            {t("retry")}
          </button>
          <button
            type="button"
            aria-disabled="true"
            aria-describedby={noteId}
            data-gap={OPEN_INCIDENT_GAP}
            className={buttonSecondary}
          >
            {t("incident")}
          </button>
        </>
      }
      after={
        <>
          <p data-testid="page-error-trace" className={stateTrace}>
            {line.join(" · ")}
          </p>
          <p
            id={noteId}
            data-testid="page-error-incident-not-backed"
            className="mt-2 text-xs text-muted-foreground"
          >
            {t("incidentNotBacked")}
          </p>
        </>
      }
    >
      {t.rich("body", {
        answer: `${String(status)} ${errorCode}`,
        code: (chunks) => <code className={stateCode}>{chunks}</code>,
      })}
    </StateWrap>
  );
}

/**
 * Names the page a path is on, as the sidebar prints it ("Fleet"). The shell
 * provides it around every page it frames, above the route error boundaries,
 * so `RouteError` can title the failure "Fleet could not be loaded" the way
 * the mock's `errorState("Fleet", …)` does. It carries the resolver, not the
 * name: the path is runtime data, and reading it above every page would block
 * prerendering a static route, so only the boundary reads it, after a page has
 * thrown. Outside the shell, or on a path no nav item holds, the title stays
 * generic.
 */
export const RoutePageNameContext = createContext<
  ((pathname: string) => string | null) | null
>(null);

/** `YYYY-MM-DD hh:mm:ssZ`, the instant a boundary caught the failure, as the mock's trace line prints it. */
function utcInstant(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

/**
 * The route error boundary (`error.tsx` under `[org]` and `[org]/[ws]`): a
 * page that threw while rendering draws PageError in place of its body, and
 * the shell stays. The server logs the failure under `digest`, so the trace
 * line cites it; the code is `internal_error` because the render failed
 * inside Oxagen rather than on a read that answered its own code. The
 * instant is read after mount, because a component may not read a clock
 * during render.
 */
export function RouteError({
  error,
  reset,
  page,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /**
   * The page's name as the sidebar prints it ("Fleet"), so the title reads
   * "Fleet could not be loaded" as the mock's does. Read from
   * `RoutePageNameContext` when absent; null keeps the generic title.
   */
  page?: string | null;
}) {
  const t = useTranslations("ui.pageState.error");
  const nameOf = use(RoutePageNameContext);
  const pathname = usePathname();
  const name = page === undefined ? (nameOf?.(pathname) ?? null) : page;
  const navigate = useNavigate();
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    // The instant lands on the next task rather than in the effect body,
    // where a setState cascades a second render of the boundary.
    const read = setTimeout(() => {
      setAt(utcInstant(new Date()));
    }, 0);
    return () => {
      clearTimeout(read);
    };
  }, []);
  return (
    // `id="main"` is the skip link's target, as every page's own <main> is.
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col">
      <PageError
        title={name === null ? t("title") : t("titleNamed", { page: name })}
        status={500}
        code="internal_error"
        trace={{ at: at ?? "", id: error.digest ?? null }}
        onRetry={() => {
          // A server render failed, so the retry re-requests the route and
          // then clears the boundary once the new payload is in.
          startTransition(() => {
            navigate.refresh();
            reset();
          });
        }}
      />
    </main>
  );
}

/**
 * `deniedState(what, need)`: the viewer's roles do not include what the page
 * reads. The title is the page's own ("You cannot see this workspace"); the
 * permission is the one the refusal named, with its scope
 * (`workspace.read on core-platform`).
 */
export function PageDenied({
  title,
  orgName,
  permission,
  signedIn,
  decidedBy,
  back,
}: {
  title: string;
  orgName: string;
  permission: string;
  /** Who is asking, as the viewer resolved them: name, role, and the scope they hold it in. */
  signedIn: { name: string; role: string; scope: string | null };
  /**
   * The policy that decided the refusal. A refusal records no policy id yet
   * (#3846), so null draws what the record does not say instead of a
   * policy version nobody read.
   */
  decidedBy: string | null;
  /** Where Back to Fleet goes: the workspace the viewer was in. */
  back: SafePath;
}) {
  const t = useTranslations("ui.pageState.denied");
  const noteId = useId();
  return (
    <StateWrap
      testId="page-denied"
      tone="denied"
      title={title}
      actions={
        <>
          <button
            type="button"
            aria-disabled="true"
            aria-describedby={noteId}
            data-gap={REQUEST_ACCESS_GAP}
            className={buttonPrimary}
          >
            {t("request")}
          </button>
          <SafeLink to={back} className={buttonSecondary}>
            {t("back")}
          </SafeLink>
        </>
      }
      after={
        <>
          <p
            id={noteId}
            data-testid="page-denied-request-not-backed"
            className="mt-2 text-xs text-muted-foreground"
          >
            {t("requestNotBacked")}
          </p>
          <dl className={stateFacts}>
            <dt className={kvTerm}>{t("signedIn")}</dt>
            <dd className={kvValue}>
              {signedIn.name} · <span className={mono}>{signedIn.role}</span>
              {signedIn.scope === null ? null : (
                <>
                  {" · "}
                  <span className={mono}>{signedIn.scope}</span>
                </>
              )}
            </dd>
            <dt className={kvTerm}>{t("needed")}</dt>
            <dd className={kvValue}>
              <span className={mono}>{permission}</span>
            </dd>
            <dt className={kvTerm}>{t("decidedBy")}</dt>
            <dd data-testid="page-denied-decided-by" className={kvValue}>
              {decidedBy === null
                ? t("policyNotRecorded")
                : t.rich("decidedByValue", {
                    policy: decidedBy,
                    code: (chunks) => <span className={mono}>{chunks}</span>,
                  })}
            </dd>
          </dl>
        </>
      }
    >
      {t.rich("body", {
        org: orgName,
        permission,
        b: (chunks) => <b className="text-foreground">{chunks}</b>,
        code: (chunks) => <code className={stateCode}>{chunks}</code>,
      })}
    </StateWrap>
  );
}

/**
 * `emptyState` for an address nothing answers. The `not-found.tsx` boundaries
 * under `[org]` and `[org]/[ws]` draw it in place of the page body when a page
 * calls `notFound()` (a run, an agent or a record that does not exist), so the
 * shell stays, as it does for every other state. It names the path the reader
 * asked for and the workspace or organization it was looked for in, read from
 * the route params because a not-found boundary receives no props. The one
 * action goes back to Fleet, or to the Organization page above a workspace.
 */
export function PageNotFound({
  scope,
}: {
  scope: "workspace" | "organization";
}) {
  const t = useTranslations("ui.pageState.notFound");
  const params = useParams();
  const pathname = usePathname();
  const org = typeof params.org === "string" ? params.org : "";
  const ws = typeof params.ws === "string" ? params.ws : "";
  const inWorkspace = scope === "workspace" && ws !== "";
  const rich = {
    org,
    ws,
    path: pathname,
    b: (chunks: ReactNode) => <b className="text-foreground">{chunks}</b>,
    code: (chunks: ReactNode) => <code className={stateCode}>{chunks}</code>,
  };
  return (
    // `id="main"` is the skip link's target, as every page's own <main> is.
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col">
      <StateWrap
        testId="page-not-found"
        tone="neutral"
        title={t("title")}
        actions={
          inWorkspace ? (
            <SafeLink to={routes.fleet(org, ws)} className={buttonPrimary}>
              {t("backFleet")}
            </SafeLink>
          ) : (
            <SafeLink to={routes.people(org)} className={buttonPrimary}>
              {t("backOrganization")}
            </SafeLink>
          )
        }
      >
        {inWorkspace
          ? t.rich("bodyWorkspace", rich)
          : t.rich("bodyOrganization", rich)}
      </StateWrap>
    </main>
  );
}
