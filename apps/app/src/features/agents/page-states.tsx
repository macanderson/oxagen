// The not-loaded states of the agent page and of its source editor (spec
// pages/agent.md and pages/agent-source.md, States). Each replaces the page
// body and never the shell, so a reader who cannot see this agent keeps the
// sidebar, the breadcrumbs and the search, and can leave.
//
// Two of the controls the design names have no write behind them yet:
// Request access (no contract lets a person ask for a role) and Open an
// incident (no contract files one). Each is a StubAction, which opens a sheet
// saying what it would do and what is missing, rather than a button that does
// nothing. The trace line prints what the read recorded, the code and the
// instant it failed, because the kernel seam carries no trace id to the page.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
} from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { StubAction } from "./stub-action";

type Failure = Exclude<Read<unknown>, { ok: true }>;

/** Which page the state stands in for: the agent, or its definition file. */
export type StateSubject = "agent" | "source";

export type Viewer = {
  orgSlug: string;
  orgName: string;
  orgRole: string;
  wsSlug: string;
  wsRole: string;
};

export function AgentPageFailure({
  read,
  subject,
  viewer,
  retry,
  readAt,
}: {
  read: Failure;
  subject: StateSubject;
  viewer: Viewer;
  /** Where Try again points: this same page. */
  retry: SafePath;
  /** The instant the read failed, formatted by the caller. */
  readAt: string;
}) {
  const s = useTranslations("agents.states");
  const fleet = routes.fleet(viewer.orgSlug, viewer.wsSlug);
  switch (read.reason) {
    case "denied": {
      const needed = s("needed", {
        permission: read.permission,
        workspace: viewer.wsSlug,
      });
      return (
        <OutcomePanel
          tone="deny"
          testId={`${subject}-denied`}
          title={s(`${subject}.denied`)}
          actions={
            <>
              <StubAction
                label={s("requestAccess.open")}
                title={s("requestAccess.title")}
                body={s("requestAccess.body", { permission: needed })}
                gap="access_request"
                testId={`${subject}-request-access`}
              />
              <SafeLink to={fleet} className={buttonSecondary}>
                {s("backToFleet")}
              </SafeLink>
            </>
          }
        >
          <span className="flex flex-col gap-4">
            <span>
              {s("denied.body", {
                org: viewer.orgName,
                permission: needed,
              })}
            </span>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-left text-xs">
              <dt className="text-dim">{s("signedInAs")}</dt>
              <dd>
                {s("signedInValue", {
                  orgRole: viewer.orgRole,
                  wsRole: viewer.wsRole,
                  workspace: viewer.wsSlug,
                })}
              </dd>
              <dt className="text-dim">{s("neededLabel")}</dt>
              <dd className={mono}>{needed}</dd>
              <dt className="text-dim">{s("decidedBy")}</dt>
              <dd>{s("decidedByValue")}</dd>
            </dl>
          </span>
        </OutcomePanel>
      );
    }
    case "pending_approval":
      return (
        <OutcomePanel
          tone="neutral"
          testId={`${subject}-pending`}
          title={s("pending.title")}
          actions={
            <SafeLink to={fleet} className={buttonSecondary}>
              {s("backToFleet")}
            </SafeLink>
          }
        >
          {s("pending.body", { request: read.accessRequestId })}
        </OutcomePanel>
      );
    case "error":
      return (
        <OutcomePanel
          tone="neutral"
          testId={`${subject}-error`}
          title={s(`${subject}.error`)}
          actions={
            <>
              <SafeLink to={retry} className={buttonPrimary}>
                {s("tryAgain")}
              </SafeLink>
              <StubAction
                label={s("openIncident.open")}
                title={s("openIncident.title")}
                body={s("openIncident.body", {
                  code: `${String(read.status)} ${read.code}`,
                })}
                gap="incident_create"
                testId={`${subject}-open-incident`}
              />
            </>
          }
        >
          <span className="flex flex-col gap-3">
            <span>
              {s("error.body", {
                code: `${String(read.status)} ${read.code}`,
              })}
            </span>
            <span className={`${mono} text-xs`} data-testid="state-trace">
              {s("error.trace", {
                code: `${String(read.status)} ${read.code}`,
                at: readAt,
              })}
            </span>
          </span>
        </OutcomePanel>
      );
  }
}

/** The empty state of an agent with no frame yet: registered and enrolled, and nothing to show. */
export function AgentNeverRan({ fleet }: { fleet: SafePath }) {
  const t = useTranslations("agents.states");
  return (
    <OutcomePanel
      tone="neutral"
      testId="agent-empty"
      title={t("empty.title")}
      actions={
        <SafeLink to={fleet} className={buttonSecondary}>
          {t("backToFleet")}
        </SafeLink>
      }
    >
      {t("empty.body")}
    </OutcomePanel>
  );
}

const bar = "block animate-pulse rounded bg-muted motion-reduce:animate-none";

/**
 * The loading state: the shell stays, and the body is four tile blocks and a
 * panel of seven rows (spec, States), so no figure flashes as a zero before
 * the reads land. The frame keeps the page's container classes but is not
 * `main#main`: while the page streams in, the document holds this fallback
 * and the hidden page together, and only the page may own the landmark, or
 * the skip link gets two targets and page-load's strict locator fails
 * (#4036, and Billing on 2026-09-24).
 */
export function AgentLoading() {
  const t = useTranslations("agents.states");
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10">
      <div
        role="status"
        aria-busy="true"
        data-testid="agent-loading"
        className="flex flex-col gap-4"
      >
        <span className="sr-only">{t("loading")}</span>
        <div
          aria-hidden="true"
          className="grid grid-cols-2 gap-3.5 md:grid-cols-4"
        >
          {[0, 1, 2, 3].map((tile) => (
            <span key={tile} className={`${bar} h-16 rounded-xl`} />
          ))}
        </div>
        <div aria-hidden="true" className={`${panel} flex flex-col`}>
          <div className="border-b border-border px-4 py-3">
            <span className={`${bar} h-4 w-44`} />
          </div>
          <div className="flex flex-col gap-2 px-4 py-3.5">
            {[0, 1, 2, 3, 4, 5, 6].map((row) => (
              <span key={row} className={`${bar} h-8 w-full`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
