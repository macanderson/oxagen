"use client";
// The write surface of Organization › Model funding and routes, drawn inside
// the Funding source panel when the source is customer_key (mockup
// `orgKeyPanel`, ADR-053 §2): one password field for the key, Test and save,
// and Remove the key once one is held.
//
// Test and save asks the vendor first and stores the key only when the vendor
// accepted it (and, for an OpenAI-compatible server, its model can call
// tools), so a key that does not work is never saved. The key reaches
// OpenRouter by default. "Another vendor" opens the rest of ADR-053's choices
// (the Vercel AI Gateway, OpenAI, Anthropic, or any OpenAI-compatible server)
// with the URL and models those need; the rules are `model-funding-rules.ts`,
// which mirrors the contract.
//
// The key lives in this component's state until a save succeeds, and is
// cleared then. Nothing sends it back: the save answers with the redacted
// view, and the page never renders the key once submitted.
//
// A model name means something to one vendor only, so the form keeps the
// models typed for each vendor apart, and a switch shows that vendor's own.
// Any edit clears the last test's answer, because that answer was about the
// key, URL and models as they were (#3317).
//
// Remove asks once, in the page, not in a browser `confirm()`: a native
// dialog blocks the tab and cannot be styled or tested.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { ModelCredential, ModelProvider } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { ChoiceGroup } from "@/ui/choice-group";
import { Button } from "@/ui/button";
import { Field, PasswordField } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { ProviderMark } from "@/ui/provider-mark";
import {
  type ModelKeyInput,
  type ModelKeyVerdict,
  removeModelKey,
  saveModelKey,
  testModelKey,
} from "./model-funding-actions";
import {
  isModelProvider,
  MODEL_PROVIDERS,
  needsBaseUrl,
  needsModelMap,
} from "./model-funding-rules";
import { recordReceipt } from "./receipt";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

/** A write that threw before it answered, as the seam would name it. */
const UNANSWERED: Failure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

type Busy = "idle" | "saving" | "removing";

/** The three tiers a direct vendor's key names a model for. */
type Tier = "balanced" | "fast" | "precise";
type TierModels = Readonly<Record<Tier, string>>;
const NO_MODELS: TierModels = { balanced: "", fast: "", precise: "" };

/** The models typed so far, per vendor. */
type ModelDrafts = Partial<Record<ModelProvider, TierModels>>;

/** The stored key's models, as the draft for the stored key's vendor. */
function storedDrafts(credential: ModelCredential): ModelDrafts {
  const drafts: ModelDrafts = {};
  if (credential.provider !== null) {
    drafts[credential.provider] = {
      balanced: credential.modelMap.balanced ?? "",
      fast: credential.modelMap.fast ?? "",
      precise: credential.modelMap.precise ?? "",
    };
  }
  return drafts;
}

type FormField = "apiKey" | "baseUrl" | Tier;

/**
 * The form field each refusal path belongs to. The form's own precheck names
 * a field bare (`balanced`). The contract nests the tiers under `modelMap`,
 * and the verify contract's `toolProbeModel` is the balanced model.
 */
const FIELD_OF_PATH: ReadonlyMap<string, FormField> = new Map<
  string,
  FormField
>([
  ["apiKey", "apiKey"],
  ["baseUrl", "baseUrl"],
  ["balanced", "balanced"],
  ["fast", "fast"],
  ["precise", "precise"],
  ["modelMap.balanced", "balanced"],
  ["modelMap.fast", "fast"],
  ["modelMap.precise", "precise"],
  ["toolProbeModel", "balanced"],
]);

function isTier(field: FormField | undefined): field is Tier {
  return field === "balanced" || field === "fast" || field === "precise";
}

/**
 * The field on screen that shows an invalid refusal, or null when none does:
 * the path names no field, or names one this vendor does not draw. A null
 * here puts the refusal in the whole-form alert, so no refusal goes unshown.
 */
function fieldOf(
  failure: Failure | null,
  provider: ModelProvider,
): FormField | null {
  if (failure?.reason !== "invalid" || failure.field === undefined) return null;
  const field = FIELD_OF_PATH.get(failure.field);
  if (field === undefined) return null;
  if (field === "apiKey") return field;
  if (field === "baseUrl") return needsBaseUrl(provider) ? field : null;
  return needsModelMap(provider) ? field : null;
}

