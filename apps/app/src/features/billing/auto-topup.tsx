"use client";
// Auto top-up (§1.4, §3.9 item 8c), prepaid only: whether the recorder charges
// the saved card when the bucket empties, how many blocks, the card it charges
// and how the month's last attempt ended. An Owner or Admin changes the toggle
// and the stepper and saves them through set_auto_topup; everyone else sees
// them read-only, and the handler checks the role again. After a save the
// control shows the values as stored. Blocks and GAU counts only (INV-25): the
// block price is on the rate block.
import { useLocale, useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { GauBucket } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { setAutoTopup } from "./actions";
import { Section, useDate } from "./section";

type AutoTopupState = NonNullable<GauBucket["autoTopup"]>;
type Outcome = "saved" | "invalidBlocks" | "denied" | "failed";

export function AutoTopup({
  bucket,
  blockSizeGau,
  editable,
  org,
}: {
  bucket: Read<GauBucket>;
  /** The rate block's block size; null when the rate could not be read. */
  blockSizeGau: number | null;
  /** Owner and Admin change auto top-up; the handler checks it again. */
  editable: boolean;
  /** The organization slug the save resolves its viewer from. */
  org: string;
}) {
  if (!bucket.ok || bucket.value.autoTopup === null) return null;
  return (
    <AutoTopupControl
      state={bucket.value.autoTopup}
      blockSizeGau={blockSizeGau}
      editable={editable}
      org={org}
    />
  );
}

function AutoTopupControl({
  state,
  blockSizeGau,
  editable,
  org,
}: {
  state: AutoTopupState;
  blockSizeGau: number | null;
  editable: boolean;
  org: string;
}) {
  const t = useTranslations("billing.autoTopup");
  const locale = useLocale();
  const date = useDate();
  const [enabled, setEnabled] = useState(state.enabled);
  const [blocks, setBlocks] = useState(state.blocks);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);
  const { paymentMethod, lastAttempt } = state;

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setOutcome(null);
    setPending(true);
    try {
      const result = await setAutoTopup(org, { enabled, blocks });
      if (result.ok) {
        setEnabled(result.value.enabled);
        setBlocks(result.value.blocks);
        setOutcome("saved");
      } else if (result.reason === "invalid") setOutcome("invalidBlocks");
      else if (result.reason === "denied") setOutcome("denied");
      else setOutcome("failed");
    } catch {
      setOutcome("failed");
    } finally {
      setPending(false);
    }
  }

  let card: string;
  if (paymentMethod === null) card = t("noCard");
  else if (paymentMethod.brand === null || paymentMethod.last4 === null)
    card = t("savedCardUnlabelled");
  else
    card = t("savedCard", {
      brand: paymentMethod.brand,
      last4: paymentMethod.last4,
    });
  const invalid = outcome === "invalidBlocks";
  return (
    <Section
      id="billing-auto-topup"
      title={t("title")}
      data-editable={editable}
    >
      <form
        noValidate
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-3"
      >
        {outcome === "denied" || outcome === "failed" ? (
          <FormAlert testId={`auto-topup-${outcome}`}>
            {outcome === "denied" ? t("readOnly") : t("failed")}
          </FormAlert>
        ) : null}
        <div className="flex items-center gap-2 text-sm">
          <input
            id="auto-topup-enabled"
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
            }}
            disabled={!editable}
            className="size-4"
          />
          <label htmlFor="auto-topup-enabled">{t("enabled")}</label>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label htmlFor="auto-topup-blocks">{t("blocks")}</label>
          <input
            id="auto-topup-blocks"
            type="number"
            min={1}
            max={100}
            step={1}
            value={Number.isNaN(blocks) ? "" : blocks}
            onChange={(e) => {
              setBlocks(e.target.valueAsNumber);
            }}
            disabled={!editable}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "auto-topup-blocks-error" : undefined}
            className={`${inputBase} w-24`}
          />
          {blockSizeGau === null || !Number.isInteger(blocks) ? null : (
            <span data-per-topup="" className="tabular-nums">
              {t("perTopup", {
                count: formatCount(blocks * blockSizeGau, locale),
              })}
            </span>
          )}
        </div>
        {invalid ? (
          <p id="auto-topup-blocks-error" className="text-sm text-foreground">
            {t("invalidBlocks")}
          </p>
        ) : null}
        {editable ? (
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton
              pending={pending}
              label={t("save")}
              pendingLabel={t("saving")}
              fullWidth={false}
              secondary
            />
            {outcome === "saved" ? (
              <p role="status" className="text-sm">
                {t("saved")}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
        )}
      </form>
      <p
        data-card={paymentMethod === null ? "none" : "saved"}
        className="text-sm"
      >
        {card}
      </p>
      <p data-attempt={lastAttempt?.status ?? "none"} className="text-sm">
        {lastAttempt === null
          ? t("attempt.none")
          : t(`attempt.${lastAttempt.status}`, { date: date(lastAttempt.at) })}
      </p>
    </Section>
  );
}
