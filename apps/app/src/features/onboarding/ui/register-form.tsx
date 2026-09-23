"use client";
// Step 1 of Register an agent (register-name spec): reserve the agent key. The
// card is the design's two-by-two grid, Slug, Workspace, Harness and Model
// tier, then the note, then Cancel and Continue (gold). The key in the hint and
// in the note rewrites on every keystroke from the namespaces the workspace
// read carries, so it is the key `register_agent` will mint, not a guess.
//
// Continue is the one write: `register_agent` reserves the slug by minting the
// identity and its principal. The credential that call returns is not shown
// here; the SDK path on the wrap step issues its own, so no secret sits on a
// screen the operator may walk away from. A key already reserved (the operator
// came back with Back or the rail) is shown read-only, and Continue only moves
// on, because the key is immutable.
//
// Model tier has no store: `register_agent` takes no tier and the frames
// record the model each call used. The select says so rather than sending a
// value nothing keeps.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useId, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary, inputBase, mono, panel } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { registerAgent } from "../actions";
import {
  AgentForm as Schema,
  type AgentFormErrorKey,
  agentFieldErrors,
  agentKeyOf,
  HARNESSES,
  type Harness,
  MODEL_TIERS,
  nameFromSlug,
} from "../agent-form";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import type { RegisterPlace } from "../register-actions";
import { CancelRegistration } from "./cancel-registration";

/** An input or select at 16px on a phone, so iOS does not zoom on focus. */
const control = `${inputBase} min-h-10 max-md:min-h-11 max-md:text-base`;
const label = "text-[12.5px] font-semibold text-foreground";
const hint = "text-xs text-muted-foreground";

export type ReservedAgent = { id: string; slug: string; harness: Harness };

export function RegisterAgentForm({
  org,
  ws,
  workspace,
  place,
  reserved,
  wrap,
  fleet,
}: {
  org: string;
  ws: string;
  /** The workspace's display name. */
  workspace: string;
  place: RegisterPlace;
  /** The key this registration already reserved, or null before Continue. */
  reserved: ReservedAgent | null;
  /** The wrap step for the reserved identity; null before one exists. */
  wrap: SafePath | null;
  fleet: SafePath;
}) {
  const t = useTranslations("onboarding.register.name");
  const errorsT = useTranslations("onboarding.errors");
  const failureText = useOnboardingFailure();
  const navigate = useNavigate();
  const ids = useId();
  const [slug, setSlug] = useState(reserved?.slug ?? "");
  const [harness, setHarness] = useState<Harness>(
    reserved?.harness ?? "claude-code",
  );
  const [slugError, setSlugError] = useState<AgentFormErrorKey | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = agentKeyOf(place.keyPrefix, slug);
  const keyText = (chunks: ReactNode) => (
    <span data-testid="register-key" className={mono}>
      {chunks}
    </span>
  );

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (reserved !== null && wrap !== null) {
      navigate.push(wrap);
      return;
    }
    setFailure(null);
    const values = {
      slug: slug.trim(),
      name: nameFromSlug(slug),
      description: "",
      harness,
    };
    const parsed = Schema.safeParse(values);
    if (!parsed.success) {
      setSlugError(agentFieldErrors(parsed.error.issues).slug ?? null);
      return;
    }
    setSlugError(null);
    setPending(true);
    try {
      const result = await registerAgent(org, ws, values);
      if (result.ok) {
        navigate.push(result.value.to);
        return;
      }
      if (result.reason === "invalid" && result.field === "slug") {
        setSlugError(
          agentFieldErrors([{ path: ["slug"], message: result.code }]).slug ??
            null,
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

  const slugId = `${ids}-slug`;
  const workspaceId = `${ids}-workspace`;
  const harnessId = `${ids}-harness`;
  const tierId = `${ids}-tier`;
  const locked = reserved !== null;

  return (
    <form
      noValidate
      aria-label={t("title")}
      onSubmit={(e) => void onSubmit(e)}
      className="flex min-w-0 flex-col gap-4"
    >
      <div className={`${panel} flex flex-col gap-4 p-[18px]`}>
        {failure === null ? null : (
          <FormAlert testId="register-failure">{failure}</FormAlert>
        )}
        <div className="grid gap-x-4 gap-y-5 md:grid-cols-2">
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
              readOnly={locked}
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
              }}
              aria-invalid={slugError === null ? undefined : true}
              aria-describedby={`${slugId}-hint${slugError === null ? "" : ` ${slugId}-error`}`}
              className={control}
            />
            {slugError === null ? null : (
              <p id={`${slugId}-error`} className="text-sm text-error-ink">
                {errorsT(slugError)}
              </p>
            )}
            <p id={`${slugId}-hint`} className={hint}>
              {t.rich("slugHint", { key, mono: keyText })}
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={workspaceId} className={label}>
              {t("workspace")}
            </label>
            <input
              id={workspaceId}
              type="text"
              readOnly
              value={t("workspaceValue", {
                workspace,
                repository: place.repository ?? t("noRepository"),
              })}
              aria-describedby={`${workspaceId}-hint`}
              className={`${control} bg-hl text-muted-foreground`}
            />
            <p id={`${workspaceId}-hint`} className={hint}>
              {t.rich("workspaceHint", {
                code: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={harnessId} className={label}>
              {t("harness")}
            </label>
            <select
              id={harnessId}
              name="harness"
              value={harness}
              disabled={locked}
              onChange={(e) => {
                const next = HARNESSES.find((h) => h === e.target.value);
                if (next !== undefined) setHarness(next);
              }}
              aria-describedby={`${harnessId}-hint`}
              className={control}
            >
              {HARNESSES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <p id={`${harnessId}-hint`} className={hint}>
              {t("harnessHint")}
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={tierId} className={label}>
              {t("tier")}
            </label>
            <select
              id={tierId}
              name="tier"
              disabled
              defaultValue={MODEL_TIERS[0]}
              aria-describedby={`${tierId}-hint ${tierId}-unsent`}
              className={control}
            >
              {MODEL_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
            <p id={`${tierId}-hint`} className={hint}>
              {t("tierHint")}
            </p>
            {/* Not backed until #3900 lands. */}
            <p
              id={`${tierId}-unsent`}
              data-testid="not-backed"
              data-element="model-tier"
              className={hint}
            >
              {t("tierNotSent")}
            </p>
          </div>
        </div>
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
