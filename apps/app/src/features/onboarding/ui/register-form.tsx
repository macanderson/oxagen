"use client";
// Step 1 of Register an agent (ADR-192): define the agent. An agent is one
// operator on one runtime with one harness, carrying a toolbelt, so the step
// asks for its name and slug, its harness and runtime, and its toolbelt, then
// reserves the key with one write, `register_agent`.
//
// - The slug fills from the name (`agentSlugFromName`) until the person edits
//   it. The key in the hint and in the note rewrites on every keystroke from
//   the namespaces the workspace read carries, so it is the key the write will
//   mint, not a guess.
// - A runtime and harness pair a live agent already holds cannot be taken
//   twice. Whichever side is chosen first, the other picker keeps the taken
//   option visible, disabled, with a popover naming the agent that holds it.
// - When the workspace has no tool yet, the Toolbelt section is already done:
//   it says the agent carries the All tools belt, why there is nothing to
//   choose, and links to the page that imports MCP servers.
//
// The credential the write returns is not shown here; the SDK path on the wrap
// step issues its own, so no secret sits on a screen the operator may walk
// away from. An agent already reserved (the operator came back with Back or the
// rail) is shown read-only, and Continue only moves on, because the key is
// immutable.
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useId, useState } from "react";
import type { RuntimeRef, ToolbeltRef } from "@/data/contracts/agents";
import type { NamedRuntimeList } from "@/data/contracts/runtimes";
import type { ToolbeltList } from "@/data/contracts/toolbelts";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { ChoiceGroup } from "@/ui/choice-group";
import {
  buttonPrimary,
  inputBase,
  kvTerm,
  kvValue,
  linkText,
  mono,
  panel,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { registerAgent } from "../actions";
import {
  AGENT_SLUG_MAX,
  AgentForm as Schema,
  type AgentField,
  type AgentFormErrorKey,
  agentFieldErrors,
  agentKeyOf,
  agentSlugFromName,
  HARNESSES,
  type Harness,
  holderOf,
} from "../agent-form";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import type { RegisterPlace } from "../register-actions";
import { CancelRegistration } from "./cancel-registration";

/** An input at 16px on a phone, so iOS does not zoom on focus. */
const control = `${inputBase} min-h-10 max-md:min-h-11 max-md:text-base`;
const label = "text-[12.5px] font-semibold text-foreground";
const hint = "text-xs text-muted-foreground";
const sectionTitle = "text-[13.5px] font-semibold text-foreground";

export type ReservedAgent = {
  id: string;
  name: string;
  slug: string;
  harness: Harness;
  runtime: RuntimeRef | null;
  toolbelt: ToolbeltRef | null;
};

/** A field's error: a catalog key, or a sentence the step wrote from a refusal. */
type FieldErrors = Partial<Record<AgentField, AgentFormErrorKey | "taken">>;

function SectionHead({ title, done }: { title: string; done?: string }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className={sectionTitle}>{title}</h2>
      {done === undefined ? null : (
        <span
          data-testid="register-toolbelt-done"
          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <Check aria-hidden className="size-3" />
          {done}
        </span>
      )}
    </div>
  );
}

function Reserved({ reserved }: { reserved: ReservedAgent }) {
  const t = useTranslations("onboarding.register.name");
  const harnessT = useTranslations("agents.harness");
  return (
    <dl
      data-testid="register-reserved"
      className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-[13px]"
    >
      <dt className={kvTerm}>{t("name")}</dt>
      <dd className={kvValue}>{reserved.name}</dd>
      <dt className={kvTerm}>{t("slug")}</dt>
      <dd className={`${kvValue} ${mono}`}>{reserved.slug}</dd>
      <dt className={kvTerm}>{t("harness")}</dt>
      <dd className={kvValue}>{harnessT(reserved.harness)}</dd>
      <dt className={kvTerm}>{t("runtime")}</dt>
      <dd className={kvValue}>
        {reserved.runtime === null ? t("noRuntime") : reserved.runtime.name}
      </dd>
      <dt className={kvTerm}>{t("toolbelt")}</dt>
      <dd className={kvValue}>
        {reserved.toolbelt === null ? t("allTools") : reserved.toolbelt.name}
      </dd>
    </dl>
  );
}

