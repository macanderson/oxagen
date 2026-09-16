"use client";
// In-app AI usage (§1.4's In-app AI usage row, §3.9 "the second meter"): the
// usage credit balance that pays for the in-app agent's model calls, and the
// top-up that buys more. Credits are the second meter and are metered apart
// from governed action units, so this section renders in both billing modes.
//
// The balance is printed in credits through formatCount and at face value
// through <Money>; one credit is $0.01. At a balance of zero or less the
// section says the agent's platform-paid turns stop until a top-up lands. No
// token count and no per-call cost appears here (§1.4).
//
// Owners and billing members top up; anyone else who can read the balance sees
// who can. The presets are the CREDIT_PACKS prices, carried on the contract
// because the app may import a contract module and nothing else from the
// platform; packages/billing's pricing.test.ts keeps them equal.
import {
  CREDIT_TOPUP_PRESETS_USD,
  MIN_CREDIT_TOPUP_USD,
} from "@oxagen/oxagen/contracts/billing.credits.purchase";
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
import { ReadFailure } from "./read-failure";
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

function TopUpForm({ org }: { org: string }) {
  const t = useTranslations("billing.usageCredits");
  const locale = useLocale();
  const [text, setText] = useState(
    String(CREDIT_TOPUP_PRESETS_USD[0] ?? MIN_CREDIT_TOPUP_USD),
  );
  const [state, action, pending] = useActionState<CreditTopupState, FormData>(
    purchaseCredits.bind(null, org),
    null,
  );
  const failure = failureKey(state);
  const min = formatCount(MIN_CREDIT_TOPUP_USD, locale);
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
        {CREDIT_TOPUP_PRESETS_USD.map((preset) => (
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
          min={MIN_CREDIT_TOPUP_USD}
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
        className="self-start"
      />
    </SafeForm>
  );
}

export function UsageCreditsSection({
  org,
  credits,
  allowed,
}: {
  org: string;
  credits: Read<UsageCredits>;
  /** Owner and Billing top up; the handler checks it again. */
  allowed: boolean;
}) {
  const t = useTranslations("billing.usageCredits");
  const locale = useLocale();
  const title = t("title");
  if (!credits.ok) {
    return (
      <Section id="billing-usage-credits" title={title}>
        <ReadFailure read={credits} section={title} />
      </Section>
    );
  }
  const c = credits.value;
  return (
    <Section
      id="billing-usage-credits"
      title={title}
      data-state={allowed ? "ok" : "denied"}
    >
      <Facts>
        <Fact name="balance" term={t("balance")}>
          {t("credits", { count: formatCount(c.balanceCredits, locale) })}
        </Fact>
        <Fact name="face-value" term={t("faceValue")}>
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
      {allowed ? (
        <TopUpForm org={org} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("denied")}</p>
      )}
    </Section>
  );
}
