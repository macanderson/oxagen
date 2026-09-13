// The invitation screen's body for each decision: accept, sign in first,
// wrong account, closed, not found. Server Component; the buttons are the
// InviteDecision island.
import Link from "next/link";

import { getFormatter, getTranslations } from "next-intl/server";
import type { InvitationDecision, InvitationView } from "./invitation";
import { InviteDecision } from "./invite-decision";
import { withNext } from "./safe-next";
import { OutcomePanel } from "@/ui/form-feedback";
import {
  buttonPrimary,
  buttonSecondary,
  linkText,
  mono,
  panel,
} from "@/ui/control-styles";

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

export async function InvitationBody({
  invitation,
  decision,
}: {
  invitation: InvitationView;
  decision: InvitationDecision;
}) {
  const t = await getTranslations("auth.invite");
  const format = await getFormatter();
  const here = `/invite/${invitation.token}`;

  if (decision.kind === "closed") {
    return (
      <OutcomePanel
        tone="neutral"
        testId={`invite-closed-${decision.status}`}
        title={t("closedTitle")}
        actions={
          decision.status === "accepted" ? (
            <Link href="/login" className={buttonSecondary}>
              {t("logIn")}
            </Link>
          ) : null
        }
      >
        {t(`closed.${decision.status}`)}
      </OutcomePanel>
    );
  }

  if (decision.kind === "wrong-account") {
    return (
      <OutcomePanel
        tone="deny"
        testId="invite-wrong-account"
        title={t("wrongAccountTitle")}
        actions={
          <Link href={withNext("/login", here)} className={buttonSecondary}>
            {t("logInAsOther")}
          </Link>
        }
      >
        {t("wrongAccountBody", {
          invited: invitation.email,
          current: decision.signedInAs,
        })}
      </OutcomePanel>
    );
  }

  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });

  return (
    <section
      aria-label={t("eyebrow")}
      data-testid="invite-card"
      className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
    >
      <p className="text-sm text-foreground">
        <span className="font-semibold">
          {invitation.inviterName
            ? t("invitedBy", { inviter: invitation.inviterName })
            : t("invitedByUnknown")}
        </span>{" "}
        <span className="text-muted-foreground">
          {t("invitedOn", { date: date(invitation.invitedAt) })}
        </span>
      </p>
      <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-2 border-y border-border py-3 text-sm">
        <dt className="text-muted-foreground">{t("organization")}</dt>
        <dd className="min-w-0 break-words text-foreground">
          {invitation.orgName}{" "}
          <span className={`${mono} text-muted-foreground`}>
            ({invitation.orgSlug})
          </span>
        </dd>
        <dt className="text-muted-foreground">{t("role")}</dt>
        <dd className="text-foreground">{t(`roles.${invitation.role}`)}</dd>
        <dt className="text-muted-foreground">{t("sentTo")}</dt>
        <dd className={`${mono} min-w-0 break-all text-foreground`}>
          {invitation.email}
        </dd>
        <dt className="text-muted-foreground">{t("expires")}</dt>
        <dd className="text-foreground">
          {invitation.expiresAt ? date(invitation.expiresAt) : t("never")}
        </dd>
      </dl>
      {decision.kind === "accept" ? (
        <InviteDecision token={invitation.token} orgName={invitation.orgName} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t("signInLead", { email: invitation.email })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={withNext("/login", here)} className={buttonPrimary}>
              {t("logIn")}
            </Link>
            <Link href={withNext("/signup", here)} className={buttonSecondary}>
              {t("signUp")}
            </Link>
          </div>
        </div>
      )}
      {decision.kind === "accept" ? (
        <p className="text-xs text-muted-foreground">
          {t("signedInAs", { email: invitation.email })} ·{" "}
          <Link href={withNext("/login", here)} className={linkText}>
            {t("notYou")}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
