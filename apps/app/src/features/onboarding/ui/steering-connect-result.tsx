// The steering connect's result page body, /github/steering/result (#5151).
// The landing at /github/steering sends a person here when the account they're
// signed in with can't open the organization the connect returns to. Most
// often the browser that finished the GitHub install is signed in to another
// Oxagen account than the one that started the connect. This page says how the
// install ended and what to do next, instead of ending on the organization's
// 404.
//
// The copy is the same for an unknown organization and one the viewer can't
// open, and it never names the organization.
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { buttonPrimary } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import type { SteeringResult } from "./steering-result";

export function SteeringConnectResult({
  result,
  signOut,
}: {
  result: SteeringResult | null;
  /**
   * The shell's sign-out button. The page passes it in, so this lane never
   * imports the shell. Signing out is how the person reaches the account that
   * can open the organization, so both outcomes offer it beside the way home.
   */
  signOut: ReactNode;
}) {
  const t = useTranslations("onboarding.steeringConnect");
  const home = (
    <SafeLink to={routes.root()} className={buttonPrimary}>
      {t("home")}
    </SafeLink>
  );
  const next = (
    <>
      {home}
      {signOut}
    </>
  );
  if (result === null)
    return (
      <OutcomePanel
        tone="neutral"
        testId="steering-connect-empty"
        title={t("emptyTitle")}
        actions={home}
      >
        <p>{t("emptyBody")}</p>
      </OutcomePanel>
    );
  if (result.kind === "connected")
    return (
      <OutcomePanel
        tone="ok"
        testId="steering-connect-connected"
        title={t("connectedTitle")}
        actions={next}
      >
        <p>{t("connectedBody")}</p>
      </OutcomePanel>
    );
  return (
    <OutcomePanel
      tone="neutral"
      testId="steering-connect-error"
      title={t("errorTitle")}
      actions={next}
    >
      <p>
        {result.code === null
          ? t("errorNoCode")
          : t("error", { code: result.code })}
      </p>
    </OutcomePanel>
  );
}
