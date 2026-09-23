"use client";
// Token balance (§1.4's In-app AI usage row, §3.9 "the second meter"): the
// prepaid balance that pays for the tokens Oxagen buys for the in-app agent,
// and the top-up that adds to it. The price list names this line "Tokens
// Oxagen buys for you": at cost, with no markup since the 2026-09-18
// amendment (packages/billing/src/metering.ts), and capped by the balance. It
// is metered apart from governed actions, so it renders in both billing modes.
//
// The balance is printed at face value through <Money>. At zero or less the
// section says the agent's turns on Oxagen's model key stop until a top-up
// lands. No token count and no per-call cost appears here (§1.4).
//
// Owners and billing members top up; anyone else who can read the balance sees
// who can. A Free organization cannot top up at any role — the checkout
// refuses it — so it is shown the subscription it needs first rather than a
// form whose every submission would fail. The presets and the minimum arrive
// as props. They are the
// CREDIT_PACKS prices carried on the purchase contract, which billing.tsx
// reads on the server and hands down, the way it hands the GAU purchase form
// its maximum: a contract module registers its capability when it loads, so
// reading one here would put the capability registry in the client bundle.
// packages/billing's pricing.test.ts keeps the contract's list equal to
// CREDIT_PACKS.
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import type { UsageCredits } from "@/data/contracts/billing";
import type { Money as MoneyValue } from "@/data/contracts/money";
import { mulMicros } from "@/data/contracts/money";
import type { Read } from "@/data/read";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeForm } from "@/ui/navigation";
import { type CreditTopupState, purchaseCredits } from "./actions";
import { BillingReadFailure } from "./read-failure";
import { Fact, Facts, Section } from "./section";

/** One dollar in micros; a preset's face value is that times its dollars (INV-09). */
const ONE_DOLLAR: MoneyValue = { micros: "1000000", currency: "USD" };

/** The catalog key for the action's refusal. */
function failureKey(state: CreditTopupState) {
  if (state === null || state.ok) return null;
  switch (state.reason) {
    case "invalid":
      return "errors.invalid";
    case "denied":
      return "errors.denied";
    default:
      return "errors.unavailable";
  }
}

function TopUpForm({
  org,
  presetsUsd,
  minUsd,
}: {
  org: string;
  presetsUsd: readonly number[];
  minUsd: number;
}) {
  const t = useTranslations("billing.usageCredits");
  const locale = useLocale();
  const [text, setText] = useState(String(presetsUsd[0] ?? minUsd));
  const [state, action, pending] = useActionState<CreditTopupState, FormData>(
    purchaseCredits.bind(null, org),
    null,
  );
  const failure = failureKey(state);
  const min = formatCount(minUsd, locale);
  return (
    <SafeForm action={action} className="flex flex-col gap-3">
      {failure === null ? null : (
        <FormAlert testId="credits-error">{t(failure, { min })}</FormAlert>
      )}
      <div
        role="group"
        aria-label={t("presets")}
        className="flex flex-wrap items-center gap-2"
      >
        {presetsUsd.map((preset) => (
          <button
            key={preset}
            type="button"
            data-preset={preset}
            className={buttonSecondary}
            onClick={() => {
              setText(String(preset));
            }}
          >
            <Money value={mulMicros(ONE_DOLLAR, preset)} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor="credits-amount">{t("amount")}</label>
        <input
          id="credits-amount"
          name="amountUsd"
          type="number"
          required
          min={minUsd}
          step={1}
          value={text}
          aria-describedby="credits-min"
          className={`${inputBase} w-36`}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
        />
        <span id="credits-min" className="text-muted-foreground">
          {t("min", { min })}
        </span>
      </div>
      <SubmitButton
        pending={pending}
        label={t("submit")}
        pendingLabel={t("submitting")}
        fullWidth={false}
        secondary
        className="self-start"
      />
    </SafeForm>
  );
}

/**
 * Whether this viewer is offered the top-up, and when not, what refused it:
 * `role` for a viewer who is neither an owner nor a billing member, `plan` for
 * a Free organization, whose checkout is refused whatever the role.
 */
export type TopUpState = "ok" | "role" | "plan";

export function UsageCreditsSection({
  org,
  credits,
  topUp,
  presetsUsd,
  minUsd,
}: {
  org: string;
  credits: Read<UsageCredits>;
  /** Owner and Billing on a paid plan top up; the handler checks both again. */
  topUp: TopUpState;
  /** The CREDIT_PACKS prices, in whole dollars of face value. */
  presetsUsd: readonly number[];
  /** The smallest top-up the contract accepts, in whole dollars. */
  minUsd: number;
}) {
  const t = useTranslations("billing.usageCredits");
  const title = t("title");
  if (!credits.ok) {
    return (
      <Section id="billing-usage-credits" title={title}>
        <BillingReadFailure read={credits} section={title} />
      </Section>
    );
  }
  const c = credits.value;
  return (
    <Section
      id="billing-usage-credits"
      title={title}
      data-state={topUp === "ok" ? "ok" : topUp === "plan" ? "plan" : "denied"}
    >
      <Facts>
        <Fact name="balance" term={t("balance")}>
          <Money value={c.balance} />
        </Fact>
      </Facts>
      <p data-basis="" className="max-w-prose text-sm text-muted-foreground">
        {t("basis")}
      </p>
      {c.balanceCredits <= 0 ? (
        <p data-exhausted="" className="text-sm font-medium text-foreground">
          {t("exhausted")}
        </p>
      ) : null}
      {topUp === "ok" ? (
        <TopUpForm org={org} presetsUsd={presetsUsd} minUsd={minUsd} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(topUp === "plan" ? "planDenied" : "denied")}
        </p>
      )}
    </Section>
  );
}
