"use client";
// Set a negotiated rate (Mission Control spec §12.2, ADR-060 §1): the rate
// card a person has in front of them, written into the price book.
//
// The dialog sends every filled class in one call. The store commits the
// complete card or rolls it back.
import { useFormatter, useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { PriceTokenClass } from "@/data/contracts/spend";
import type { ActionResult } from "@/server/kernel";
import { routes } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { setPriceEntryAction } from "./actions";
import {
  type PriceFieldErrors,
  priceFieldErrors,
  PriceEntryForm,
} from "./forms";
import type { SpendAt } from "./view";

type Failure = Exclude<ActionResult<null>, { ok: true }>;

/** Every class the book prices, in the order a rate card reads. */
const ALL_CLASSES: readonly PriceTokenClass[] = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
  "server_tool_request",
  "embedding_input",
  "rerank",
  "image",
  "video_second",
];

/** The fields every class of a card shares, whose refusal is shown once, on the field. */
const SHARED_FIELDS = [
  "provider",
  "model",
  "region",
  "modelAliases",
  "effectiveFrom",
  "tokenClass",
] as const satisfies readonly Exclude<
  keyof PriceFieldErrors,
  "usdPerMillion"
>[];

/** The classes a published rate card almost always names; the rest are one click away. */
const COMMON_CLASSES: readonly PriceTokenClass[] = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "output",
];

// No `region`. `cost.price_entries` keys on it and the column stays, but
// nothing on the pricing path resolves by region — a frame does not record the
// region it was served from and `resolvePriceEntry` never reads
// `PriceEntry.region` — so a regional row would simply be a candidate
// everywhere, competing with the region-agnostic row on effective date alone.
// `set_price_entry` refuses one for that reason, and a field whose only
// outcome is a refusal is a dead affordance. It returns with the resolution.
type Shared = {
  provider: string;
  model: string;
  modelAliases: string;
  effectiveFrom: string;
};

type Rates = Partial<Record<PriceTokenClass, string>>;

/** The classes whose typed rate the form refused, each with its catalog key. */
type RateErrors = Partial<Record<PriceTokenClass, string>>;

/** What the sequence did before it stopped; `written` may be empty. */
type Report = {
  written: readonly PriceTokenClass[];
  notWritten: readonly PriceTokenClass[];
};

type PricePrefill = {
  /** Null where the frames named no vendor, which the person then has to state. */
  provider: string | null;
  model: string;
  /** The classes the book cannot price for this model; shown filled-in-waiting. */
  classes: readonly PriceTokenClass[];
};

/**
 * The sentence a refused write shows. A code with no sentence of its own is
 * printed as recorded rather than collapsed into "something went wrong".
 */
export function usePriceFailureText(): (failure: Failure) => string {
  const t = useTranslations("spend.pricing.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
            return t("orgRoleRequired");
          case "no_principal":
            return t("noPrincipal");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        return t("invalid", { code: failure.code });
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  };
}

export const UNANSWERED: Failure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

