// The Billing page's not-loaded states (pages/billing.md, States). Each
// replaces the page body, header included, and never the shell: the sidebar,
// the breadcrumbs and the search stay, so a reader keeps their bearings. The
// shape is the mockup's `.state-wrap`: a glyph, a heading, one paragraph, the
// actions, and on the error and denied states a line of what was recorded.
//
//   - loading: four tile blocks and a panel of seven rows; no figure, no zero.
//   - empty: nothing billable yet, with Back to Fleet.
//   - error: the code the read path answered, Try again (this same page) and
//     Open an incident, then the trace line. The read path carries no trace id
//     and no region, so the line says so and prints the instant of the read.
//   - denied: the permission the read needed, Request access and Back to
//     Fleet, then who is signed in (name and role), what was needed, and what
//     decided it. A refusal carries no policy version yet (#3846), so the
//     Decided by line says the version is not recorded.
//   - pending: an access request the kernel parked for approval.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { OrgRole } from "@/data/contracts/common";
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
import {
  StateWrap,
  type StateTone,
  stateCode,
  stateFacts,
  stateTrace,
} from "@/ui/state-wrap";
import { OpenIncident, RequestAccess } from "./state-dialogs";

export function BillingSkeleton() {
  const t = useTranslations("billing.state");
  return (
    <div
      aria-busy="true"
      aria-label={t("loading")}
      role="status"
      data-state="loading"
      className="flex flex-col gap-4"
    >
      <div className={statStrip}>
        {[0, 1, 2, 3].map((tile) => (
          <span
            key={tile}
            data-skeleton-tile=""
            className="skeleton h-16 rounded-[11px]"
          />
        ))}
      </div>
      <div className={`${panel} flex flex-col`}>
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

/** The shared `.state-wrap`, marked with the page's `data-state`. */
function BillingState({
  state,
  tone,
  lock = false,
  title,
  body,
  actions,
  after,
}: {
  state: string;
  tone: StateTone;
  /** Draw the lock in a neutral tone: an access request still waiting. */
  lock?: boolean;
  title: string;
  body: ReactNode;
  actions?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <StateWrap
      data-state={state}
      titleId={`billing-${state}-title`}
      tone={tone}
      glyph={lock ? "lock" : undefined}
      title={title}
      actions={actions}
      after={after}
    >
      {body}
    </StateWrap>
  );
}

export function BillingEmpty() {
  const t = useTranslations("billing.state.empty");
  return (
    <BillingState
      state="empty"
      tone="neutral"
      title={t("title")}
      body={t("body")}
      actions={
        <SafeLink
          to={routes.root()}
          data-touch-target=""
          className={buttonSecondary}
        >
          {t("back")}
        </SafeLink>
      }
    />
  );
}

export function BillingError({
  code,
  status,
  at,
  retry,
}: {
  code: string;
  status: number;
  /** The instant the read failed, as the caller formatted it. */
  at: string;
  /** Where Try again points: this same page. */
  retry: SafePath;
}) {
  const t = useTranslations("billing.state.error");
  return (
    <BillingState
      state="error"
      tone="failed"
      title={t("title")}
      body={t.rich("body", {
        status: String(status),
        errorCode: code,
        code: (chunks) => <code className={stateCode}>{chunks}</code>,
      })}
      actions={
        <>
          <SafeLink to={retry} data-touch-target="" className={buttonPrimary}>
            {t("retry")}
          </SafeLink>
          <OpenIncident code={`${String(status)} ${code}`} at={at} />
        </>
      }
      after={<p className={stateTrace}>{t("trace", { at })}</p>}
    />
  );
}

export function BillingDenied({
  org,
  permission,
  name,
  role,
}: {
  /** The organization's display name. */
  org: string;
  /** The permission the read was refused on. */
  permission: string;
  /** The signed-in person's name; null when the session carries none. */
  name: string | null;
  /** The signed-in person's role on the organization. */
  role: OrgRole;
}) {
  const t = useTranslations("billing.state.denied");
  const roles = useTranslations("billing.roles");
  return (
    <BillingState
      state="denied"
      tone="denied"
      title={t("title")}
      body={t.rich("body", {
        org,
        permission,
        b: (chunks) => <b className="text-foreground">{chunks}</b>,
        code: (chunks) => <code className={stateCode}>{chunks}</code>,
      })}
      actions={
        <>
          <RequestAccess permission={permission} />
          <SafeLink
            to={routes.root()}
            data-touch-target=""
            className={buttonSecondary}
          >
            {t("back")}
          </SafeLink>
        </>
      }
      after={
        <dl className={stateFacts}>
          <dt className={kvTerm}>{t("signedIn")}</dt>
          <dd data-fact="signed-in" className={`${kvValue} ${mono}`}>
            {name === null
              ? roles(role)
              : t("signedInValue", { name, role: roles(role) })}
          </dd>
          <dt className={kvTerm}>{t("needed")}</dt>
          <dd data-fact="needed" className={kvValue}>
            {t.rich("neededValue", {
              permission,
              code: (chunks) => <span className={mono}>{chunks}</span>,
            })}
          </dd>
          <dt className={kvTerm}>{t("decidedBy")}</dt>
          <dd data-fact="decided-by" className={kvValue}>
            {t.rich("decidedByValue", {
              policy: (chunks) => (
                <span data-recorded="false" className="text-muted-foreground">
                  {chunks}
                </span>
              ),
            })}
          </dd>
        </dl>
      }
    />
  );
}

export function BillingPending({ request }: { request: string }) {
  const t = useTranslations("billing.state.pending");
  return (
    <BillingState
      state="pending"
      tone="neutral"
      lock
      title={t("title")}
      body={t("body", { request })}
    />
  );
}
