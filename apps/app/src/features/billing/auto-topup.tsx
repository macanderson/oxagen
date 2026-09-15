// Auto top-up (§1.4, §3.9 item 8c), prepaid only: whether the recorder charges
// the saved card when the bucket empties, how many blocks, the card it charges
// and how the month's last attempt ended. The toggle and the stepper are
// editable for an Owner or Admin and read-only for everyone else; the write
// lands with set_auto_topup (WL-45). Blocks and GAU counts only (INV-25): the
// block price is on the rate block.
import { useLocale, useTranslations } from "next-intl";
import type { GauBucket } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { inputBase } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { Section, useDate } from "./section";

export function AutoTopup({
  bucket,
  blockSizeGau,
  editable,
}: {
  bucket: Read<GauBucket>;
  /** The rate block's block size; null when the rate could not be read. */
  blockSizeGau: number | null;
  /** Owner and Admin change auto top-up; the handler checks it again. */
  editable: boolean;
}) {
  const t = useTranslations("billing.autoTopup");
  const locale = useLocale();
  const date = useDate();
  if (!bucket.ok || bucket.value.autoTopup === null) return null;
  const { enabled, blocks, paymentMethod, lastAttempt } =
    bucket.value.autoTopup;
  let card: string;
  if (paymentMethod === null) card = t("noCard");
  else if (paymentMethod.brand === null || paymentMethod.last4 === null)
    card = t("savedCardUnlabelled");
  else
    card = t("savedCard", {
      brand: paymentMethod.brand,
      last4: paymentMethod.last4,
    });
  return (
    <Section
      id="billing-auto-topup"
      title={t("title")}
      data-editable={editable}
    >
      <div className="flex items-center gap-2 text-sm">
        <input
          id="auto-topup-enabled"
          type="checkbox"
          role="switch"
          defaultChecked={enabled}
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
          defaultValue={blocks}
          disabled={!editable}
          className={`${inputBase} w-24`}
        />
        {blockSizeGau === null ? null : (
          <span data-per-topup="" className="tabular-nums">
            {t("perTopup", {
              count: formatCount(blocks * blockSizeGau, locale),
            })}
          </span>
        )}
      </div>
      {editable ? null : (
        <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
      )}
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