/** The sentence a refused write shows, keyed on the kernel's classification. */
function useFailureText(): (failure: Failure) => string {
  const t = useTranslations("organization.modelFunding.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
        return t("denied");
      case "invalid":
        switch (failure.code) {
          case "key_required":
            return t("keyRequired");
          case "base_url_required":
            return t("baseUrlRequired");
          case "balanced_model_required":
            return t("balancedRequired");
          default:
            // The contract's own refusal. Empty tiers are never sent, so on a
            // model the one rule left to break is the length limit. Anywhere
            // else it is most often an endpoint that is not https or points
            // at a private address.
            return isTier(FIELD_OF_PATH.get(failure.field ?? ""))
              ? t("modelTooLong")
              : t("invalid");
        }
      case "not_found":
      case "conflict":
        return t("refused", { code: failure.code });
      case "pending_approval":
        return t("pendingApproval");
      case "exhausted":
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  };
}

/** The vendor's answer to a test, in words a person can act on. */
function Verdict({
  verdict,
  provider,
}: {
  verdict: ModelKeyVerdict;
  provider: ModelProvider;
}) {
  const t = useTranslations("organization.modelFunding.verdict");
  if (!verdict.ok) {
    return (
      <FormAlert testId="funding-verdict-refused">
        {t("refused", { reason: verdict.error ?? t("noReason") })}
      </FormAlert>
    );
  }
  if (verdict.toolCalling === false) {
    return (
      <FormAlert testId="funding-verdict-no-tools">
        {t("noTools", { reason: verdict.error ?? t("noReason") })}
      </FormAlert>
    );
  }
  return (
    <p
      role="status"
      className="rounded-lg border border-success/45 bg-success/10 px-3 py-2.5 text-base"
      data-testid="funding-verdict-ok"
    >
      {needsBaseUrl(provider) && verdict.toolCalling === true
        ? t("okWithTools", { ms: verdict.latencyMs })
        : t("ok", { ms: verdict.latencyMs })}
    </p>
  );
}

