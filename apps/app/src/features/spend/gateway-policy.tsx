"use client";
// Spend › Budgets › Gateway sessions: the models this workspace permits for a
// wrapped Claude Code or Codex session (`update_tacho_session_policy`,
// ADR-094).
//
// It sits beside the spend ceilings and is deliberately not one of them. Those
// govern Oxagen's own turns, metered as they bill. This one is about somebody's
// laptop, where the enforcer is the daemon on it reading a signed bundle.
//
// Model lists are armed independently of the agent budget on upgraded hosts.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { GatewayPolicy } from "@/data/contracts/spend";
import { Badge } from "@/ui/badge";
import { Money } from "@/ui/money";
import { inputBase } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { setGatewayPolicyAction } from "./actions";
import {
  GatewayPolicyForm,
  type GatewayFieldErrors,
  type GatewayPolicyFormValues,
  gatewayFieldErrors,
} from "./forms";
import { Panel } from "./tables";
import type { GatewayReach, SpendAt } from "./view";

/** The saved policy as the dialog's fields, so Save with no edits is a no-op. */
function valuesOf(policy: GatewayPolicy): GatewayPolicyFormValues {
  return {
    mode: policy.mode,
    sessionLimit:
      policy.sessionLimitUsd === null ? "" : String(policy.sessionLimitUsd),
    ...(policy.modelAllow?.length === 0 ? { permitNoModels: true } : {}),
    modelAllow: (policy.modelAllow ?? []).join("\n"),
    modelDeny: policy.modelDeny.join("\n"),
  };
}

function ModelList({
  id,
  label,
  hint,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const hintId = `${id}-hint`;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <textarea
        id={id}
        name={id}
        rows={3}
        value={value}
        aria-describedby={[errorId, hintId].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={`${inputBase} font-mono`}
      />
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

export function GatewayPolicySection({
  at,
  policy,
  canEdit,
}: {
  at: SpendAt;
  policy: GatewayPolicy;
  /** Owners and admins write; the handler checks the role again. */
  canEdit: boolean;
}) {
  const t = useTranslations("spend.gateway");
  const [values, setValues] = useState<GatewayPolicyFormValues>(() =>
    valuesOf(policy),
  );
  const [saved, setSaved] = useState<GatewayPolicy>(policy);
  const [reach, setReach] = useState<GatewayReach | null>(null);
  const [errors, setErrors] = useState<GatewayFieldErrors>({});
  const [alert, setAlert] = useState<"denied" | "failed" | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setAlert(null);
    const parsed = GatewayPolicyForm.safeParse(values);
    if (!parsed.success) {
      setErrors(gatewayFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await setGatewayPolicyAction(at, values);
      if (result.ok) {
        setSaved({
          ...parsed.data,
          sessionLimit:
            parsed.data.sessionLimitUsd === null
              ? null
              : {
                  micros: String(
                    Math.round(parsed.data.sessionLimitUsd * 1_000_000),
                  ),
                  currency: "USD",
                },
        });
        setReach(result.value);
        return;
      }
      const fields =
        result.reason === "invalid"
          ? gatewayFieldErrors([{ path: (result.field ?? "").split(".") }])
          : {};
      setErrors(fields);
      if (Object.keys(fields).length === 0)
        setAlert(result.reason === "denied" ? "denied" : "failed");
    } catch {
      setAlert("failed");
    } finally {
      setPending(false);
    }
  }

  const message = (field: keyof GatewayFieldErrors) => {
    const key = errors[field];
    return key ? t(`errors.${key}`) : undefined;
  };

  return (
    <Panel
      id="spend-gateway"
      title={t("title")}
      note={t("note")}
      action={
        <Badge tone="quiet" data-mode={saved.mode}>
          {saved.mode === "enforced"
            ? t("enforcementRequested")
            : t("notApplied")}
        </Badge>
      }
      footer={
        reach === null ? (
          saved.mode === "enforced" ? (
            <p className="text-xs">{t("reach.unknown")}</p>
          ) : null
        ) : (
          <p data-testid="gateway-reach" className="text-xs">
            {reach.hosts === 0
              ? t("reach.none")
              : t("reach.stored", {
                  hosts: reach.hosts,
                  capable: reach.hostsEnforcingModels,
                })}
          </p>
        )
      }
    >
      {canEdit ? (
        <form
          noValidate
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-3 px-4 py-3.5"
        >
          {alert ? <FormAlert>{t(`alert.${alert}`)}</FormAlert> : null}
          <label htmlFor="gateway-mode" className="text-sm font-medium">
            {t("mode")}
          </label>
          <select
            id="gateway-mode"
            aria-invalid={errors.mode ? true : undefined}
            aria-describedby={errors.mode ? "gateway-mode-error" : undefined}
            className={inputBase}
            value={values.mode}
            onChange={(event) => {
              setValues((prev) => ({
                ...prev,
                mode:
                  event.target.value === "enforced" ? "enforced" : "observed",
              }));
            }}
          >
            <option value="observed">{t("notApplied")}</option>
            <option value="enforced">{t("enforced")}</option>
          </select>
          {errors.mode ? (
            <p
              id="gateway-mode-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {message("mode")}
            </p>
          ) : null}
          <Field
            id="gateway-session-limit"
            name="sessionLimit"
            label={t("sessionLimit")}
            hint={t("sessionLimitHint")}
            inputMode="decimal"
            value={values.sessionLimit}
            error={message("sessionLimit")}
            onChange={(event) => {
              setValues((prev) => ({
                ...prev,
                sessionLimit: event.target.value,
              }));
            }}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={values.permitNoModels ?? false}
              onChange={(event) => {
                setValues((prev) => ({
                  ...prev,
                  permitNoModels: event.target.checked,
                }));
              }}
            />
            {t("permitNoModels")}
          </label>
          <ModelList
            id="gateway-model-allow"
            label={t("modelAllow")}
            hint={t("modelAllowHint")}
            value={values.modelAllow}
            error={message("modelAllow")}
            onChange={(modelAllow) => {
              setValues((prev) => ({ ...prev, modelAllow }));
            }}
          />
          <ModelList
            id="gateway-model-deny"
            label={t("modelDeny")}
            hint={t("modelDenyHint")}
            value={values.modelDeny}
            error={message("modelDeny")}
            onChange={(modelDeny) => {
              setValues((prev) => ({ ...prev, modelDeny }));
            }}
          />
          <SubmitButton
            pending={pending}
            label={t("submit")}
            pendingLabel={t("pending")}
          />
        </form>
      ) : (
        <div className="flex flex-col gap-2 px-4 py-3.5 text-sm">
          <p className="text-muted-foreground">{t("readOnly")}</p>
          <p>
            {saved.sessionLimit === null ? (
              t("noLimit")
            ) : (
              <>
                {t("limitLabel")} <Money value={saved.sessionLimit} />
              </>
            )}
          </p>
          <p>
            {saved.modelAllow === null
              ? t("noAllowlist")
              : saved.modelAllow.length === 0
                ? t("permitNoModels")
                : t("allowlist", { models: saved.modelAllow.join(", ") })}
          </p>
          {saved.modelDeny.length > 0 ? (
            <p>{t("denylist", { models: saved.modelDeny.join(", ") })}</p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
