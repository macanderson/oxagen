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
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap, stateTrace } from "@/ui/state-wrap";

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
        <StateWrap
          tone="denied"
          testId="mandate-denied"
          title={t("denied.title")}
          actions={
            <SafeLink to={routes.fleet(org, ws)} className={buttonSecondary}>
              {t("back")}
            </SafeLink>
          }
          after={
            <ul className="mx-auto mt-5 flex max-w-[420px] flex-col gap-[7px] text-left text-[12.5px] text-muted-foreground">
              <li>{t("denied.signedIn", { role: roles(orgRole) })}</li>
              <li>
                {t("denied.needed")}{" "}
                <span className={`${mono} text-foreground`}>
                  {read.permission}
                </span>
              </li>
              <li>{t("denied.decidedBy")}</li>
            </ul>
          }
        >
          {t("denied.body")}
        </StateWrap>
      );
    case "pending_approval":
      return (
        <StateWrap
          tone="neutral"
          glyph="lock"
          testId="mandate-pending"
          title={t("pending.title")}
        >
          {t("pending.body", { request: read.accessRequestId })}
        </StateWrap>
      );
    case "error":
      return (
        <StateWrap
          tone="failed"
          testId="mandate-error"
          title={t("error.title")}
          actions={
            <SafeLink to={retry} className={buttonPrimary}>
              {t("error.retry")}
            </SafeLink>
          }
          after={
            <p className={stateTrace}>
              {t("error.code", {
                status: String(read.status),
                code: read.code,
              })}
              <br />
              {t("error.readAt", { at: readAt })}
            </p>
          }
        >
          {t("error.body")}
        </StateWrap>
      );
  }
}
