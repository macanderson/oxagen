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
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { buttonPrimary } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import type { SteeringResult } from "./steering-result";

export function SteeringConnectResult({
  result,
}: {
  result: SteeringResult | null;
}) {
  const t = useTranslations("onboarding.steeringConnect");
  const home = (
    <SafeLink to={routes.root()} className={buttonPrimary}>
      {t("home")}
    </SafeLink>
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
        actions={home}
      >
        <p>{t("connectedBody")}</p>
      </OutcomePanel>
    );
  return (
    <OutcomePanel
      tone="neutral"
      testId="steering-connect-error"
      title={t("errorTitle")}
      actions={home}
    >
      <p>
        {result.code === null
          ? t("errorNoCode")
          : t("error", { code: result.code })}
      </p>
    </OutcomePanel>
  );
}
