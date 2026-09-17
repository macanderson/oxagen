// Plan (§1.4): the subscription's plan, status, billing interval and current
// period. An organization with no subscription row sees "No subscription" and
// nothing else; the tier it is on is printed by the rate block.
import { useTranslations } from "next-intl";
import type { PlanCard } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { ReadFailure } from "./read-failure";
import { Fact, Facts, Section, useDate } from "./section";

export function Plan({ plan }: { plan: Read<PlanCard> }) {
  const t = useTranslations("billing");
  const date = useDate();
  const title = t("plan.title");
  if (!plan.ok) {
    return (
      <Section id="billing-plan" title={title}>
        <ReadFailure read={plan} section={title} />
      </Section>
    );
  }
  const { subscription } = plan.value;
  return (
    <Section id="billing-plan" title={title}>
      {subscription === null ? (
        <p className="text-sm text-foreground">{t("plan.none")}</p>
      ) : (
        <Facts>
          <Fact name="plan" term={t("plan.plan")}>
            {subscription.plan}
          </Fact>
          <Fact name="status" term={t("plan.status")}>
            {subscription.status}
          </Fact>
          <Fact name="interval" term={t("plan.interval")}>
            {t(`plan.intervals.${subscription.billingInterval}`)}
          </Fact>
          <Fact name="period" term={t("plan.period")}>
            {t("range", {
              start: date(subscription.currentPeriodStart),
              end: date(subscription.currentPeriodEnd),
            })}
          </Fact>
        </Facts>
      )}
    </Section>
  );
}
