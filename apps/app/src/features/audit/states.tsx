// The Audit page's not-loaded states (rev1 audit.md, States): empty, error,
// access denied, and an access request still waiting. Each replaces the page
// body and never the shell, carries the design's copy and glyph, and marks
// itself `data-audit-state`, so the page header steps out of view (its h1
// stays in the document) and the state is shown alone, as the design draws
// it. The state's own action is then the one gold action on the screen, and
// the empty state has none.
//
// What the design asks for and the record cannot give is said, not invented:
// the trace id and region of a failed read and the policy that refused one are
// "not recorded" (#3841, #3846), and Request access and Open an incident open
// dialogs that name the write they wait on (#3820, #3847).
import "server-only";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import type { OrgRole } from "@/server/viewer";
import {
  buttonPrimary,
  buttonSecondary,
  kvTerm,
  kvValue,
  mono,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import {
  StateWrap,
  type StateTone,
  stateCode,
  stateFacts,
  stateTrace,
} from "@/ui/state-wrap";
import { IncidentDialog, RequestAccessDialog } from "./dialogs";
import { AUDIT_GAPS } from "./gaps";

type Failure = Exclude<Read<unknown>, { ok: true }>;

/**
 * The shared `.state-wrap`, marked `data-audit-state` so the page header
 * steps out of view while a state stands alone.
 */
function AuditState({
  state,
  tone,
  lock = false,
  title,
  body,
  actions,
  children,
}: {
  state: string;
  tone: StateTone;
  /** Draw the lock in a neutral tone: an access request still waiting. */
  lock?: boolean;
  title: string;
  body: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <StateWrap
      testId={`audit-${state}`}
      data-state={state}
      data-audit-state={state}
      tone={tone}
      glyph={lock ? "lock" : undefined}
      title={title}
      actions={actions}
      after={children}
    >
      {body}
    </StateWrap>
  );
}

export function AuditEmpty({ org }: { org: string }) {
  const t = useTranslations("audit.empty");
  return (
    <AuditState
      state="empty"
      tone="neutral"
      title={t("title")}
      body={t("body")}
      actions={
        <SafeLink to={routes.people(org)} className={buttonSecondary}>
          {t("action")}
        </SafeLink>
      }
    />
  );
}

export function AuditFailure({
  read,
  org,
  orgName,
  orgRole,
  viewer,
  retry,
  fleet,
  organization,
  at,
}: {
  read: Failure;
  /** The organization's slug, named beside the viewer's role. */
  org: string;
  orgName: string;
  orgRole: OrgRole;
  /** The signed-in person's name, or their email when they set none. */
  viewer: string;
  /** This same page with its query, for Try again. */
  retry: SafePath;
  /** Fleet of a workspace the viewer can open, or null when none was read. */
  fleet: SafePath | null;
  /** The Organization page, where a denied reader goes when no workspace was read. */
  organization: SafePath;
  /** When the read failed, already formatted. */
  at: string;
}) {
  const t = useTranslations("audit");
  switch (read.reason) {
    case "denied":
      return (
        <AuditState
          state="denied"
          tone="denied"
          title={t("denied.title")}
          body={t.rich("denied.body", {
            org: orgName,
            permission: read.permission,
            b: (chunks) => <b className="text-foreground">{chunks}</b>,
            code: (chunks) => <code className={stateCode}>{chunks}</code>,
          })}
          actions={
            <>
              <RequestAccessDialog
                gap={AUDIT_GAPS.requestAccess}
                permission={read.permission}
              />
              {fleet === null ? (
                <SafeLink to={organization} className={buttonSecondary}>
                  {t("denied.open")}
                </SafeLink>
              ) : (
                <SafeLink to={fleet} className={buttonSecondary}>
                  {t("denied.back")}
                </SafeLink>
              )}
            </>
          }
        >
          <dl className={stateFacts}>
            <dt className={kvTerm}>{t("denied.signedIn")}</dt>
            <dd className={kvValue}>
              {t.rich("denied.signedInAs", {
                name: viewer,
                role: `org.${orgRole}`,
                org,
                c: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </dd>
            <dt className={kvTerm}>{t("denied.needed")}</dt>
            <dd className={`${kvValue} ${mono}`}>{read.permission}</dd>
            <dt className={kvTerm}>{t("denied.decidedBy")}</dt>
            <dd data-recorded="false" className="text-muted-foreground">
              {t("notRecorded")}
            </dd>
          </dl>
        </AuditState>
      );
    case "pending_approval":
      return (
        <AuditState
          state="pending"
          tone="neutral"
          lock
          title={t("pending.title")}
          body={t("pending.body", { id: read.accessRequestId })}
          actions={null}
        />
      );
    case "error":
      return (
        <AuditState
          state="error"
          tone="failed"
          title={t("error.title")}
          body={t.rich("error.body", {
            status: String(read.status),
            code: read.code,
            c: (chunks) => <code className={stateCode}>{chunks}</code>,
          })}
          actions={
            <>
              <SafeLink to={retry} className={buttonPrimary}>
                {t("error.retry")}
              </SafeLink>
              <IncidentDialog gap={AUDIT_GAPS.errorIncident} />
            </>
          }
        >
          <p className={stateTrace}>{t("error.trace", { at })}</p>
        </AuditState>
      );
  }
}
