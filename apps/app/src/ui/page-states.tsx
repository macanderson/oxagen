"use client";
// The three not-loaded states every page shares (mockups/pages/audit-prompt.md
// check 22; engine.js `skeleton()`, `errorState()`, `deniedState()`). Each
// replaces the page BODY and never the shell: the sidebar, the breadcrumbs and
// the search stay, so a person who cannot see a page keeps their bearings.
// A page lane passes its own copy in (its title, its error code, the
// permission it needed); the sentences every page shares live here once.
//
// Two controls the design draws have no write behind them yet, and neither is
// stubbed into silence. *Request access* would ask an owner for a role and
// *Open an incident* would file one; no contract does either (#3846, #3847).
// Each renders as a disabled button that says why, so the reader learns the
// route that does exist rather than pressing a control that does nothing.
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  startTransition,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono, panel } from "./control-styles";
import { SafeLink, useNavigate } from "./navigation";

/** The issue that owns each missing write, carried as a data attribute only. */
const REQUEST_ACCESS_GAP = "#3846";
const OPEN_INCIDENT_GAP = "#3847";

const bone =
  "block animate-pulse rounded-lg bg-muted motion-reduce:animate-none";

/**
 * `skeleton()`: four tile blocks and a panel of seven rows. The shape of a
 * page's answer, so nothing moves when the reads land and no zero ever
 * flashes where a figure is coming.
 */
export function PageSkeleton({ label }: { label?: string }) {
  const t = useTranslations("ui.pageState");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="page-skeleton"
      className="flex w-full flex-col gap-4 px-4 py-5 md:px-6"
    >
      <span className="sr-only">{label ?? t("loading")}</span>
      <div
        aria-hidden="true"
        data-testid="page-skeleton-tiles"
        className="grid grid-cols-2 gap-3.5 md:grid-cols-4"
      >
        {[0, 1, 2, 3].map((tile) => (
          <span
            key={tile}
            data-skeleton-tile=""
            className={`${bone} h-16 border border-border`}
          />
        ))}
      </div>
      <div aria-hidden="true" className={panel}>
        <div className="border-b border-border bg-hl px-4 py-3">
          <span className={`${bone} h-5 w-44`} />
        </div>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <span key={row} data-skeleton-row="" className={`${bone} h-9`} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StateIcon({ tone }: { tone: "failed" | "denied" }) {
  return (
    <span
      aria-hidden="true"
      className={`mx-auto mb-3.5 grid size-11 place-items-center rounded-xl border bg-card ${
        tone === "failed"
          ? "border-error/40 text-error-ink"
          : "border-warning/40 text-warning"
      }`}
    >
      {tone === "failed" ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 8v5M12 17h.01" stroke="currentColor" strokeWidth="1.7" />
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeWidth="1.7"
          />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <rect
            x="4"
            y="10"
            width="16"
            height="10"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path
            d="M8 10V7a4 4 0 0 1 8 0v3"
            stroke="currentColor"
            strokeWidth="1.7"
          />
        </svg>
      )}
    </span>
  );
}

/** `.state-wrap`: centred, 460px of prose, the actions on one row. */
function StateWrap({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="mx-auto flex w-full max-w-[460px] flex-col items-center px-4 py-16 text-center"
    >
      {children}
    </section>
  );
}

const code =
  "rounded border border-border bg-hl px-1 py-px font-mono text-[0.88em]";

/**
 * `errorState(what, code)`: the page could not be read. The title is the
 * page's own ("Fleet could not be loaded"); the code is the one the read path
 * answered, as `503 run_index_unavailable`.
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
    <StateWrap testId="page-error">
      <StateIcon tone="failed" />
      <h2 className="mb-1.5 text-[17px] font-semibold text-foreground">
        {title}
      </h2>
      <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">
        {t.rich("body", {
          answer: `${String(status)} ${errorCode}`,
          code: (chunks) => <code className={code}>{chunks}</code>,
        })}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
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
      </div>
      <p
        data-testid="page-error-trace"
        className="mt-4 font-mono text-[11.5px] text-muted-foreground"
      >
        {line.join(" · ")}
      </p>
      <p
        id={noteId}
        data-testid="page-error-incident-not-backed"
        className="mt-2 text-xs text-muted-foreground"
      >
        {t("incidentNotBacked")}
      </p>
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
export const RoutePageName = createContext<
  ((pathname: string) => string | null) | null
>(null);

/** `YYYY-MM-DD hh:mm:ssZ`, the instant a boundary caught the failure, as the mock's trace line prints it. */
export function utcInstant(at: Date): string {
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
   * `RoutePageName` when absent; null keeps the generic title.
   */
  page?: string | null;
}) {
  const t = useTranslations("ui.pageState.error");
  const nameOf = useContext(RoutePageName);
  const pathname = usePathname();
  const name =
    page === undefined
      ? nameOf === null || pathname === null
        ? null
        : nameOf(pathname)
      : page;
  const navigate = useNavigate();
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    setAt(utcInstant(new Date()));
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
    <StateWrap testId="page-denied">
      <StateIcon tone="denied" />
      <h2 className="mb-1.5 text-[17px] font-semibold text-foreground">
        {title}
      </h2>
      <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">
        {t.rich("body", {
          org: orgName,
          permission,
          b: (chunks) => <b className="text-foreground">{chunks}</b>,
          code: (chunks) => <code className={code}>{chunks}</code>,
        })}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
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
      </div>
      <p
        id={noteId}
        data-testid="page-denied-request-not-backed"
        className="mt-2 text-xs text-muted-foreground"
      >
        {t("requestNotBacked")}
      </p>
      <dl className="mt-5 grid w-full max-w-[420px] grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-left text-[13px]">
        <dt className="text-muted-foreground">{t("signedIn")}</dt>
        <dd>
          {signedIn.name} · <span className={mono}>{signedIn.role}</span>
          {signedIn.scope === null ? null : (
            <>
              {" · "}
              <span className={mono}>{signedIn.scope}</span>
            </>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("needed")}</dt>
        <dd>
          <span className={mono}>{permission}</span>
        </dd>
        <dt className="text-muted-foreground">{t("decidedBy")}</dt>
        <dd data-testid="page-denied-decided-by">
          {decidedBy === null ? (
            <span className="text-muted-foreground">
              {t("policyNotRecorded")}
            </span>
          ) : (
            t.rich("decidedByValue", {
              policy: decidedBy,
              code: (chunks) => <span className={mono}>{chunks}</span>,
            })
          )}
        </dd>
      </dl>
    </StateWrap>
  );
}
