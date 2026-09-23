"use client";
// Step 1 of Register an agent: reserve the slug, name the identity and pick the
// harness that decides how it is wrapped. `register_agent` mints the identity,
// its delegated principal and one long-lived credential, which is shown here
// once and is never recoverable.
import { HarnessIcon } from "@/ui/harness-icon";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary, mono } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert, OutcomePanel, SubmitButton } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import {
  AgentForm as Schema,
  type AgentField,
  type AgentFormErrorKey,
  type AgentFormValues,
  HARNESSES,
  agentFieldErrors,
} from "../agent-form";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import { registerAgent } from "../actions";
import { useFormatter } from "@/ui/formatter";

type FieldErrors = Partial<Record<AgentField, AgentFormErrorKey>>;
type Registered = {
  name: string;
  secret: string;
  expiresAt: string;
  to: SafePath;
};

export function RegisterAgentForm({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("onboarding");
  const harnessLabel = useTranslations("agents.harness");
  const format = useFormatter();
  const failureText = useOnboardingFailure();
  const [values, setValues] = useState<AgentFormValues>({
    slug: "",
    name: "",
    description: "",
    harness: "claude-code",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<Registered | null>(null);

  function update(field: AgentField, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    const parsed = Schema.safeParse(values);
    if (!parsed.success) {
      setErrors(agentFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await registerAgent(org, ws, values);
      if (result.ok) {
        setDone({
          name: values.name.trim(),
          secret: result.value.secret,
          expiresAt: result.value.expiresAt,
          to: result.value.to,
        });
        return;
      }
      if (result.reason === "invalid" && result.field !== undefined) {
        setErrors(
          agentFieldErrors([{ path: [result.field], message: result.code }]),
        );
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  if (done !== null) {
    return (
      <OutcomePanel
        tone="ok"
        testId="agent-registered"
        title={t("register.name.registered.title", { name: done.name })}
        actions={
          <SafeLink to={done.to} className={buttonPrimary}>
            {t("register.name.registered.continue")}
          </SafeLink>
        }
      >
        <p>{t("register.name.registered.body")}</p>
        <code
          data-testid="agent-credential"
          className={`${mono} mt-2 block break-all rounded-md bg-muted px-2 py-1`}
        >
          {done.secret}
        </code>
        <p className="pt-2 text-xs">
          {t("register.name.registered.expires", {
            at: format.dateTime(new Date(done.expiresAt), {
              dateStyle: "medium",
            }),
          })}
        </p>
      </OutcomePanel>
    );
  }

  const message = (field: AgentField) => {
    const key = errors[field];
    return key ? t(`errors.${key}`) : undefined;
  };
  const bind = (field: AgentField) => ({
    name: field,
    value: values[field],
    onChange: (e: { target: { value: string } }) => {
      update(field, e.target.value);
    },
    error: message(field),
  });

  return (
    <form
      noValidate
      aria-label={t("register.name.title")}
      onSubmit={(e) => void onSubmit(e)}
      className="flex min-w-0 flex-col gap-4"
    >
      {failure === null ? null : (
        <FormAlert testId="register-failure">{failure}</FormAlert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="agent-slug"
          type="text"
          spellCheck={false}
          className="font-mono"
          label={t("register.name.slug")}
          hint={t("register.name.slugHint", { slug: values.slug || "…" })}
          {...bind("slug")}
        />
        <Field
          id="agent-name"
          type="text"
          label={t("register.name.agentName")}
          hint={t("register.name.agentNameHint")}
          {...bind("name")}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor="agent-harness"
          className="text-sm font-medium text-foreground"
        >
          {t("register.name.harness")}
        </label>
        <div className="flex items-center gap-2">
          <HarnessIcon harness={values.harness} />
          <select
            id="agent-harness"
            name="harness"
            value={values.harness}
            onChange={(e) => {
              update("harness", e.target.value);
            }}
            aria-describedby="agent-harness-hint"
            className="block w-full min-w-0 rounded-md border border-input-border bg-input-bg px-3 py-2.5 text-sm text-input-fg"
          >
            {HARNESSES.map((harness) => (
              <option key={harness} value={harness}>
                {harnessLabel(harness)}
              </option>
            ))}
          </select>
        </div>
        <p id="agent-harness-hint" className="text-xs text-muted-foreground">
          {t("register.name.harnessHint")}
        </p>
      </div>
      <Field
        id="agent-description"
        type="text"
        label={t("register.name.description")}
        hint={t("register.name.descriptionHint")}
        {...bind("description")}
      />
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("register.name.note")}
      </p>
      <div className="flex justify-end">
        <SubmitButton
          pending={pending}
          label={t("register.name.submit")}
          pendingLabel={t("register.name.pending")}
          fullWidth={false}
        />
      </div>
    </form>
  );
}
