"use client";
// The priorities record editor on Work setup › Priorities, shown while the
// workspace has no priorities record. Triage cannot rank a work item without
// one, so this is where a person writes it: one instruction line, then the
// numbered rules triage cites, each as its own line. It starts from a set of
// common rules the person edits, removes, reorders, or adds to.
//
// Saving proposes the record (propose_record) and opens its steering pull
// request (open_steering_pr) in one step. The record lives in the steering
// repository like every steering record, and triage reads it once that pull
// request merges. A retry after the pull request failed to open reuses the
// proposal, because a second proposal on the same record is refused.
//
// The record wizard flattens a statement to one line, and triage would read
// that as a single rule, so this editor writes the statement itself and keeps
// a line break before every rule.
//
// propose_record and open_steering_pr take a workspace Owner or Member, or an
// org Owner or Admin. For any other role the submit is off and a line above it
// says why. The server refuses the write either way.
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  buttonSmall,
  fieldHint,
  fieldLabel,
  inputBase,
  linkText,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
  textareaBase,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { PullRequestLink, SafeLink } from "@/ui/navigation";
import { openPrioritiesPr, proposePriorities } from "../actions";
import { UNANSWERED, useListActionFailure } from "../list-action-failure";

/** propose_record's statement limit. */
const STATEMENT_MAX = 2000;
/** The starter rules, in the order the editor opens with them. */
const STARTER_RULES = ["1", "2", "3", "4", "5", "6"] as const;

/** One rule row: a stable key for React and the rule's text. */
type Rule = { key: number; text: string };

/** The record as triage reads it: the instruction, a blank line, then one numbered line per rule. */
function prioritiesStatement(instruction: string, rules: readonly string[]): string {
  const lines = rules
    .map((rule) => rule.trim().replace(/\s*\n\s*/g, " "))
    .filter((rule) => rule !== "")
    .map((rule, index) => `${String(index + 1)}. ${rule}`);
  return [instruction.trim().replace(/\s*\n\s*/g, " "), "", ...lines].join("\n").trim();
}

type Opened = { proposalId: string; pr: { number: number; url: string; repository: string } | null };