function ToolbeltSection({
  read,
  value,
  onChange,
  tools,
}: {
  read: Read<ToolbeltList>;
  value: string;
  onChange: (id: string) => void;
  /** The tool import page, where MCP servers are imported. */
  tools: SafePath;
}) {
  const t = useTranslations("onboarding.register.name");
  if (!read.ok)
    return (
      <section className="flex flex-col gap-2" aria-label={t("toolbelt")}>
        <SectionHead title={t("toolbelt")} />
        <ReadFailure read={read} section={t("toolbelt")} />
        <p className={hint}>{t("toolbeltDefault")}</p>
      </section>
    );
  const { belts, availableTools } = read.value;
  if (availableTools === 0)
    return (
      <section
        className="flex flex-col gap-2"
        aria-label={t("toolbelt")}
        data-testid="register-toolbelt-empty"
      >
        <SectionHead title={t("toolbelt")} done={t("toolbeltDone")} />
        <p className="text-[13px] text-foreground">{t("toolbeltEmpty")}</p>
        <SafeLink
          to={tools}
          data-testid="register-toolbelt-import"
          className={`${linkText} self-start`}
        >
          {t("toolbeltImport")}
        </SafeLink>
      </section>
    );
  const all = belts.find((belt) => belt.kind === "all_tools");
  return (
    <section className="flex flex-col gap-2" aria-label={t("toolbelt")}>
      <SectionHead title={t("toolbelt")} />
      <ChoiceGroup
        label={t("toolbelt")}
        testId="register-toolbelt"
        value={value === "" ? (all?.id ?? null) : value}
        onChange={(id) => {
          onChange(id === all?.id ? "" : id);
        }}
        options={belts.map((belt) => ({
          value: belt.id,
          label: belt.name,
          sub: t("toolbeltTools", { count: belt.activeTools }),
        }))}
      />
      <p className={hint}>{t("toolbeltHint")}</p>
    </section>
  );
}

