"use client";
// End one negotiated rate (`remove_price_entry`, ADR-060 §1).
//
// The word this dialog must not use is "delete". Nothing is deleted: the row
// is closed at this instant and kept, because a cost record priced before it
// names the entry id it was priced with and must still be able to read it.
// What actually changes is forward-looking, and it is not always the same
// change: usually the model and class fall back to the provider's list price,
// but a model this organization negotiated alone has no list or override row
// to fall back to, and the class goes UNPRICED instead.
//
// The handler checks for that fallback BEFORE it closes anything, and
// refuses (`conflict` / `price_entry_close_would_unprice`) rather than close
// first and only say afterward that nothing now prices the class — a run
// that goes unpriced silently is the exact defect this feature exists to
// surface. So the first submit carries no confirmation; a refusal on that
// exact code switches this dialog to a confirm step naming what closing
// anyway means, and only the second submit — the person having read that —
// carries `confirmUnpriced: true`. `fallbackPriced` in a successful response
// still decides which closing screen this dialog shows, for the one case a
// fallback disappeared between the guard's read and the close itself.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { PriceTokenClass } from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { removePriceEntryAction } from "./actions";
import { UNANSWERED, usePriceFailureText } from "./price-dialog";
import type { SpendAt } from "./view";

/** The key the write addresses: the tuple `cost.price_entries` arbitrates on. */
type RemovableEntry = {
  cancellationToken?: string;
  provider: string;
  model: string;
  tokenClass: PriceTokenClass;
  region: string | null;
};

export function RemoveRateDialog({
  at,
  entry,
}: {
  at: SpendAt;
  entry: RemovableEntry;
}) {
  const t = useTranslations("spend.pricing");
  const failureText = usePriceFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set when the handler refused because this class has no fallback price
  // and the caller has not yet said to end the rate anyway. The dialog then
  // shows what closing means instead of a bare error, and the person's next
  // submit carries `confirmUnpriced: true` — the same key exchange as
  // `unpriced` below, just before the close rather than after it.
  const [needsConfirm, setNeedsConfirm] = useState(false);
  // Set only on a successful close whose class has no fallback price. The
  // dialog then stays open with a warning instead of navigating away, so the
  // person sees the class went unpriced rather than discovering it later as
  // a blank cost on a run.
  const [unpriced, setUnpriced] = useState(false);
  const tokenClass = t(`class.${entry.tokenClass}`);

  function finish() {
    setOpen(false);
    navigate.replace(routes.spend(at.org, at.ws, { tab: "pricing" }));
  }

  async function submit(confirmUnpriced: boolean) {
    setAlert(null);
    setPending(true);
    try {
      const result = await removePriceEntryAction(at, {
        ...(entry.cancellationToken === undefined
          ? {}
          : { cancellationToken: entry.cancellationToken }),
        provider: entry.provider,
        model: entry.model,
        tokenClass: entry.tokenClass,
        region: entry.region ?? "",
        ...(confirmUnpriced ? { confirmUnpriced: true } : {}),
      });
      if (result.ok) {
        setNeedsConfirm(false);
        if (
          entry.cancellationToken !== undefined ||
          result.value.fallbackPriced
        ) {
          finish();
          return;
        }
        setUnpriced(true);
        return;
      }
      if (
        !confirmUnpriced &&
        result.reason === "conflict" &&
        result.code === "price_entry_close_would_unprice"
      ) {
        setNeedsConfirm(true);
        return;
      }
      setAlert(failureText(result));
    } catch {
      setAlert(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    await submit(false);
  }

  async function onConfirmUnpriced() {
    if (pending) return;
    await submit(true);
  }

  return (
    <>
      <button
        type="button"
        data-touch-target=""
        data-testid="spend-remove-rate-open"
        aria-label={t("remove.label", {
          model: entry.model,
          class: tokenClass,
        })}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("remove.open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setAlert(null);
            setNeedsConfirm(false);
            setUnpriced(false);
          }
        }}
        title={
          unpriced
            ? t("remove.unpricedTitle")
            : needsConfirm
              ? t("remove.confirmUnpricedTitle")
              : t("remove.title")
        }
        testId="spend-remove-rate-dialog"
      >
        {unpriced ? (
          <div className="flex flex-col gap-3">
            <FormAlert testId="spend-remove-rate-unpriced">
              {t("remove.unpriced", { model: entry.model, class: tokenClass })}
            </FormAlert>
            <button
              type="button"
              data-testid="spend-remove-rate-unpriced-close"
              className={buttonSecondary}
              onClick={finish}
            >
              {t("remove.unpricedClose")}
            </button>
          </div>
        ) : needsConfirm ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onConfirmUnpriced();
            }}
            className="flex flex-col gap-3"
          >
            <FormAlert testId="spend-remove-rate-confirm-unpriced">
              {t("remove.confirmUnpriced", {
                model: entry.model,
                class: tokenClass,
              })}
            </FormAlert>
            {alert === null ? null : (
              <FormAlert testId="spend-remove-rate-failure">{alert}</FormAlert>
            )}
            <div className="flex flex-col gap-2">
              <SubmitButton
                pending={pending}
                label={t("remove.confirmUnpricedSubmit")}
                pendingLabel={t("remove.pending")}
              />
              <button
                type="button"
                data-testid="spend-remove-rate-confirm-unpriced-cancel"
                className={buttonSecondary}
                onClick={() => {
                  setNeedsConfirm(false);
                }}
              >
                {t("remove.confirmUnpricedCancel")}
              </button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              void onSubmit(event);
            }}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-foreground">
              {entry.cancellationToken === undefined
                ? t("remove.body", { model: entry.model, class: tokenClass })
                : t("remove.cancelScheduled")}
            </p>
            {entry.cancellationToken === undefined ? (
              <p className="text-sm text-muted-foreground">
                {t("remove.kept")}
              </p>
            ) : null}
            {alert === null ? null : (
              <FormAlert testId="spend-remove-rate-failure">{alert}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={
                entry.cancellationToken === undefined
                  ? t("remove.submit")
                  : t("remove.cancelScheduledSubmit")
              }
              pendingLabel={t("remove.pending")}
            />
          </form>
        )}
      </SheetDialog>
    </>
  );
}