export function ModelFundingForm({
  org,
  credential,
}: {
  org: string;
  credential: ModelCredential;
}) {
  const t = useTranslations("organization.modelFunding");
  const tReceipt = useTranslations("organization.receipts");
  const failureText = useFailureText();
  const navigate = useNavigate();

  const [provider, setProvider] = useState<ModelProvider>(
    credential.provider ?? "openrouter",
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(credential.baseUrl ?? "");
  const [drafts, setDrafts] = useState<ModelDrafts>(() =>
    storedDrafts(credential),
  );
  const [busy, setBusy] = useState<Busy>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [verdict, setVerdict] = useState<ModelKeyVerdict | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Only this vendor's models are drawn and sent.
  const models = drafts[provider] ?? NO_MODELS;

  const input = (): ModelKeyInput => ({
    provider,
    apiKey,
    baseUrl,
    ...models,
  });

  /** An edit makes a new candidate, so the answers about the old one go. */
  const edited = () => {
    setVerdict(null);
    setFailure(null);
  };

  const setModel = (tier: Tier, value: string) => {
    setDrafts((current) => ({
      ...current,
      [provider]: { ...(current[provider] ?? NO_MODELS), [tier]: value },
    }));
    edited();
  };

  const failedField = fieldOf(failure, provider);
  const fieldError = (field: FormField) =>
    failure !== null && failedField === field
      ? failureText(failure)
      : undefined;

  async function run<T>(
    kind: Busy,
    write: () => Promise<ActionResult<T>>,
    onOk: (value: T) => void,
  ) {
    if (busy !== "idle") return;
    setBusy(kind);
    setFailure(null);
    setSaved(false);
    try {
      const result = await write();
      if (result.ok) onOk(result.value);
      else setFailure(result);
    } catch {
      setFailure(UNANSWERED);
    } finally {
      setBusy("idle");
    }
  }

  const onSave = (event: SyntheticEvent) => {
    event.preventDefault();
    const draft = input();
    void run(
      "saving",
      async (): Promise<ActionResult<ModelKeyVerdict | null>> => {
        const tested = await testModelKey(org, draft);
        if (!tested.ok) return tested;
        // The vendor refused, or the model cannot call tools: show why, and
        // store nothing.
        if (!tested.value.ok || tested.value.toolCalling === false)
          return { ok: true, value: tested.value };
        const saved = await saveModelKey(org, draft);
        return saved.ok ? { ok: true, value: null } : saved;
      },
      (refusedVerdict) => {
        if (refusedVerdict !== null) {
          setVerdict(refusedVerdict);
          return;
        }
        // The key has done its job; it does not stay in memory.
        setApiKey("");
        setVerdict(null);
        setSaved(true);
        recordReceipt(tReceipt("modelKeySaved"));
        navigate.refresh();
      },
    );
  };

  const onRemove = () => {
    void run(
      "removing",
      () => removeModelKey(org),
      () => {
        setConfirmingRemove(false);
        setVerdict(null);
        recordReceipt(tReceipt("modelKeyRemoved"));
        navigate.refresh();
      },
    );
  };

  // Every refusal no field on screen shows goes across the whole form.
  const wholeFormFailure =
    failure !== null && failedField === null ? failureText(failure) : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={onSave}
      noValidate
      data-testid="funding-form"
    >
      <PasswordField
        id="funding-key"
        name="apiKey"
        label={t("form.key")}
        hint={t("form.keyHint")}
        placeholder={t("form.keyPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        value={apiKey}
        onChange={(e) => {
          setApiKey(e.target.value);
          edited();
        }}
        error={fieldError("apiKey")}
        showLabel={t("form.show")}
        hideLabel={t("form.hide")}
      />

      <details
        className="rounded-lg border border-border px-3 py-2"
        open={provider !== "openrouter" || undefined}
        data-testid="funding-vendor"
      >
        <summary className="cursor-pointer text-base font-medium max-md:min-h-11">
          {t("form.vendor")}
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          {/* Option cards, not a native select, so each vendor carries its
              mark (#5297). A vendor with no mark keeps its name alone. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-base font-medium text-foreground">
              {t("form.provider")}
            </span>
            <ChoiceGroup
              label={t("form.provider")}
              testId="funding-provider"
              describedBy="funding-provider-hint"
              value={provider}
              options={MODEL_PROVIDERS.map((p) => ({
                value: p,
                label: (
                  <span className="inline-flex items-center gap-2">
                    <ProviderMark provider={p} size={18} />
                    {t(`providers.${p}.name`)}
                  </span>
                ),
              }))}
              onChange={(next) => {
                if (!isModelProvider(next)) return;
                // The new vendor draws its own models, never this one's.
                setProvider(next);
                edited();
              }}
            />
            <p
              id="funding-provider-hint"
              className="text-sm text-muted-foreground"
            >
              {t(`providers.${provider}.hint`)}
            </p>
          </div>

          {needsBaseUrl(provider) ? (
            <Field
              id="funding-base-url"
              name="baseUrl"
              type="url"
              inputMode="url"
              label={t("form.baseUrl")}
              hint={t("form.baseUrlHint")}
              placeholder={t("form.baseUrlPlaceholder")}
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                edited();
              }}
              error={fieldError("baseUrl")}
            />
          ) : null}

          {needsModelMap(provider) ? (
            <fieldset
              className="flex flex-col gap-3"
              data-testid="funding-models"
            >
              <legend className="text-base font-medium">
                {t("form.models")}
              </legend>
              <Field
                id="funding-balanced"
                name="balanced"
                label={t("tiers.balanced")}
                hint={t("form.balancedHint")}
                value={models.balanced}
                onChange={(e) => {
                  setModel("balanced", e.target.value);
                }}
                error={fieldError("balanced")}
              />
              <Field
                id="funding-fast"
                name="fast"
                label={t("tiers.fast")}
                value={models.fast}
                onChange={(e) => {
                  setModel("fast", e.target.value);
                }}
                error={fieldError("fast")}
              />
              <Field
                id="funding-precise"
                name="precise"
                label={t("tiers.precise")}
                value={models.precise}
                onChange={(e) => {
                  setModel("precise", e.target.value);
                }}
                error={fieldError("precise")}
              />
              <p className="text-sm text-muted-foreground">
                {t("form.unmappedNote")}
              </p>
            </fieldset>
          ) : null}

          {provider === "anthropic" ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="funding-anthropic-note"
            >
              {t("providers.anthropic.caching")}
            </p>
          ) : null}
        </div>
      </details>

      {verdict ? <Verdict verdict={verdict} provider={provider} /> : null}
      {wholeFormFailure ? (
        <FormAlert testId="funding-failure">{wholeFormFailure}</FormAlert>
      ) : null}
      {saved ? (
        <p role="status" className="text-base" data-testid="funding-saved">
          {t("form.saved")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton
          pending={busy === "saving"}
          label={t("form.save")}
          pendingLabel={t("form.saving")}
          fullWidth={false}
          // The header's Create a workspace is the screen's one gold action.
          secondary
        />
        {credential.configured ? (
          confirmingRemove ? (
            <div
              className="flex flex-wrap items-center gap-3"
              data-testid="funding-remove-confirm"
            >
              <p className="text-base">{t("remove.confirm")}</p>
              <Button
                type="button"
                variant="outline"
                onClick={onRemove}
                aria-disabled={busy !== "idle" || undefined}
              >
                {busy === "removing" ? t("remove.pending") : t("remove.yes")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setConfirmingRemove(false);
                }}
              >
                {t("remove.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirmingRemove(true);
              }}
              data-testid="funding-remove"
            >
              {t("remove.label")}
            </Button>
          )
        ) : null}
      </div>
    </form>
  );
}
