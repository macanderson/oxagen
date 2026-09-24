// Spend › Coaching (spec "Coaching"): one change for each agent and each
// operator, derived at read time from the same rollup the Tokens tab prints.
// No contract answers it yet (`list_coaching`, #2962), and the signals it reads
// (tool definition, context frame and steering tokens, retries, prompts per
// session) are not on the rollup either, so the tab names what it will show
// and what is missing rather than inventing an item. Nothing here changes an
// agent by itself.
import { useTranslations } from "next-intl";
import { NotBackedPanel } from "./not-backed";

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

export function CoachingSection() {
  const t = useTranslations("spend.coaching");
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
            <span key={signal} data-signal={signal}>
              {t(`operatorSignals.${signal}`)}
            </span>
          ))}
        </span>
      </span>
    </NotBackedPanel>
  );
}
