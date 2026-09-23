// The Audit page's not-loaded states (rev1 audit.md, States): empty, error,
// access denied, and an access request still waiting. Each replaces the page
// body under the header and never the shell, carries the design's copy, and
// marks itself `data-audit-failed` when the read did not answer, so the
// header's gold Export evidence bundle steps aside and the state's own action
// is the one gold action on the screen.
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
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { IncidentDialog, RequestAccessDialog } from "./dialogs";
import { AUDIT_GAPS } from "./gaps";

type Failure = Exclude<Read<unknown>, { ok: true }>;

function StateWrap({
  state,
  failed,
  title,
  body,
  actions,
  children,
}: {
  state: string;
  failed: boolean;
  title: string;
  body: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      data-state={state}
      data-testid={`audit-${state}`}
      {...(failed ? { "data-audit-failed": "" } : {})}
      aria-labelledby={`audit-${state}-title`}
      className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-16 text-center"
    >
      <h2 id={`audit-${state}-title`} className="text-lg font-semibold">
        {title}
      </h2>
      <p className="text-[13px] text-muted-foreground">{body}</p>
      <div className="flex flex-wrap justify-center gap-2 max-md:w-full max-md:flex-col">
        {actions}
      </div>
      {children}
    </section>
  );
}

export function AuditEmpty({ org }: { org: string }) {
  const t = useTranslations("audit.empty");
  return (
    <StateWrap
      state="empty"
      failed={false}
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

const code = "rounded bg-hl px-1 font-mono text-[0.92em]";

export function AuditFailure({
  read,
  orgName,
  orgRole,
  retry,
  fleet,
  organization,
  at,
}: {
  read: Failure;
  orgName: string;
  orgRole: OrgRole;
  /** This same page, for Try again. */
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
        <StateWrap
          state="denied"
          failed
          title={t("denied.title")}
          body={t.rich("denied.body", {
            org: orgName,
            permission: read.permission,
            b: (chunks) => <b>{chunks}</b>,
            code: (chunks) => <code className={code}>{chunks}</code>,
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
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-left text-[13px]">
            <dt className="text-muted-foreground">{t("denied.signedIn")}</dt>
            <dd className={mono}>{t(`roles.${orgRole}`)}</dd>
            <dt className="text-muted-foreground">{t("denied.needed")}</dt>
            <dd className={mono}>{read.permission}</dd>
            <dt className="text-muted-foreground">{t("denied.decidedBy")}</dt>
            <dd data-recorded="false" className="text-muted-foreground">
              {t("notRecorded")}
            </dd>
          </dl>
        </StateWrap>
      );
    case "pending_approval":
      return (
        <StateWrap
          state="pending"
          failed
          title={t("pending.title")}
          body={t("pending.body", { id: read.accessRequestId })}
          actions={null}
        />
      );
    case "error":
      return (
        <StateWrap
          state="error"
          failed
          title={t("error.title")}
          body={t.rich("error.body", {
            status: String(read.status),
            code: read.code,
            c: (chunks) => <code className={code}>{chunks}</code>,
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
          <p className={`${mono} text-xs text-dim`}>
            {t("error.trace", { at })}
          </p>
        </StateWrap>
      );
  }
}
