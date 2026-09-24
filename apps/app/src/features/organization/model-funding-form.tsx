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
// Remove asks once, in the page, not in a browser `confirm()`: a native
// dialog blocks the tab and cannot be styled or tested.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { ModelCredential, ModelProvider } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { Field, PasswordField } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
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
            // The contract's own refusal: most often an endpoint that is not
            // https or points at a private address.
            return t("invalid");
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
      className="rounded-lg border border-success/45 bg-success/10 px-3 py-2.5 text-sm"
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
  const [balanced, setBalanced] = useState(credential.modelMap.balanced ?? "");
  const [fast, setFast] = useState(credential.modelMap.fast ?? "");
  const [precise, setPrecise] = useState(credential.modelMap.precise ?? "");
  const [busy, setBusy] = useState<Busy>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [verdict, setVerdict] = useState<ModelKeyVerdict | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const input = (): ModelKeyInput => ({
    provider,
    apiKey,
    baseUrl,
    balanced,
    fast,
    precise,
  });

  const fieldError = (field: string) =>
    failure?.reason === "invalid" && failure.field === field
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

  const wholeFormFailure =
    failure && !(failure.reason === "invalid" && failure.field)
      ? failureText(failure)
      : null;

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
        placeholder="sk-or-v1-…"
        autoComplete="off"
        spellCheck={false}
        value={apiKey}
        onChange={(e) => {
          setApiKey(e.target.value);
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
        <summary className="cursor-pointer text-sm font-medium max-md:min-h-11">
          {t("form.vendor")}
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="funding-provider"
              className="text-sm font-medium text-foreground"
            >
              {t("form.provider")}
            </label>
            <select
              id="funding-provider"
              name="provider"
              className={inputBase}
              value={provider}
              onChange={(e) => {
                if (!isModelProvider(e.target.value)) return;
                setProvider(e.target.value);
                setVerdict(null);
                setFailure(null);
              }}
            >
              {MODEL_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {t(`providers.${p}.name`)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
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
              }}
              error={fieldError("baseUrl")}
            />
          ) : null}

          {needsModelMap(provider) ? (
            <fieldset
              className="flex flex-col gap-3"
              data-testid="funding-models"
            >
              <legend className="text-sm font-medium">
                {t("form.models")}
              </legend>
              <Field
                id="funding-balanced"
                name="balanced"
                label={t("tiers.balanced")}
                hint={t("form.balancedHint")}
                value={balanced}
                onChange={(e) => {
                  setBalanced(e.target.value);
                }}
                error={fieldError("balanced")}
              />
              <Field
                id="funding-fast"
                name="fast"
                label={t("tiers.fast")}
                value={fast}
                onChange={(e) => {
                  setFast(e.target.value);
                }}
              />
              <Field
                id="funding-precise"
                name="precise"
                label={t("tiers.precise")}
                value={precise}
                onChange={(e) => {
                  setPrecise(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t("form.unmappedNote")}
              </p>
            </fieldset>
          ) : null}

          {provider === "anthropic" ? (
            <p
              className="text-xs text-muted-foreground"
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
        <p role="status" className="text-sm" data-testid="funding-saved">
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
              <p className="text-sm">{t("remove.confirm")}</p>
              <button
                type="button"
                className={buttonSecondary}
                onClick={onRemove}
                aria-disabled={busy !== "idle" || undefined}
              >
                {busy === "removing" ? t("remove.pending") : t("remove.yes")}
              </button>
              <button
                type="button"
                className={buttonSecondary}
                onClick={() => {
                  setConfirmingRemove(false);
                }}
              >
                {t("remove.cancel")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                setConfirmingRemove(true);
              }}
              data-testid="funding-remove"
            >
              {t("remove.label")}
            </button>
          )
        ) : null}
      </div>
    </form>
  );
}
