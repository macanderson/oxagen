// The not-loaded states of the agent page (spec pages/agent.md, States).
// Each replaces the page
// body and never the shell, so a reader who cannot see this agent keeps the
// sidebar, the breadcrumbs and the search, and can leave.
//
// Two of the controls the design names have no write behind them yet:
// Request access (no contract lets a person ask for a role) and Open an
// incident (no contract files one). Each is a StubAction, which opens a sheet
// saying what it would do and what is missing, rather than a button that does
// nothing. The trace line prints what the read recorded, the code and the
// instant it failed, because the kernel seam carries no trace id to the page.
//
// Each state is the shared `StateWrap`, the design's `.state-wrap`: a glyph
// tile, a heading, one paragraph and the actions, with no panel around them.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
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
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateFacts, stateTrace } from "@/ui/state-wrap";
import { StubAction } from "./stub-action";

type Failure = Exclude<Read<unknown>, { ok: true }>;

/**
 * Which page the state stands in for. The agent page is the one left: its
 * definition file and the editor that opened it went with ADR-192.
 */
export type StateSubject = "agent";

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
        <StateWrap
          tone="denied"
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
          after={
            <dl className={stateFacts}>
              <dt className={kvTerm}>{s("signedInAs")}</dt>
              <dd className={kvValue}>
                {s("signedInValue", {
                  orgRole: viewer.orgRole,
                  wsRole: viewer.wsRole,
                  workspace: viewer.wsSlug,
                })}
              </dd>
              <dt className={kvTerm}>{s("neededLabel")}</dt>
              <dd className={`${kvValue} ${mono}`}>{needed}</dd>
              <dt className={kvTerm}>{s("decidedBy")}</dt>
              <dd className={kvValue}>{s("decidedByValue")}</dd>
            </dl>
          }
        >
          {s("denied.body", {
            org: viewer.orgName,
            permission: needed,
          })}
        </StateWrap>
      );
    }
    case "pending_approval":
      return (
        <StateWrap
          tone="neutral"
          glyph="lock"
          testId={`${subject}-pending`}
          title={s("pending.title")}
          actions={
            <SafeLink to={fleet} className={buttonSecondary}>
              {s("backToFleet")}
            </SafeLink>
          }
        >
          {s("pending.body", { request: read.accessRequestId })}
        </StateWrap>
      );
    case "error":
      return (
        <StateWrap
          tone="failed"
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
          after={
            <p className={stateTrace} data-testid="state-trace">
              {s("error.trace", {
                code: `${String(read.status)} ${read.code}`,
                at: readAt,
              })}
            </p>
          }
        >
          {s("error.body", {
            code: `${String(read.status)} ${read.code}`,
          })}
        </StateWrap>
      );
  }
}

/** The empty state of an agent with no frame yet: registered and enrolled, and nothing to show. */
export function AgentNeverRan({ fleet }: { fleet: SafePath }) {
  const t = useTranslations("agents.states");
  return (
    <StateWrap
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
    </StateWrap>
  );
}

/**
 * The loading state: the shell stays, and the body is four tile blocks and a
 * panel of seven rows (spec, States), each bone the design's `.sk` shimmer,
 * so no figure flashes as a zero before the reads land. The frame keeps the page's container classes but is not
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
        <div aria-hidden="true" className={statStrip}>
          {[0, 1, 2, 3].map((tile) => (
            <span
              key={tile}
              data-skeleton-tile=""
              className="skeleton h-16 rounded-[11px]"
            />
          ))}
        </div>
        <div aria-hidden="true" className={`${panel} flex flex-col`}>
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
    </div>
  );
}
