"use client";
// Change plan (pages/billing.md, the page's one gold action and the `plan`
// dialog): pick Build or Scale and how it is billed, then continue to Stripe
// Checkout through `start_subscription_upgrade`, which shows the amount due
// before anything is charged. Enterprise is negotiated per contract and is not
// offered. The dialog says who may change the plan when the viewer may not,
// and says what the product would do for an organization that already has a
// subscription, since swapping an existing plan is not wired yet — no control
// here silently does nothing. The plans arrive as props: a contract module
// registers its capability when it loads, so billing.tsx reads them on the
// server and hands them down (as it hands the credit presets down). One of the
// files money renders in (INV-25): each plan's price.
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import type { Money as MoneyValue } from "@/data/contracts/money";
import { buttonPrimary } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeForm } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { type PlanChangeState, startPlanChange } from "./actions";

export type PlanOption = {
  slug: string;
  tier: "build" | "scale";
  monthly: MoneyValue;
  annual: MoneyValue;
  includedGauPerMonth: number;
};

/** Why the form is not offered, when it is not. */
export type PlanChangeBlock =
  | { kind: "role" }
  | { kind: "subscribed"; plan: string };

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

function PlanForm({
  org,
  plans,
}: {
  org: string;
  plans: readonly PlanOption[];
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const [state, action, pending] = useActionState<PlanChangeState, FormData>(
    startPlanChange.bind(null, org),
    null,
  );
  const [billed, setBilled] = useState<"month" | "year">("month");
  const failure = failureKey(state);
  return (
    <SafeForm
      action={action}
      aria-label={t("changePlan.title")}
      className="flex flex-col gap-4"
    >
      {failure === null ? null : (
        <FormAlert testId="plan-error">{t(`changePlan.${failure}`)}</FormAlert>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-1 text-sm font-medium">
          {t("changePlan.plan")}
        </legend>
        {plans.map((plan, i) => (
          <label
            key={plan.slug}
            data-plan={plan.tier}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 has-[:checked]:border-ring"
          >
            <input
              type="radio"
              name="planSlug"
              value={plan.slug}
              defaultChecked={i === 0}
              className="mt-1"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">
                {t(`tiers.${plan.tier}`)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("changePlan.includes", {
                  count: formatCount(plan.includedGauPerMonth, locale),
                })}
              </span>
            </span>
            <span className="text-right text-sm tabular-nums">
              <Money value={billed === "year" ? plan.annual : plan.monthly} />{" "}
              <span className="text-xs text-muted-foreground">
                {billed === "year"
                  ? t("changePlan.perYear")
                  : t("changePlan.perMonth")}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap items-center gap-4 text-sm">
        <legend className="pb-1 text-sm font-medium">
          {t("changePlan.interval")}
        </legend>
        {(["month", "year"] as const).map((value) => (
          <label key={value} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="interval"
              value={value}
              checked={billed === value}
              onChange={() => {
                setBilled(value);
              }}
            />
            {t(`intervals.${value}`)}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        {t("changePlan.enterprise")}
      </p>
      <SubmitButton
        pending={pending}
        label={t("changePlan.submit")}
        pendingLabel={t("changePlan.submitting")}
      />
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
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="change-plan"
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
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t("lede")}</p>
          {blocked === null ? (
            <PlanForm org={org} plans={plans} />
          ) : (
            <p data-blocked={blocked.kind} className="text-sm text-foreground">
              {blocked.kind === "role"
                ? t("denied")
                : t("subscribed", { plan: blocked.plan })}
            </p>
          )}
        </div>
      </SheetDialog>
    </>
  );
}
