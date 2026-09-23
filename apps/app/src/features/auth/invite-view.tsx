// The invitation screen (mockup `obInvite`): the inviter, the facts of the
// invitation, and accept or decline for the invited account. A closed
// invitation keeps the card and says why at its top; another signed-in account
// gets one full card in place of the page. Server Component; the buttons are
// the InviteDecision island.
//
// The design also lists the workspace, the workspace role and what that role
// lets you do. `org.invitations` carries no workspace, so those rows are not
// drawn until the invitation records one (ARCHITECTURE.md §3.6: an unbacked
// in-page slice renders nothing).
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { getFormatter, getTranslations } from "next-intl/server";
import type { InvitationView } from "@/data/contracts/invitations";
import type { InvitationDecision } from "./invitation";
import { InviteDecision } from "./invite-decision";
import { routes } from "@/shared/safe-path";
import { SafeLink } from "@/ui/navigation";
import { OutcomePanel } from "@/ui/form-feedback";
import {
  buttonPrimary,
  buttonSecondary,
  linkText,
  mono,
} from "@/ui/control-styles";
import { AuthFooter } from "@/ui/auth-shell";
import { AuthAlert, AuthPanel } from "./ui/auth-card";

const monoTag = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;

export async function InvitationNotFound() {
  const t = await getTranslations("auth.invite");
  return (
    <OutcomePanel
      tone="neutral"
      testId="invite-not-found"
      title={t("notFoundTitle")}
    >
      {t("notFoundBody")}
    </OutcomePanel>
  );
}

/** Two letters for the inviter's tile: the first letters of the first and last words. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "";
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/** Signed in as an address the invitation was not sent to: the full-card state. */
export async function InvitationWrongAccount({
  invitation,
  signedInAs,
}: {
  invitation: InvitationView;
  signedInAs: string;
}) {
  const t = await getTranslations("auth.invite");
  const here = routes.invite(invitation.token);
  const values = {
    invited: invitation.email,
    current: signedInAs,
    mono: monoTag,
  };
  return (
    <OutcomePanel
      tone="deny"
      testId="invite-wrong-account"
      title={t("wrongAccountTitle")}
      icon={<Lock aria-hidden className="size-5" />}
      actions={
        <SafeLink to={routes.login(here)} className={buttonSecondary}>
          {t("logInAsOther")}
        </SafeLink>
      }
    >
      {invitation.inviterName
        ? t.rich("wrongAccountBody", {
            ...values,
            inviter: invitation.inviterName,
          })
        : t.rich("wrongAccountBodyNoInviter", values)}
    </OutcomePanel>
  );
}

export async function InvitationBody({
  invitation,
  decision,
}: {
  invitation: InvitationView;
  decision: Exclude<InvitationDecision, { kind: "wrong-account" }>;
}) {
  const t = await getTranslations("auth.invite");
  const format = await getFormatter();
  const here = routes.invite(invitation.token);
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });
  const invitedOn = date(invitation.invitedAt);

  return (
    <>
      <section aria-label={t("eyebrow")} data-testid="invite-card">
        <AuthPanel>
          {decision.kind === "closed" ? (
            <AuthAlert
              testId={`invite-closed-${decision.status}`}
              message={t(`closed.${decision.status}`)}
            />
          ) : null}
          <div className="flex items-center gap-3 border-b border-border pb-4">
            {invitation.inviterName ? (
              <>
                <span
                  aria-hidden
                  className="grid size-[38px] flex-none place-items-center rounded-full bg-foreground text-[13px] font-semibold text-background"
                >
                  {initialsOf(invitation.inviterName)}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {invitation.inviterName}
                  </p>
                  <p className="text-[12.5px] text-muted-foreground">
                    {invitation.inviterRole
                      ? t("invitedOn", {
                          role: t(`roles.${invitation.inviterRole}`),
                          date: invitedOn,
                        })
                      : t("invitedOnNoRole", { date: invitedOn })}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                {t("invitedOnNoRole", { date: invitedOn })}
              </p>
            )}
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] sm:gap-y-2.5">
            <dt className="text-dim">{t("organization")}</dt>
            <dd className="mb-2 min-w-0 break-words text-foreground sm:mb-0">
              {invitation.orgName}{" "}
              <span className={`${mono} text-dim`}>({invitation.orgSlug})</span>
            </dd>
            <dt className="text-dim">{t("role")}</dt>
            <dd className="mb-2 text-foreground sm:mb-0">
              {t(`roles.${invitation.role}`)}
            </dd>
            <dt className="text-dim">{t("expires")}</dt>
            <dd className="text-foreground">
              {invitation.expiresAt ? date(invitation.expiresAt) : t("never")}
            </dd>
          </dl>
          {decision.kind === "accept" ? (
            <InviteDecision token={invitation.token} />
          ) : decision.kind === "sign-in" ? (
            <div className="flex flex-col gap-3">
              <p className="text-[13px] text-muted-foreground">
                {t.rich("signInLead", {
                  email: invitation.email,
                  mono: monoTag,
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <SafeLink to={routes.login(here)} className={buttonPrimary}>
                  {t("logIn")}
                </SafeLink>
                <SafeLink to={routes.signup(here)} className={buttonSecondary}>
                  {t("signUp")}
                </SafeLink>
              </div>
            </div>
          ) : null}
        </AuthPanel>
      </section>
      {decision.kind === "accept" ? (
        <AuthFooter>
          {t.rich("signedInAs", { email: invitation.email, mono: monoTag })}{" "}
          <span aria-hidden className="text-dim">
            ·
          </span>{" "}
          <SafeLink to={routes.login(here)} className={linkText}>
            {t("notYou")}
          </SafeLink>
        </AuthFooter>
      ) : null}
    </>
  );
}