export function RegisterAgentForm({
  org,
  ws,
  place,
  reserved,
  runtimes,
  toolbelts,
  initialRuntime,
  wrap,
  fleet,
}: {
  org: string;
  ws: string;
  place: RegisterPlace;
  /** The agent this registration already reserved, or null before Continue. */
  reserved: ReservedAgent | null;
  /** `list_runtimes`: the runtimes to choose from, each with its live agents. */
  runtimes: Read<NamedRuntimeList>;
  /** `list_toolbelts`: the belts to choose from and the workspace's tool count. */
  toolbelts: Read<ToolbeltList>;
  /** `?runtime=`, the runtime Add a runtime chose; null otherwise. */
  initialRuntime: string | null;
  /** The wrap step for the reserved identity; null before one exists. */
  wrap: SafePath | null;
  fleet: SafePath;
}) {
  const t = useTranslations("onboarding.register.name");
  const errorsT = useTranslations("onboarding.errors");
  const harnessT = useTranslations("agents.harness");
  const failureText = useOnboardingFailure();
  const navigate = useNavigate();
  const baseId = useId();
  const named = runtimes.ok ? runtimes.value.runtimes : [];
  const [name, setName] = useState(reserved?.name ?? "");
  const [slug, setSlug] = useState(reserved?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(reserved !== null);
  const [harness, setHarness] = useState<Harness | null>(
    reserved?.harness ?? null,
  );
  const [runtimeId, setRuntimeId] = useState<string | null>(
    reserved?.runtime?.id ??
      named.find((runtime) => runtime.id === initialRuntime)?.id ??
      null,
  );
  const [toolbeltId, setToolbeltId] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = agentKeyOf(place.keyPrefix, slug);
  const keyText = (chunks: ReactNode) => (
    <span data-testid="register-key" className={mono}>
      {chunks}
    </span>
  );
  const chosenRuntime = named.find((runtime) => runtime.id === runtimeId);

  /** The sentence a taken pair shows: the harness, the runtime and the agent that holds it. */
  function takenReason(
    runtime: (typeof named)[number] | undefined,
    of: Harness | null,
  ): string | null {
    const holder = holderOf(runtime, of);
    if (holder === null || runtime === undefined || of === null) return null;
    return t("taken", {
      harness: harnessT(of),
      runtime: runtime.name,
      agent: holder.slug,
    });
  }

  function errorText(field: AgentField): string | null {
    const code = errors[field];
    if (code === undefined) return null;
    if (code === "taken")
      return field === "slug"
        ? errorsT("agentSlugTaken")
        : errorsT("agentRuntimeHarnessTaken");
    return errorsT(code);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (reserved !== null && wrap !== null) {
      navigate.push(wrap);
      return;
    }
    setFailure(null);
    const values = {
      name: name.trim(),
      slug: slug.trim(),
      harness: harness ?? "",
      runtimeId: runtimeId ?? "",
      toolbeltId,
    };
    const parsed = Schema.safeParse(values);
    if (!parsed.success) {
      setErrors(agentFieldErrors(parsed.error.issues));
      return;
    }
    if (takenReason(chosenRuntime, harness) !== null) {
      setErrors({ runtimeId: "taken" });
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await registerAgent(org, ws, values);
      if (result.ok) {
        navigate.push(result.value.to);
        return;
      }
      if (result.reason === "invalid") {
        const fields = agentFieldErrors([
          { path: [result.field ?? ""], message: result.code },
        ]);
        if (Object.keys(fields).length > 0) {
          setErrors(fields);
          return;
        }
      }
      if (result.reason === "conflict" && result.code === "agent_slug_taken") {
        setErrors({ slug: "taken" });
        return;
      }
      if (
        result.reason === "conflict" &&
        result.code === "runtime_harness_taken"
      ) {
        setErrors({ runtimeId: "taken" });
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const nameId = `${baseId}-name`;
  const slugId = `${baseId}-slug`;
  const harnessHintId = `${baseId}-harness-hint`;
  const runtimeHintId = `${baseId}-runtime-hint`;
  const locked = reserved !== null;
  const tools = routes.tools(org, ws, { tab: "providers" });

  const fieldError = (field: AgentField, id: string) => {
    const text = errorText(field);
    return text === null ? null : (
      <p id={id} className="text-sm text-error-ink">
        {text}
      </p>
    );
  };

  return (
    <form
      noValidate
      aria-label={t("title")}
      onSubmit={(e) => void onSubmit(e)}
      className="flex min-w-0 flex-col gap-4"
    >
      <div className={`${panel} flex flex-col gap-5 p-[18px]`}>
        {failure === null ? null : (
          <FormAlert testId="register-failure">{failure}</FormAlert>
        )}
        {locked ? (
          <Reserved reserved={reserved} />
        ) : (
          <>
            <section className="flex flex-col gap-4" aria-label={t("agent")}>
              <SectionHead title={t("agent")} />
              <div className="grid gap-x-4 gap-y-5 md:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={nameId} className={label}>
                    {t("name")}
                  </label>
                  <input
                    id={nameId}
                    name="name"
                    type="text"
                    autoComplete="off"
                    maxLength={128}
                    value={name}
                    onChange={(e) => {
                      const next = e.target.value;
                      setName(next);
                      if (!slugEdited) setSlug(agentSlugFromName(next));
                    }}
                    aria-invalid={errors.name === undefined ? undefined : true}
                    aria-describedby={`${nameId}-hint${errors.name === undefined ? "" : ` ${nameId}-error`}`}
                    className={control}
                  />
                  {fieldError("name", `${nameId}-error`)}
                  <p id={`${nameId}-hint`} className={hint}>
                    {t("nameHint")}
                  </p>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={slugId} className={label}>
                    {t("slug")}
                  </label>
                  <input
                    id={slugId}
                    name="slug"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={AGENT_SLUG_MAX}
                    value={slug}
                    onChange={(e) => {
                      setSlugEdited(true);
                      setSlug(e.target.value);
                    }}
                    aria-invalid={errors.slug === undefined ? undefined : true}
                    aria-describedby={`${slugId}-hint${errors.slug === undefined ? "" : ` ${slugId}-error`}`}
                    className={`${control} ${mono}`}
                  />
                  {fieldError("slug", `${slugId}-error`)}
                  <p id={`${slugId}-hint`} className={hint}>
                    {t.rich("slugHint", { key, mono: keyText })}
                  </p>
                </div>
              </div>
            </section>
            <section className="flex flex-col gap-4" aria-label={t("place")}>
              <SectionHead title={t("place")} />
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className={label}>{t("harness")}</span>
                <ChoiceGroup
                  label={t("harness")}
                  testId="register-harness"
                  describedBy={harnessHintId}
                  value={harness}
                  onChange={(next) => {
                    setHarness(next);
                    setErrors((prev) => ({ ...prev, harness: undefined }));
                  }}
                  options={HARNESSES.map((option) => ({
                    value: option,
                    label: harnessT(option),
                    disabledReason: takenReason(chosenRuntime, option),
                  }))}
                />
                {fieldError("harness", `${baseId}-harness-error`)}
                <p id={harnessHintId} className={hint}>
                  {t("harnessHint")}
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className={label}>{t("runtime")}</span>
                {!runtimes.ok ? (
                  <ReadFailure read={runtimes} section={t("runtime")} />
                ) : named.length === 0 ? (
                  <p
                    data-testid="register-runtime-none"
                    className="text-[13px] text-foreground"
                  >
                    {t("runtimeNone")}
                  </p>
                ) : (
                  <ChoiceGroup
                    label={t("runtime")}
                    testId="register-runtime"
                    describedBy={runtimeHintId}
                    value={runtimeId}
                    onChange={(next) => {
                      setRuntimeId(next);
                      setErrors((prev) => ({ ...prev, runtimeId: undefined }));
                    }}
                    options={named.map((runtime) => ({
                      value: runtime.id,
                      label: runtime.name,
                      sub: runtime.slug,
                      disabledReason: takenReason(runtime, harness),
                    }))}
                  />
                )}
                {fieldError("runtimeId", `${baseId}-runtime-error`)}
                <p id={runtimeHintId} className={hint}>
                  {t("runtimeHint")}{" "}
                  <SafeLink
                    to={routes.runtimes(org, ws)}
                    data-testid="register-add-runtime"
                    className={linkText}
                  >
                    {t("addRuntime")}
                  </SafeLink>
                </p>
              </div>
            </section>
            <ToolbeltSection
              read={toolbelts}
              value={toolbeltId}
              onChange={setToolbeltId}
              tools={tools}
            />
          </>
        )}
        <p
          data-testid="register-note"
          className="border-l-2 border-gold py-0.5 pl-3.5 text-[13px] text-foreground"
        >
          {locked
            ? t.rich("reserved", { key, mono: keyText })
            : t.rich("note", { key, mono: keyText })}
        </p>
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <CancelRegistration
          org={org}
          ws={ws}
          agentId={reserved?.id ?? null}
          fleet={fleet}
          testId="register-cancel"
          className="max-md:w-full"
        />
        <span className="flex max-md:w-full md:ml-auto">
          {locked && wrap !== null ? (
            <SafeLink to={wrap} className={`${buttonPrimary} max-md:w-full`}>
              {t("continue")}
            </SafeLink>
          ) : (
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending || undefined}
              className={`${buttonPrimary} max-md:w-full`}
            >
              {pending ? t("pending") : t("continue")}
            </button>
          )}
        </span>
      </div>
    </form>
  );
}
