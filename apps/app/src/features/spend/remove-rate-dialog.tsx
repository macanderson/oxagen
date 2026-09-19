"use client";
// End one negotiated rate (`remove_price_entry`, ADR-060 §1).
//
// The word this dialog must not use is "delete". Nothing is deleted: the row
// is closed at this instant and kept, because a cost record priced before it
// names the entry id it was priced with and must still be able to read it.
// What actually changes is forward-looking and is the whole of the
// consequence — from now on this model and class are priced at the provider's
// list price again — so that is what the copy says, and the button says it
// too.
//
// Except when there is no list price underneath. For a custom model, or a
// class no catalog publishes, closing the negotiated row leaves the model
// unpriced, and an unpriced frame records no cost at all rather than a lower
// one. The capability refuses that removal rather than performing it while
// this dialog promises a fallback; the refusal comes back as
// `price_entry_no_fallback`, and the dialog then states what actually happens
// and asks again. The second submit carries the acknowledgement, so the
// person ends the rate knowing the model stops carrying a cost.
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
  // Set by the capability's refusal, never guessed here: the app does not hold
  // the list book, so whether anything prices this model is the price book's
  // answer and not a client-side test.
  const [unpriced, setUnpriced] = useState(false);
  const tokenClass = t(`class.${entry.tokenClass}`);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setAlert(null);
    setPending(true);
    try {
      const result = await removePriceEntryAction(at, {
        provider: entry.provider,
        model: entry.model,
        tokenClass: entry.tokenClass,
        region: entry.region ?? "",
        // Carried only on the second submit, after the refusal has said what
        // ending this rate really does.
        ...(unpriced ? { acknowledgeUnpriced: true } : {}),
      });
      if (result.ok) {
        setOpen(false);
        navigate.replace(routes.spend(at.org, at.ws, { tab: "pricing" }));
        return;
      }
      if (
        result.reason === "conflict" &&
        result.code === "price_entry_no_fallback"
      ) {
        setUnpriced(true);
        setAlert(null);
        return;
      }
      setAlert(failureText(result));
    } catch {
      setAlert(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
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
            setUnpriced(false);
          }
        }}
        title={unpriced ? t("remove.unpricedTitle") : t("remove.title")}
        testId="spend-remove-rate-dialog"
      >
        <form
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-foreground">
            {unpriced
              ? t("remove.unpricedBody", {
                  model: entry.model,
                  class: tokenClass,
                })
              : t("remove.body", { model: entry.model, class: tokenClass })}
          </p>
          <p
            className="text-sm text-muted-foreground"
            data-testid={
              unpriced ? "spend-remove-rate-unpriced" : "spend-remove-rate-kept"
            }
          >
            {unpriced ? t("remove.unpricedCost") : t("remove.kept")}
          </p>
          {alert === null ? null : (
            <FormAlert testId="spend-remove-rate-failure">{alert}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={unpriced ? t("remove.unpricedSubmit") : t("remove.submit")}
            pendingLabel={t("remove.pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
