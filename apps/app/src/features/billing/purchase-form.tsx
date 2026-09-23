"use client";
// Buy governed action units (§1.4, §3.9 item 11), prepaid only: a quantity
// picker in GAUs that steps by the contracted block size, the total at the
// contracted rate, and a button that opens Stripe Checkout through the
// purchase action. The total is mulMicros over the per-GAU rate, shown by the
// one <Money> on the page outside the rate block and the invoices (INV-25);
// the browser's step, min and max validation decides whether a quantity is
// whole blocks within the most one purchase buys. The picker is controlled, so
// the form reset React runs after the action leaves the picker and the total
// on the same quantity. A prepaid organization with no saved card, a Free one
// included, is offered the purchase, because the Checkout saves the card it collects (spec §4.2,
// ADR-055 §6). Owners and billing members buy; anyone else who can read the
// bucket sees who can. An organization billed by invoice does not buy blocks,
// and the panel says so in place of the form (pages/billing.md, Buy governed
// actions). Nothing renders when the bucket or the rate could not be read:
// the page's error state says why.
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import type { ContractRate, GauBucket } from "@/data/contracts/billing";
import { mulMicros } from "@/data/contracts/money";
import type { Read } from "@/data/read";
import { inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeForm } from "@/ui/navigation";
import { type PurchaseState, purchaseGau } from "./actions";
import { Fact, Facts, Section } from "./section";

/** The catalog key for the action's refusal. */
function failureKey(state: PurchaseState) {
  if (state === null || state.ok) return null;
  switch (state.reason) {
    case "invalid":
      return state.code === "quantity_above_max"
        ? "errors.aboveMax"
        : "errors.invalid";
    case "denied":
      return "errors.denied";
    case "conflict":
      return "errors.conflict";
    default:
      return "errors.unavailable";
  }
}

function QuantityPicker({
  org,
  rate,
  maxGau,
  savesCard,
}: {
  org: string;
  rate: ContractRate;
  maxGau: number;
  savesCard: boolean;
}) {
  const t = useTranslations("billing.purchase");
  const locale = useLocale();
  const [text, setText] = useState(String(rate.blockSizeGau));
  const [quantityGau, setQuantityGau] = useState<number | null>(
    rate.blockSizeGau,
  );
  const [state, action, pending] = useActionState<PurchaseState, FormData>(
    purchaseGau.bind(null, org, rate.blockSizeGau),
    null,
  );
  const failure = failureKey(state);
  return (
    <SafeForm
      action={action}
      aria-label={t("title")}
      className="flex flex-col gap-3"
    >
      {failure === null ? null : (
        <FormAlert testId="purchase-error">
          {t(failure, { max: formatCount(maxGau, locale) })}
        </FormAlert>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor="purchase-quantity">{t("quantity")}</label>
        <input
          id="purchase-quantity"
          name="quantityGau"
          type="number"
          required
          min={rate.blockSizeGau}
          max={Math.floor(maxGau / rate.blockSizeGau) * rate.blockSizeGau}
          step={rate.blockSizeGau}
          value={text}
          aria-describedby="purchase-step"
          className={`${inputBase} w-36`}
          onChange={(event) => {
            const input = event.currentTarget;
            setText(input.value);
            setQuantityGau(
              input.validity.valid && Number.isSafeInteger(input.valueAsNumber)
                ? input.valueAsNumber
                : null,
            );
          }}
        />
        <span id="purchase-step" className="text-muted-foreground">
          {t("step", { count: formatCount(rate.blockSizeGau, locale) })}
        </span>
      </div>
      <Facts>
        <Fact name="total" term={t("total")}>
          {quantityGau === null ? (
            t("wholeBlocks")
          ) : (
            <Money value={mulMicros(rate.ratePerGau, quantityGau)} />
          )}
        </Fact>
      </Facts>
      {savesCard ? (
        <p data-saves-card="" className="text-sm">
          {t("savesCard")}
        </p>
      ) : null}
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

export function PurchaseForm({
  org,
  bucket,
  rate,
  maxGau,
  allowed,
}: {
  org: string;
  bucket: Read<GauBucket>;
  rate: Read<ContractRate>;
  /** The most GAU one purchase buys (PURCHASE_GAU_MAX); the action checks it again. */
  maxGau: number;
  /** Owner and Billing buy; the handler checks it again. */
  allowed: boolean;
}) {
  const t = useTranslations("billing.purchase");
  if (!bucket.ok || !rate.ok) return null;
  if (bucket.value.mode === "invoice") {
    return (
      <Section id="billing-buy" title={t("title")} data-state="invoice">
        <p className="text-sm text-muted-foreground">{t("invoiceBilled")}</p>
      </Section>
    );
  }
  return (
    <Section
      id="billing-buy"
      title={t("title")}
      data-state={allowed ? "ok" : "denied"}
    >
      {allowed ? (
        <QuantityPicker
          org={org}
          rate={rate.value}
          maxGau={maxGau}
          savesCard={bucket.value.autoTopup?.paymentMethod === null}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("denied")}</p>
      )}
    </Section>
  );
}
