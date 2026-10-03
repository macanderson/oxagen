"use client";
// Promote (memory-collection spec, Promotion; the mockup's steering.js
// `DIALOGS["str-mem-promote"]` and `ACTS["str-mem-promote-go"]`): one draft
// record per selected row, each with its statement, kind, force, and the
// scope promote_memories gives it. The drafts join the open memory PR, or
// open one on today's memory branch, and nothing steers until it merges.
//
// The kind starts at the memory's own and the force at that kind's default.
// The Force select offers only the forces the kind allows (./drafts.ts), and
// a constraint asks for its effect. A refused or failed call keeps the dialog
// and every value in it, says what failed, and moves no memory.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { WorkspaceMemory } from "@/data/contracts/steering";
import {
  buttonPrimary,
  fieldHint,
  fieldLabel,
  inputBase,
  mono,
  textareaBase,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { SheetDialog } from "@/ui/sheet-dialog";
import type { SteeringAt } from "../view";
import { promoteMemories } from "./actions";
import type { MemoryAgents } from "./cells";
import {
  type ConstraintEffect,
  type Draft,
  defaultForce,
  draftOf,
  forceChoices,
  PROMOTE_DRAFTS_MAX,
  PROMOTE_KINDS,
  promotePayload,
  STATEMENT_MAX,
  withKind,
} from "./drafts";
import {
  type MemoryWriteFailure,
  UNANSWERED,
  useMemoryWriteFailure,
} from "./failure";

const EFFECTS: readonly ConstraintEffect[] = ["require", "forbid"];
const select = `${inputBase} h-9 w-full`;

function DraftFields({
  index,
  draft,
  agents,
  disabled,
  onChange,
}: {
  index: number;
  draft: Draft;
  agents: MemoryAgents;
  disabled: boolean;
  onChange: (next: Draft) => void;
}) {
  const t = useTranslations("steering.memories.promote");
  const kinds = useTranslations("steering.import.kinds");
  const effects = useTranslations("steering.import.effects");
  const memories = useTranslations("steering.memories");
  const format = useFormatter();
  const id = useId();
  const names = draft.agents.map((agent) =>
    agent === null
      ? memories("noAgent")
      : Object.hasOwn(agents, agent)
        ? (agents[agent]?.name ?? agent)
        : agent,
  );
  const choices = forceChoices(draft.kind);
  const forceHint =
    choices.length === 1
      ? t("forceOnly")
      : draft.force === defaultForce(draft.kind)
        ? t("forceDefault")
        : t("forceChosen");
  return (
    <fieldset
      data-testid="promote-draft"
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <legend className="px-1 text-sm font-semibold text-foreground">
        {t("draft", { number: String(index + 1) })}
      </legend>
      <p className="text-sm text-muted-foreground">
        {t("from", { count: draft.ids.length, agents: format.list(names) })}
      </p>
      <div>
        <label htmlFor={`${id}-statement`} className={fieldLabel}>
          {t("statement")}
        </label>
        <textarea
          id={`${id}-statement`}
          data-testid="promote-statement"
          rows={3}
          maxLength={STATEMENT_MAX}
          disabled={disabled}
          value={draft.statement}
          onChange={(event) => {
            onChange({ ...draft, statement: event.currentTarget.value });
          }}
          className={`${textareaBase} w-full`}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-kind`} className={fieldLabel}>
            {t("kind")}
          </label>
          <select
            id={`${id}-kind`}
            data-testid="promote-kind"
            disabled={disabled}
            value={draft.kind}
            onChange={(event) => {
              const kind = PROMOTE_KINDS.find(
                (k) => k === event.currentTarget.value,
              );
              if (kind !== undefined) onChange(withKind(draft, kind));
            }}
            className={select}
          >
            {PROMOTE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kinds(kind)}
              </option>
            ))}
          </select>
          <p className={fieldHint}>
            {draft.kind === draft.suggested
              ? t("kindSuggested")
              : t("kindChosen")}
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-force`} className={fieldLabel}>
            {t("force")}
          </label>
          <select
            id={`${id}-force`}
            data-testid="promote-force"
            disabled={disabled}
            value={draft.force}
            onChange={(event) => {
              const force = choices.find(
                (f) => f === event.currentTarget.value,
              );
              if (force !== undefined) onChange({ ...draft, force });
            }}
            className={select}
          >
            {choices.map((force) => (
              <option key={force} value={force}>
                {force}
              </option>
            ))}
          </select>
          <p className={fieldHint}>{forceHint}</p>
        </div>
        <div>
          <span className={fieldLabel}>{t("scope")}</span>
          <p
            className="text-sm text-foreground"
            data-testid="promote-scope"
          >
            {draft.repos.length === 0 ? (
              t("workspace")
            ) : (
              <span className={mono}>{draft.repos.join(" ")}</span>
            )}
          </p>
          <p className={fieldHint}>{t("scopeHint")}</p>
        </div>
      </div>
      {draft.kind === "constraint" ? (
        <div>
          <label htmlFor={`${id}-effect`} className={fieldLabel}>
            {t("effect")}
          </label>
          <select
            id={`${id}-effect`}
            data-testid="promote-effect"
            disabled={disabled}
            value={draft.effect ?? "require"}
            onChange={(event) => {
              const effect = EFFECTS.find(
                (e) => e === event.currentTarget.value,
              );
              if (effect !== undefined) onChange({ ...draft, effect });
            }}
            className={`${select} sm:w-auto`}
          >
            {EFFECTS.map((effect) => (
              <option key={effect} value={effect}>
                {effects(effect)}
              </option>
            ))}
          </select>
          <p className={fieldHint}>{t("effectHint")}</p>
        </div>
      ) : null}
    </fieldset>
  );
}