export function PriceDialog({
  at,
  prefill,
  compact = false,
}: {
  at: SpendAt;
  /** A model the book cannot price, so the person does not retype it. */
  prefill?: PricePrefill;
  /** The trigger on a table row rather than the panel's own. */
  compact?: boolean;
}) {
  const t = useTranslations("spend.pricing");
  const format = useFormatter();
  const failureText = usePriceFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState<Shared>({
    provider: prefill?.provider ?? "",
    model: prefill?.model ?? "",
    modelAliases: "",
    effectiveFrom: "",
  });
  const [rates, setRates] = useState<Rates>({});
  const [showAll, setShowAll] = useState(false);
  const [errors, setErrors] = useState<PriceFieldErrors>({});
  const [rateErrors, setRateErrors] = useState<RateErrors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [pending, setPending] = useState(false);

  const filled = ALL_CLASSES.filter(
    (tokenClass) => (rates[tokenClass] ?? "").trim().length > 0,
  );
  // A class the person has typed into is always on screen: collapsing the rest
  // must never hide a figure that is about to be sent.
  const opened = prefill?.classes ?? COMMON_CLASSES;
  const shown = showAll
    ? ALL_CLASSES
    : ALL_CLASSES.filter(
        (tokenClass) =>
          opened.includes(tokenClass) || filled.includes(tokenClass),
      );

  const names = (classes: readonly PriceTokenClass[]): string =>
    format.list(classes.map((tokenClass) => t(`class.${tokenClass}`)));

  function reset() {
    setErrors({});
    setRateErrors({});
    setAlert(null);
    setReport(null);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    reset();
    if (filled.length === 0) {
      setAlert(t("dialog.errors.ratesEmpty"));
      return;
    }
    // One request carries every class and one effective instant.
    const effectiveFrom =
      shared.effectiveFrom.trim().length === 0
        ? new Date().toISOString()
        : shared.effectiveFrom;
    // Every class is read into the contract's own input before any of them is
    // sent, so a typo in the fourth rate does not leave the first three
    // written (INV-28: the form refuses before the capability runs).
    const payloads = filled.map((tokenClass) => ({
      ...shared,
      effectiveFrom,
      tokenClass,
      usdPerMillion: rates[tokenClass] ?? "",
    }));
    const fieldErrors: PriceFieldErrors = {};
    const perClass: RateErrors = {};
    for (const [index, payload] of payloads.entries()) {
      const parsed = PriceEntryForm.safeParse(payload);
      if (parsed.success) continue;
      const found = priceFieldErrors(parsed.error.issues);
      const tokenClass = filled[index];
      if (found.usdPerMillion !== undefined && tokenClass !== undefined) {
        perClass[tokenClass] = found.usdPerMillion;
      }
      // Built field by field rather than `Object.assign`-ed: INV-02 refuses a
      // copy into an arbitrary shape, and the shape here is known — every key
      // of `PriceFieldErrors` except the per-class rate, which `perClass`
      // above already carries.
      const { usdPerMillion: _rate, ...rest } = found;
      for (const key of SHARED_FIELDS) {
        const message = rest[key];
        if (message !== undefined) fieldErrors[key] = message;
      }
    }
    if (
      Object.keys(fieldErrors).length > 0 ||
      Object.keys(perClass).length > 0
    ) {
      setErrors(fieldErrors);
      setRateErrors(perClass);
      return;
    }

    setPending(true);
    try {
      const [first, ...additional] = payloads;
      if (!first) return;
      const result = await setPriceEntryAction(at, first, additional);
      if (!result.ok) {
        setReport(
          result.reason === "unavailable"
            ? null
            : { written: [], notWritten: filled },
        );
        setAlert(failureText(result));
        return;
      }
      setOpen(false);
      navigate.replace(routes.spend(at.org, at.ws, { tab: "pricing" }));
    } catch {
      setReport(null);
      setAlert(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const message = (field: keyof PriceFieldErrors) => {
    const key = errors[field];
    return key === undefined ? undefined : t(`dialog.errors.${key}`);
  };

  return (
    <>
      <button
        type="button"
        data-touch-target=""
        data-testid={compact ? "spend-price-row-open" : "spend-price-open"}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {compact ? t("unpriced.setRate") : t("dialog.open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={t("dialog.title")}
        testId="spend-price-dialog"
      >
        <form
          noValidate
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-muted-foreground">{t("dialog.body")}</p>
          {alert === null ? null : (
            <FormAlert testId="spend-price-failure">
              <span className="flex flex-col gap-1">
                <span>{alert}</span>
                {report === null ? null : (
                  <>
                    <span data-testid="spend-price-written">
                      {report.written.length === 0
                        ? t("dialog.partial.noneWritten")
                        : t("dialog.partial.written", {
                            classes: names(report.written),
                          })}
                    </span>
                    <span data-testid="spend-price-not-written">
                      {t("dialog.partial.notWritten", {
                        classes: names(report.notWritten),
                      })}
                    </span>
                  </>
                )}
              </span>
            </FormAlert>
          )}
          <Field
            id="price-provider"
            name="provider"
            label={t("dialog.provider")}
            value={shared.provider}
            error={message("provider")}
            onChange={(event) => {
              setShared((prev) => ({ ...prev, provider: event.target.value }));
            }}
          />
          <Field
            id="price-model"
            name="model"
            label={t("dialog.model")}
            value={shared.model}
            error={message("model")}
            onChange={(event) => {
              setShared((prev) => ({ ...prev, model: event.target.value }));
            }}
          />
          <Field
            id="price-aliases"
            name="modelAliases"
            label={t("dialog.aliases")}
            hint={t("dialog.aliasesHint")}
            value={shared.modelAliases}
            error={message("modelAliases")}
            onChange={(event) => {
              setShared((prev) => ({
                ...prev,
                modelAliases: event.target.value,
              }));
            }}
          />
          <Field
            id="price-effective-from"
            name="effectiveFrom"
            type="date"
            label={t("dialog.effectiveFrom")}
            hint={t("dialog.effectiveFromHint")}
            value={shared.effectiveFrom}
            error={message("effectiveFrom")}
            onChange={(event) => {
              setShared((prev) => ({
                ...prev,
                effectiveFrom: event.target.value,
              }));
            }}
          />
          <fieldset className="flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="text-sm font-medium text-foreground">
              {t("dialog.rates")}
            </legend>
            <p className="text-xs text-muted-foreground">
              {t("dialog.ratesHint")}
            </p>
            {shown.map((tokenClass) => (
              <Field
                key={tokenClass}
                id={`price-rate-${tokenClass}`}
                name={tokenClass}
                inputMode="decimal"
                label={t(`class.${tokenClass}`)}
                value={rates[tokenClass] ?? ""}
                error={
                  rateErrors[tokenClass] === undefined
                    ? undefined
                    : t("dialog.errors.rateInvalid")
                }
                onChange={(event) => {
                  const value = event.target.value;
                  setRates((prev) => ({ ...prev, [tokenClass]: value }));
                }}
              />
            ))}
            {showAll ? null : (
              <button
                type="button"
                data-touch-target=""
                aria-expanded={false}
                className={buttonSecondary}
                onClick={() => {
                  setShowAll(true);
                }}
              >
                {t("dialog.showAllClasses")}
              </button>
            )}
          </fieldset>
          <SubmitButton
            pending={pending}
            label={t("dialog.submit")}
            pendingLabel={t("dialog.pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
