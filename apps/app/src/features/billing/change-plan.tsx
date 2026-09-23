"use client";
// Change plan (pages/billing.md, the page's one gold action and the `plan`
// dialog): a Plan select, the design's note, and Change plan in the footer.
// The select offers Build and Scale, each billed monthly or yearly at its
// price, and Enterprise, which is negotiated per organization and so is
// listed but not selectable. Change plan continues to Stripe Checkout through
// `start_subscription_upgrade`, which shows the amount due before anything is
// charged. The dialog says who may change the plan when the viewer may not,
// and says what the product would do for an organization that already has a
// subscription, since swapping a running plan is not wired yet: no control
// here silently does nothing. The plans arrive as props: a contract module
// registers its capability when it loads, so billing.tsx reads them on the
// server and hands them down. Each option's price is text inside an <option>,
// which holds no markup, so it is formatted by formatMoney rather than drawn
// by <Money>.
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import type { Money as MoneyValue } from "@/data/contracts/money";
import { buttonPrimary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { formatMoney } from "@/ui/money-format";
import { SafeForm } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { type PlanChangeState, startPlanChange } from "./actions";

export type PlanOption = {
  slug: string;
  tier: "build" | "scale";
  monthly: MoneyValue;
  annual: MoneyValue;
};

/** Why the form is not offered, when it is not. */
export type PlanChangeBlock =
  | { kind: "role" }
  | {
      kind: "subscribed";
      /** The Stripe plan slug, printed when the tier is not known. */
      plan: string;
      tier: "free" | "build" | "scale" | "enterprise" | null;
    };

type Interval = "month" | "year";

function failureKey(state: PlanChangeState) {
  if (state === null || state.ok) return null;
  switch (state.reason) {
    case "invalid":
      return "errors.invalid";
    case "denied":
      return "errors.denied";
    case "conflict":
      return "errors.conflict";
    default:
      return "errors.unavailable";
  }
}

/** One select value per plan and interval: `<slug>:<interval>`. */
const choiceOf = (slug: string, interval: Interval) => `${slug}:${interval}`;

function PlanForm({
  plans,
  formId,
  state,
  action,
}: {
  plans: readonly PlanOption[];
  formId: string;
  state: PlanChangeState;
  action: (form: FormData) => void;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const first = plans[0];
  const [choice, setChoice] = useState(
    first === undefined ? "" : choiceOf(first.slug, "month"),
  );
  const [slug = "", interval = ""] = choice.split(":");
  const failure = failureKey(state);
  const price = (value: MoneyValue) =>
    formatMoney(value, { locale, precision: "cents" });
  return (
    <SafeForm
      id={formId}
      action={action}
      aria-label={t("changePlan.title")}
      className="flex flex-col gap-3"
    >
      {failure === null ? null : (
        <FormAlert testId="plan-error">{t(`changePlan.${failure}`)}</FormAlert>
      )}
      <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
        {t("changePlan.plan")}
        <select
          value={choice}
          onChange={(event) => {
            setChoice(event.currentTarget.value);
          }}
          className={`${inputBase} w-full text-base font-normal text-foreground md:text-sm`}
        >
          {plans.flatMap((plan) => [
            <option
              key={choiceOf(plan.slug, "month")}
              value={choiceOf(plan.slug, "month")}
            >
              {t("changePlan.perMonth", {
                tier: t(`tiers.${plan.tier}`),
                price: price(plan.monthly),
              })}
            </option>,
            <option
              key={choiceOf(plan.slug, "year")}
              value={choiceOf(plan.slug, "year")}
            >
              {t("changePlan.perYear", {
                tier: t(`tiers.${plan.tier}`),
                price: price(plan.annual),
              })}
            </option>,
          ])}
          <option value="enterprise" disabled>
            {t("changePlan.enterpriseOption")}
          </option>
        </select>
      </label>
      <input type="hidden" name="planSlug" value={slug} />
      <input type="hidden" name="interval" value={interval} />
      <p className="border-l-2 border-gold/60 pl-3 text-[12.5px] text-muted-foreground">
        {t("changePlan.note")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("changePlan.checkout")} {t("changePlan.enterprise")}
      </p>
    </SafeForm>
  );
}

export function ChangePlan({
  org,
  plans,
  blocked,
}: {
  org: string;
  plans: readonly PlanOption[];
  /** Null when the viewer may start a plan change; the handler checks again. */
  blocked: PlanChangeBlock | null;
}) {
  const t = useTranslations("billing.changePlan");
  const tiers = useTranslations("billing.tiers");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<PlanChangeState, FormData>(
    startPlanChange.bind(null, org),
    null,
  );
  const formId = useId();
  return (
    <>
      <button
        type="button"
        data-testid="change-plan"
        data-touch-target=""
        className={buttonPrimary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        testId="plan-dialog"
        closeLabel={blocked === null ? t("cancel") : undefined}
        footer={
          blocked === null ? (
            <SubmitButton
              form={formId}
              pending={pending}
              label={t("submit")}
              pendingLabel={t("submitting")}
              fullWidth={false}
            />
          ) : null
        }
      >
        {blocked === null ? (
          <PlanForm
            plans={plans}
            formId={formId}
            state={state}
            action={action}
          />
        ) : (
          <p data-blocked={blocked.kind} className="text-sm text-foreground">
            {blocked.kind === "role"
              ? t("denied")
              : t("subscribed", {
                  plan:
                    blocked.tier === null ? blocked.plan : tiers(blocked.tier),
                })}
          </p>
        )}
      </SheetDialog>
    </>
  );
}
