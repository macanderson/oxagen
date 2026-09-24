"use client";
// The write surface of Organization › Model funding and routes, drawn inside
// the Funding source panel when the source is customer_key: choose a vendor,
// paste a key, test it, save it, or remove the one stored (ADR-053 §2).
//
// The fields follow the vendor. OpenRouter and the Vercel AI Gateway take a
// key and nothing else — one key reaches every model and understands Oxagen's
// model names. OpenAI and Anthropic take a key and the model to use for the
// balanced tier. Any other OpenAI-compatible server also takes its URL. The
// rules are `model-funding-rules.ts`, which mirrors the contract.
//
// The key lives in this component's state until a save succeeds, and is
// cleared then. Nothing sends it back: the save answers with the redacted
// view, and the page never renders the key once submitted.
//
// Remove asks once, in the page, not in a browser `confirm()` — a native
// dialog blocks the tab and cannot be styled or tested.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { ModelCredential, ModelProvider } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
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

type Busy = "idle" | "testing" | "saving" | "removing";

type ModelTier = keyof ModelCredential["modelMap"];

/** Display order of the per-tier models; balanced first because it is the one that is required. */
const MODEL_TIERS: readonly ModelTier[] = ["balanced", "fast", "precise"];

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

/** What the stored key is, in words. Never the key itself. */
function Current({ credential }: { credential: ModelCredential }) {
  const t = useTranslations("organization.modelFunding");
  if (!credential.configured || credential.provider === null) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="funding-none">
        {t("current.none")}
      </p>
    );
  }
  const models = MODEL_TIERS.flatMap((tier) => {
    const id = credential.modelMap[tier];
    return id ? [{ tier, id }] : [];
  });
  return (
    <dl
      className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm"
      data-testid="funding-current"
    >
      <dt className="text-muted-foreground">{t("current.provider")}</dt>
      <dd>{t(`providers.${credential.provider}.name`)}</dd>
      <dt className="text-muted-foreground">{t("current.key")}</dt>
      <dd className={mono}>
        {t("current.keyEnding", { hint: credential.keyHint ?? "" })}
      </dd>
      {credential.baseUrl ? (
        <>
          <dt className="text-muted-foreground">{t("current.endpoint")}</dt>
          <dd className={`${mono} break-all`}>{credential.baseUrl}</dd>
        </>
      ) : null}
      {models.map(({ tier, id }) => (
        <FragmentRow key={tier} label={t(`tiers.${tier}`)} value={id} />
      ))}
      <dt className="text-muted-foreground">{t("current.status")}</dt>
      <dd>
        {credential.status === "active"
          ? t("current.active")
          : t("current.disabled")}
      </dd>
      <dt className="text-muted-foreground">{t("current.tested")}</dt>
      <dd>
        {credential.lastVerifiedAt
          ? t("current.at", { when: new Date(credential.lastVerifiedAt) })
          : t("current.never")}
      </dd>
    </dl>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono}>{value}</dd>
    </>
  );
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

  const onTest = () => {
    void run("testing", () => testModelKey(org, input()), setVerdict);
  };

  const onSave = (event: SyntheticEvent) => {
    event.preventDefault();
    void run(
      "saving",
      () => saveModelKey(org, input()),
      () => {
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
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t("current.title")}</h3>
        <Current credential={credential} />
        <p className="text-sm text-muted-foreground">
          {credential.configured ? t("explain.byok") : t("explain.platform")}
        </p>
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
            <div>
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
            </div>
          )
        ) : null}
      </section>

      <form
        className="flex flex-col gap-4 border-t border-border pt-4"
        onSubmit={onSave}
        noValidate
        data-testid="funding-form"
      >
        <h3 className="text-sm font-semibold">
          {credential.configured ? t("form.replaceTitle") : t("form.title")}
        </h3>

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

        <PasswordField
          id="funding-key"
          name="apiKey"
          label={t("form.key")}
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
            <legend className="text-sm font-medium">{t("form.models")}</legend>
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

        {verdict ? <Verdict verdict={verdict} provider={provider} /> : null}
        {wholeFormFailure ? (
          <FormAlert testId="funding-failure">{wholeFormFailure}</FormAlert>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm" data-testid="funding-saved">
            {t("form.saved")}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonSecondary}
            onClick={onTest}
            aria-disabled={busy !== "idle" || undefined}
            data-testid="funding-test"
          >
            {busy === "testing" ? t("form.testing") : t("form.test")}
          </button>
          <SubmitButton
            pending={busy === "saving"}
            label={t("form.save")}
            pendingLabel={t("form.saving")}
            fullWidth={false}
          />
        </div>
      </form>
    </div>
  );
}