export function PrioritiesEditor({
  org,
  ws,
  canControl,
}: {
  org: string;
  ws: string;
  /** Whether the viewer may propose the record and open its pull request; unknown reads as allowed and the server decides. */
  canControl: boolean;
}) {
  const t = useTranslations("work.setup.priorities.editor");
  const failureText = useListActionFailure();
  const starters = STARTER_RULES.map((key) => t(`starterRules.${key}`));
  const [instruction, setInstruction] = useState<string>(() => t("starterInstruction"));
  const [rules, setRules] = useState<Rule[]>(() =>
    starters.map((text, key) => ({ key, text })),
  );
  const [nextKey, setNextKey] = useState(starters.length);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The proposal a failed open left behind, with the statement it holds.
  const [proposal, setProposal] = useState<{ id: string; statement: string } | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);

  const statement = prioritiesStatement(
    instruction,
    rules.map((rule) => rule.text),
  );
  const ruleCount = rules.filter((rule) => rule.text.trim() !== "").length;
  const tooLong = statement.length > STATEMENT_MAX;

  function update(key: number, text: string) {
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, text } : rule)));
  }

  function move(index: number, by: -1 | 1) {
    setRules((current) => {
      const next = [...current];
      const [rule] = next.splice(index, 1);
      if (rule === undefined) return current;
      next.splice(index + by, 0, rule);
      return next;
    });
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !canControl) return;
    if (instruction.trim() === "") {
      setFailure(t("instructionRequired"));
      return;
    }
    if (ruleCount === 0) {
      setFailure(t("rulesRequired"));
      return;
    }
    if (tooLong) {
      setFailure(t("tooLong", { max: STATEMENT_MAX }));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      let proposalId = proposal !== null && proposal.statement === statement ? proposal.id : null;
      if (proposalId === null) {
        const proposed = await proposePriorities(org, ws, { statement });
        if (!proposed.ok) {
          setFailure(failureText(proposed));
          return;
        }
        proposalId = proposed.value.proposalId;
        setProposal({ id: proposalId, statement });
      }
      const result = await openPrioritiesPr(org, ws, { proposalId });
      if (result.ok) setOpened(result.value);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  if (opened !== null) {
    const url = opened.pr === null ? null : parsePullRequestUrl(opened.pr.url);
    const pr = (chunks: ReactNode) =>
      url === null ? (
        chunks
      ) : (
        <PullRequestLink to={url} data-testid="work-priorities-pr" className={linkText}>
          {chunks}
        </PullRequestLink>
      );
    return (
      <section
        aria-labelledby="work-priorities-opened-title"
        data-testid="work-priorities-opened"
        className={panel}
      >
        <div className={panelHeader}>
          <h2 id="work-priorities-opened-title" className={panelTitle}>
            {t("openedTitle")}
          </h2>
        </div>
        <div className={`${panelBody} flex flex-col gap-3 text-base`}>
          <p>
            {opened.pr === null
              ? t("openedNoPr")
              : t.rich("openedPr", {
                  number: String(opened.pr.number),
                  repository: opened.pr.repository,
                  pr,
                })}
          </p>
          <p className="text-muted-foreground">{t("openedRetry")}</p>
          <div>
            <SafeLink
              to={routes.steeringProposal(org, ws, opened.proposalId)}
              data-testid="work-priorities-review"
              className={buttonPrimary}
            >
              {t("review")}
            </SafeLink>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="work-priorities-editor-title"
      data-testid="work-priorities-editor"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-priorities-editor-title" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <form noValidate onSubmit={(event) => void submit(event)} className={`${panelBody} flex flex-col gap-4`}>
        <p className="text-base text-muted-foreground">{t("body")}</p>
        <div className="flex min-w-0 flex-col">
          <label htmlFor="work-priorities-instruction" className={fieldLabel}>
            {t("instruction")}
          </label>
          <input
            id="work-priorities-instruction"
            value={instruction}
            onChange={(event) => {
              setInstruction(event.currentTarget.value);
            }}
            aria-describedby="work-priorities-instruction-hint"
            className={inputBase}
          />
          <p id="work-priorities-instruction-hint" className={fieldHint}>
            {t("instructionHint")}
          </p>
        </div>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className={fieldLabel}>{t("rules")}</legend>
          <p className={fieldHint}>{t("rulesHint")}</p>
          <ol data-testid="work-priorities-editor-rules" className="flex flex-col gap-2">
            {rules.map((rule, index) => {
              const number = String(index + 1);
              return (
                <li key={rule.key} data-rule={number} className="flex items-start gap-2">
                  <span aria-hidden="true" className={`${mono} w-8 flex-none pt-2 text-right text-dim`}>
                    {number}.
                  </span>
                  <textarea
                    aria-label={t("ruleLabel", { number })}
                    value={rule.text}
                    rows={2}
                    onChange={(event) => {
                      update(rule.key, event.currentTarget.value);
                    }}
                    className={`${textareaBase} min-w-0 flex-1`}
                  />
                  <div className="flex flex-none flex-col gap-1">
                    <button
                      type="button"
                      aria-label={t("moveUp", { number })}
                      disabled={index === 0}
                      onClick={() => {
                        move(index, -1);
                      }}
                      className={buttonSmall}
                    >
                      <ArrowUpIcon aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={t("moveDown", { number })}
                      disabled={index === rules.length - 1}
                      onClick={() => {
                        move(index, 1);
                      }}
                      className={buttonSmall}
                    >
                      <ArrowDownIcon aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={t("remove", { number })}
                      onClick={() => {
                        setRules((current) => current.filter((item) => item.key !== rule.key));
                      }}
                      className={buttonSmall}
                    >
                      <TrashIcon aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div>
            <button
              type="button"
              data-testid="work-priorities-add-rule"
              onClick={() => {
                setRules((current) => [...current, { key: nextKey, text: "" }]);
                setNextKey((key) => key + 1);
              }}
              className={buttonSecondary}
            >
              <PlusIcon aria-hidden="true" />
              {t("addRule")}
            </button>
          </div>
        </fieldset>
        <details className="text-base">
          <summary className="cursor-pointer font-medium">{t("preview")}</summary>
          <pre
            data-testid="work-priorities-preview"
            className={`${mono} mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-3`}
          >
            {statement}
          </pre>
          <p className={`${fieldHint} ${tooLong ? "text-error-ink" : ""}`}>
            {t("length", { count: statement.length, max: STATEMENT_MAX })}
          </p>
        </details>
        {failure === null ? null : (
          <FormAlert testId="work-priorities-failure">{failure}</FormAlert>
        )}
        {canControl ? null : (
          <p data-testid="work-priorities-no-role" className={fieldHint}>
            {t("noRole")}
          </p>
        )}
        <SubmitButton
          pending={pending}
          label={t("submit")}
          pendingLabel={t("pending")}
          disabled={!canControl}
          testId="work-priorities-submit"
        />
      </form>
    </section>
  );
}