export function PromoteDialog({
  at,
  rows,
  agents,
  openPr,
  onClose,
  onDone,
}: {
  at: SteeringAt;
  /** One entry per selected row: the memories that say the same thing. */
  rows: readonly (readonly WorkspaceMemory[])[];
  agents: MemoryAgents;
  /** The open memory PR the drafts join; null when Promote opens one. */
  openPr: number | null;
  onClose: () => void;
  /** Called with the sentence the page toasts once the drafts are on the memory PR. */
  onDone: (text: string) => void;
}) {
  const t = useTranslations("steering.memories.promote");
  const failureText = useMemoryWriteFailure();
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    rows.flatMap((row) => {
      const draft = draftOf(row);
      return draft === null ? [] : [draft];
    }),
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const memories = drafts.reduce((sum, draft) => sum + draft.ids.length, 0);
  const tooMany = drafts.length > PROMOTE_DRAFTS_MAX;
  const submit = async () => {
    const payload = promotePayload(drafts);
    if (payload === null) {
      setFailure(t("emptyStatement"));
      return;
    }
    setPending(true);
    setFailure(null);
    const result: Awaited<ReturnType<typeof promoteMemories>> =
      await promoteMemories(at.org, at.ws, payload).catch(
        (): MemoryWriteFailure => UNANSWERED,
      );
    setPending(false);
    if (!result.ok) {
      setFailure(failureText(result));
      return;
    }
    const { pullRequest, records, skipped } = result.value;
    const added =
      pullRequest === null
        ? t("doneNone")
        : t("done", { count: records, number: String(pullRequest.number) });
    onDone(skipped === 0 ? added : `${added} ${t("skipped", { count: skipped })}`);
  };
  const empty = drafts.length === 0;
  return (
    <SheetDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      subtitle={
        openPr === null ? t("subNew") : t("sub", { number: String(openPr) })
      }
      wide
      testId="promote-dialog"
      closeLabel={t("cancel")}
      headerClose
      dismissible={!pending}
      footerNote={
        empty ? undefined : (
          <span data-testid="promote-summary">
            {t("summary", { drafts: drafts.length, memories })}
          </span>
        )
      }
      footer={
        empty ? null : (
          <button
            type="button"
            data-testid="promote-submit"
            className={buttonPrimary}
            disabled={pending || tooMany}
            onClick={() => {
              void submit();
            }}
          >
            {pending
              ? t("pending")
              : openPr === null
                ? t("submitOpen")
                : t("submitJoin", { number: String(openPr) })}
          </button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {empty ? (
          <p className="text-sm text-muted-foreground">
            {t("noneWaiting")}
          </p>
        ) : (
          drafts.map((draft, index) => (
            <DraftFields
              key={draft.ids[0]}
              index={index}
              draft={draft}
              agents={agents}
              disabled={pending}
              onChange={(next) => {
                setDrafts((current) =>
                  current.map((d, i) => (i === index ? next : d)),
                );
              }}
            />
          ))
        )}
        {tooMany ? (
          <FormAlert testId="promote-too-many">
            {t("tooMany", { max: PROMOTE_DRAFTS_MAX })}
          </FormAlert>
        ) : null}
        {failure === null ? null : (
          <FormAlert testId="promote-failure">{failure}</FormAlert>
        )}
      </div>
    </SheetDialog>
  );
}
