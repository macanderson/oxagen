// The three not-loaded states of the mandate page. Each replaces the page BODY
// and never the shell: the sidebar, the breadcrumbs and the search stay, so an
// operator who cannot see this mandate keeps their bearings and can leave.
//
// **Access denied names the permission and not the person's shortcoming.** The
// read is `get_mandate`, whose accountable readers are the org's Owner, Admin,
// Billing and Compliance roles; `PAGE_FAILURES.mandates` names `org.billing`,
// the finance role the design names. The copy says an owner can grant it and
// that the grant is itself a governed action in the audit record, because the
// reader's next move is to ask someone, and a refusal that does not say who to
// ask is a dead end.
//
// **Two controls the design asks for are not here, and neither is stubbed.**
// *Request access* would open a request-access dialog: the app has no such
// write. An access request exists in this codebase only as something the kernel
// mints when a capability parks for approval (`pending_approval` below), and no
// contract lets a person ask for a role. *Open an incident* would file one: no
// contract does that either. A button that silently does nothing is worse than
// no button on a page about who may spend money, so the copy names the route
// that does exist — an owner grants the role, and the error names its code so it
// can be reported — and the two missing writes are recorded as the gap they are.
import { useTranslations } from "next-intl";
import type { OrgRole } from "@/data/contracts/common";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function MandateReadFailure({
  read,
  orgRole,
  org,
  ws,
  retry,
  readAt,
}: {
  read: Failure;
  orgRole: OrgRole;
  org: string;
  ws: string;
  /** Where Try again points: this same page. */
  retry: SafePath;
  /**
   * The instant the read was attempted, formatted by the caller. It is passed
   * in rather than taken here because a component may not read a clock during
   * render, and because the useful instant is the one the read failed at, not
   * the one this element happened to render at.
   */
  readAt: string;
}) {
  const t = useTranslations("mandate.failure");
  const roles = useTranslations("mandate.roles");
  switch (read.reason) {
    case "denied":
      return (
        <OutcomePanel
          tone="deny"
          testId="mandate-denied"
          title={t("denied.title")}
          actions={
            <SafeLink to={routes.fleet(org, ws)} className={linkText}>
              {t("back")}
            </SafeLink>
          }
        >
          <span className="flex flex-col gap-2">
            <span>{t("denied.body")}</span>
            <span className="flex flex-col gap-0.5 text-left">
              <span>{t("denied.signedIn", { role: roles(orgRole) })}</span>
              <span>
                {t("denied.needed")}{" "}
                <span className={mono}>{read.permission}</span>
              </span>
              <span>{t("denied.decidedBy")}</span>
            </span>
          </span>
        </OutcomePanel>
      );
    case "pending_approval":
      return (
        <OutcomePanel
          tone="neutral"
          testId="mandate-pending"
          title={t("pending.title")}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </OutcomePanel>
      );
    case "error":
      return (
        <OutcomePanel
          tone="neutral"
          testId="mandate-error"
          title={t("error.title")}
          actions={
            <SafeLink to={retry} className={linkText}>
              {t("error.retry")}
            </SafeLink>
          }
        >
          <span className="flex flex-col gap-1">
            <span>{t("error.body")}</span>
            <span className={mono}>
              {t("error.code", {
                status: String(read.status),
                code: read.code,
              })}
            </span>
            <span className={mono}>{t("error.readAt", { at: readAt })}</span>
          </span>
        </OutcomePanel>
      );
  }
}
