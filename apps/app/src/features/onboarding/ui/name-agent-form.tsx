"use client";
// Register an agent, step 1 (mockup `regName` @ mc-baseline-w1): reserve the key
// and pick the harness and model tier. Continue writes nothing; the choice rides
// in the URL to the wrap step.

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { Field } from "../../auth/ui/field";
import { SubmitButton } from "../../auth/ui/feedback";
import { buttonSecondary, inputBase, panel } from "../../auth/ui/styles";
import Link from "next/link";
import { AgentSlug, agentKey, toSlug } from "../agent-key";
import { registerHref } from "../flow-links";
import { HARNESSES, type Harness, type ModelTier } from "../steps";

export type NameAgentFormProps = {
  org: { slug: string; namespace: string };
  ws: { slug: string; name: string; namespace: string };
  cancelHref: string;
  initial?: { agent: string; harness: Harness; tier: ModelTier } | null;
};

export function NameAgentForm({
  org,
  ws,
  cancelHref,
  initial,
}: NameAgentFormProps) {
  const t = useTranslations("onboarding");
  const router = useRouter();
  const [slug, setSlug] = useState(initial?.agent ?? "");
  const [harness, setHarness] = useState<Harness>(
    initial?.harness ?? "claude-code",
  );
  const [tier, setTier] = useState<ModelTier>(initial?.tier ?? "complex");
  const [error, setError] = useState<string | null>(null);
  const normalized = toSlug(slug);
  const key = agentKey(org.namespace, ws.namespace, normalized || "…");

  function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = AgentSlug.safeParse(normalized);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "agentSlugInvalid");
      return;
    }
    setError(null);
    router.push(
      registerHref(org.slug, ws.slug, "wrap", {
        agent: parsed.data,
        harness,
        tier,
      }),
    );
  }

  return (
    <form
      noValidate
      aria-label={t("name.title")}
      onSubmit={onSubmit}
      className="flex min-w-0 flex-col"
    >
      <div className={`${panel} mt-5 flex flex-col gap-4 p-4 sm:p-5`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="agent-slug"
            name="agent"
            type="text"
            spellCheck={false}
            className="font-mono"
            label={t("name.slug")}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
            }}
            hint={t("name.keyHint", { key })}
            error={error ? t(`errors.${error}`) : undefined}
          />
          <Field
            id="agent-workspace"
            name="workspace"
            type="text"
            readOnly
            label={t("name.workspace")}
            value={ws.name}
            hint={t("name.workspaceHint")}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              htmlFor="agent-harness"
              className="text-sm font-medium text-foreground"
            >
              {t("name.harness")}
            </label>
            <select
              id="agent-harness"
              name="harness"
              aria-describedby="agent-harness-hint"
              className={inputBase}
              value={harness}
              onChange={(e) => {
                setHarness(e.target.value as Harness);
              }}
            >
              {HARNESSES.map((h) => (
                <option key={h} value={h}>
                  {t(`name.harnesses.${h}`)}
                </option>
              ))}
            </select>
            <p
              id="agent-harness-hint"
              className="text-xs text-muted-foreground"
            >
              {t("name.harnessHint")}
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              htmlFor="agent-tier"
              className="text-sm font-medium text-foreground"
            >
              {t("name.tier")}
            </label>
            <select
              id="agent-tier"
              name="tier"
              aria-describedby="agent-tier-hint"
              className={inputBase}
              value={tier}
              onChange={(e) => {
                setTier(e.target.value as ModelTier);
              }}
            >
              <option value="complex">{t("name.tiers.complex")}</option>
              <option value="light">{t("name.tiers.light")}</option>
            </select>
            <p id="agent-tier-hint" className="text-xs text-muted-foreground">
              {t("name.tierHint")}
            </p>
          </div>
        </div>
        <p className="rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-muted-foreground">
          {t("name.note")}
        </p>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Link href={cancelHref} className={buttonSecondary}>
          {t("shell.cancel")}
        </Link>
        <SubmitButton
          pending={false}
          label={t("name.submit")}
          pendingLabel={t("name.submit")}
          fullWidth={false}
          className="sm:ml-auto"
        />
      </div>
    </form>
  );
}
