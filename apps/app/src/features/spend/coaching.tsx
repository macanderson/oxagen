// Spend › Coaching (spec "Coaching"): one change for each agent and each
// operator, derived at read time from the same rollup the Tokens tab prints.
// No contract answers it yet (`list_coaching`, #2962), and the signals it reads
// (tool definition, context frame and steering tokens, retries, prompts per
// session) are not on the rollup either, so the tab names what it will show
// and what is missing rather than inventing an item. Each operator signal
// links to the operator ranking on the By operator tab (D15), where a manager
// sees whose unproductive spend it would move. Nothing here changes an agent
// by itself.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { NotBackedPanel } from "./not-backed";
import type { SpendAt } from "./view";

const AGENT_SIGNALS = [
  "narrowBelt",
  "stablePrefix",
  "pageResults",
  "contextBudget",
  "lightModel",
  "retryStorms",
  "oneTurnCache",
] as const;

const OPERATOR_SIGNALS = [
  "grants",
  "reRead",
  "onePrompt",
  "publishSteering",
  "resizeBudget",
  "selfReported",
] as const;

export function CoachingSection({ at }: { at: SpendAt }) {
  const t = useTranslations("spend.coaching");
  const ranking = routes.spend(at.org, at.ws, { tab: "operator" });
  return (
    <NotBackedPanel id="spend-coaching" title={t("title")} gap="rollup">
      {t("notBacked")}
      <span className="mt-3 grid gap-4 sm:grid-cols-2">
        <span className="flex flex-col gap-1">
          <span className="font-medium text-foreground">{t("agents")}</span>
          {AGENT_SIGNALS.map((signal) => (
            <span key={signal} data-signal={signal}>
              {t(`agentSignals.${signal}`)}
            </span>
          ))}
        </span>
        <span className="flex flex-col gap-1">
          <span className="font-medium text-foreground">{t("operators")}</span>
          {OPERATOR_SIGNALS.map((signal) => (
            <SafeLink
              key={signal}
              to={ranking}
              data-signal={signal}
              className={linkText}
            >
              {t(`operatorSignals.${signal}`)}
            </SafeLink>
          ))}
        </span>
      </span>
    </NotBackedPanel>
  );
}
