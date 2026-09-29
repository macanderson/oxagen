"use client";
// One tool's panel on a Studio server (#4678, "Tool panel"): its
// classification, the description agents see, how the gateway shapes its
// inputs and result, what the server says about it, what agents' calls said,
// and its off switch.
//
// Every edit here is staged in the draft, never written. A suggested
// classification stays a suggestion until a person confirms or changes it,
// and the steering PR that Changes opens is what records it. Draft asks the
// in-app agent for a description and bills as in-app agent spend; until the
// capability lands it answers "not built" (seams.ts).
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import {
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import { Badge } from "@/ui/badge";
import { CodeBlock } from "@/ui/code-panel";
import {
  buttonSecondary,
  fieldHint,
  inputBase,
  kvList,
  kvTerm,
  kvValue,
  mono,
  note,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  DESCRIPTION_MAX,
  type DraftOp,
  importedAfter,
  stagedClassification,
  stagedDescription,
} from "./draft";
import { studioGapRef } from "./gaps";
import type { StudioClassification, StudioTool } from "./model";
import { StudioNotRecorded } from "./not-recorded";
import { type DraftDescription, draftDescription } from "./seams";

const section = "flex flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0";
const heading = "text-[13.5px] font-semibold text-foreground";

type Choice = {
  risk: ToolRiskGrade | "";
  sideEffect: ToolSideEffect | "";
  egress: ToolEgress | "";
};

function choiceOf(values: StudioClassification | Choice | null): Choice {
  if (values === null) return { risk: "", sideEffect: "", egress: "" };
  return {
    risk: values.risk,
    sideEffect: values.sideEffect,
    egress: values.egress,
  };
}

function Classification({
  tool,
  ops,
  canEdit,
  onStage,
}: {
  tool: StudioTool;
  ops: readonly DraftOp[];
  canEdit: boolean;
  onStage: (op: DraftOp) => void;
}) {
  const t = useTranslations("mcpStudio.panel");
  const registry = useTranslations("tools.registry");
  const id = useId();
  const staged = stagedClassification(tool.name, ops);
  const current = tool.classification;
  const [choice, setChoice] = useState<Choice>(() =>
    choiceOf(staged ?? current),
  );
  const imported = importedAfter(tool, ops);
  /** The suggestion no person has confirmed, while the draft holds no classification. */
  const suggestion =
    staged === undefined && current !== null && !current.confirmed
      ? current
      : null;
  const shown = staged ?? current;
  /** What the choice is measured against: the staged or confirmed classification. */
  const settled =
    staged ?? (current !== null && current.confirmed ? current : null);
  const complete =
    choice.risk !== "" && choice.sideEffect !== "" && choice.egress !== "";
  /** Staging the classification already in force would change nothing. */
  const unchanged =
    settled !== null &&
    choice.risk === settled.risk &&
    choice.sideEffect === settled.sideEffect &&
    choice.egress === settled.egress;
  const stageChoice = () => {
    if (choice.risk === "" || choice.sideEffect === "" || choice.egress === "") {
      return;
    }
    onStage({
      kind: "classify",
      tool: tool.name,
      risk: choice.risk,
      sideEffect: choice.sideEffect,
      egress: choice.egress,
      impacts: [...(staged?.impacts ?? current?.impacts ?? [])],
    });
  };
  return (
    <section aria-labelledby={`${id}-h`} className={section}>
      <h3 id={`${id}-h`} className={heading}>
        {t("classification")}
      </h3>
      {shown === null ? (
        <p className="text-[13px] text-muted-foreground">{t("unclassified")}</p>
      ) : (
        <dl className={kvList} data-testid="studio-panel-classification">
          <dt className={kvTerm}>{t("risk")}</dt>
          <dd className={kvValue}>{registry(`risk.${shown.risk}`)}</dd>
          <dt className={kvTerm}>{t("sideEffect")}</dt>
          <dd className={kvValue}>
            {registry(`sideEffect.${shown.sideEffect}`)}
          </dd>
          <dt className={kvTerm}>{t("egress")}</dt>
          <dd className={kvValue}>{registry(`egress.${shown.egress}`)}</dd>
          <dt className={kvTerm}>{t("impacts")}</dt>
          <dd className={`${kvValue} ${mono}`}>
            {shown.impacts.length === 0 ? t("none") : shown.impacts.join(", ")}
          </dd>
        </dl>
      )}
      {staged !== undefined ? (
        <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Badge tone="approval" data-testid="studio-panel-staged">
            {t("staged")}
          </Badge>
        </p>
      ) : null}
      {suggestion === null ? null : (
        <p
          className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground"
          data-testid="studio-panel-suggested"
        >
          <Badge tone="quiet">{t("suggested")}</Badge>
          {suggestion.basis === null ? null : t(`basis.${suggestion.basis}`)}
        </p>
      )}
      {canEdit && !imported ? (
        <p className={fieldHint}>{t("importFirst")}</p>
      ) : null}
      {canEdit && imported ? (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              {t("risk")}
              <select
                value={choice.risk}
                onChange={(event) => {
                  const parsed = ToolRiskGrade.safeParse(event.target.value);
                  setChoice({ ...choice, risk: parsed.success ? parsed.data : "" });
                }}
                className={inputBase}
              >
                <option value="">{t("choose")}</option>
                {ToolRiskGrade.options.map((value) => (
                  <option key={value} value={value}>
                    {registry(`risk.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              {t("sideEffect")}
              <select
                value={choice.sideEffect}
                onChange={(event) => {
                  const parsed = ToolSideEffect.safeParse(event.target.value);
                  setChoice({
                    ...choice,
                    sideEffect: parsed.success ? parsed.data : "",
                  });
                }}
                className={inputBase}
              >
                <option value="">{t("choose")}</option>
                {ToolSideEffect.options.map((value) => (
                  <option key={value} value={value}>
                    {registry(`sideEffect.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              {t("egress")}
              <select
                value={choice.egress}
                onChange={(event) => {
                  const parsed = ToolEgress.safeParse(event.target.value);
                  setChoice({
                    ...choice,
                    egress: parsed.success ? parsed.data : "",
                  });
                }}
                className={inputBase}
              >
                <option value="">{t("choose")}</option>
                {ToolEgress.options.map((value) => (
                  <option key={value} value={value}>
                    {registry(`egress.${value}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestion === null ? null : (
              <button
                type="button"
                className={buttonSecondary}
                data-testid="studio-panel-confirm"
                onClick={() => {
                  onStage({
                    kind: "classify",
                    tool: tool.name,
                    risk: suggestion.risk,
                    sideEffect: suggestion.sideEffect,
                    egress: suggestion.egress,
                    impacts: [...suggestion.impacts],
                  });
                  setChoice(choiceOf(suggestion));
                }}
              >
                {t("confirm")}
              </button>
            )}
            <button
              type="button"
              className={buttonSecondary}
              disabled={!complete || unchanged}
              data-testid="studio-panel-stage-classification"
              onClick={stageChoice}
            >
              {t("stage")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Description({
  serverId,
  tool,
  ops,
  canEdit,
  onStage,
  draft,
}: {
  serverId: string;
  tool: StudioTool;
  ops: readonly DraftOp[];
  canEdit: boolean;
  onStage: (op: DraftOp) => void;
  draft: DraftDescription;
}) {
  const t = useTranslations("mcpStudio.panel");
  const id = useId();
  const staged = stagedDescription(tool.name, ops);
  const [text, setText] = useState(staged ?? tool.description ?? "");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: "none" }
    | { kind: "not_built"; gap: string }
    | { kind: "failed"; message: string }
    /** The call threw, so no answer came back. */
    | { kind: "error" }
  >({ kind: "none" });
  const imported = importedAfter(tool, ops);
  const trimmed = text.trim();
  const runDraft = async () => {
    setPending(true);
    setOutcome({ kind: "none" });
    try {
      const result = await draft({ serverId, tool: tool.name });
      if (result.ok) {
        setText(result.description);
        return;
      }
      setOutcome(
        result.reason === "not_built"
          ? { kind: "not_built", gap: studioGapRef(result.gap) }
          : { kind: "failed", message: result.message },
      );
    } catch {
      setOutcome({ kind: "error" });
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-labelledby={`${id}-h`} className={section}>
      <h3 id={`${id}-h`} className={heading}>
        {t("description")}
      </h3>
      {canEdit && imported ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-text`} className="sr-only">
            {t("description")}
          </label>
          <textarea
            id={`${id}-text`}
            value={text}
            maxLength={DESCRIPTION_MAX}
            rows={4}
            onChange={(event) => {
              setText(event.target.value);
            }}
            className={inputBase}
            data-testid="studio-panel-description"
          />
          <p className={fieldHint}>{t("draftHint")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonSecondary}
              disabled={pending}
              aria-busy={pending}
              data-testid="studio-panel-draft"
              onClick={() => {
                void runDraft();
              }}
            >
              {t("draft")}
            </button>
            <button
              type="button"
              className={buttonSecondary}
              disabled={
                trimmed === "" || trimmed === (staged ?? tool.description ?? "")
              }
              data-testid="studio-panel-stage-description"
              onClick={() => {
                onStage({ kind: "describe", tool: tool.name, description: trimmed });
              }}
            >
              {t("stage")}
            </button>
            {staged !== undefined ? (
              <Badge tone="approval">{t("staged")}</Badge>
            ) : null}
          </div>
          {outcome.kind === "not_built" ? (
            <p
              role="status"
              data-state="not-built"
              data-gap={outcome.gap}
              data-testid="studio-panel-draft-not-built"
              className={note}
            >
              {t("draftNotBuilt")}
            </p>
          ) : null}
          {outcome.kind === "failed" ? (
            <p role="alert" className={note}>
              {t("draftFailed", { message: outcome.message })}
            </p>
          ) : null}
          {outcome.kind === "error" ? (
            <p
              role="alert"
              data-testid="studio-panel-draft-error"
              className={note}
            >
              {t("draftError")}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-[13px] text-foreground">
          {staged ?? tool.description ?? t("none")}
        </p>
      )}
    </section>
  );
}

function Shaping({ tool }: { tool: StudioTool }) {
  const t = useTranslations("mcpStudio.panel");
  const id = useId();
  const shaping = tool.shaping;
  return (
    <section aria-labelledby={`${id}-h`} className={section}>
      <h3 id={`${id}-h`} className={heading}>
        {t("shaping")}
      </h3>
      {shaping === null ? (
        <StudioNotRecorded gap="record" testId="studio-panel-shaping-missing">
          {t("shapingMissing")}
        </StudioNotRecorded>
      ) : (
        <>
          <dl className={kvList} data-testid="studio-panel-shaping">
            <dt className={kvTerm}>{t("hidden")}</dt>
            <dd className={`${kvValue} ${mono}`}>
              {shaping.hide.length === 0 ? t("none") : shaping.hide.join(", ")}
            </dd>
            <dt className={kvTerm}>{t("fixed")}</dt>
            <dd className={kvValue}>
              {shaping.fixed.length === 0 ? (
                t("none")
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {shaping.fixed.map((input) => (
                    <li key={input.name} className={mono}>
                      {input.name}
                      {" = "}
                      {input.value}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt className={kvTerm}>{t("returns")}</dt>
            <dd className={`${kvValue} ${mono}`}>
              {shaping.select.length === 0
                ? t("whole")
                : shaping.select.join(", ")}
            </dd>
          </dl>
          {shaping.selection === null ? null : (
            <CodeBlock code={shaping.selection} label={t("selection")} />
          )}
        </>
      )}
    </section>
  );
}

function ServerSays({ tool }: { tool: StudioTool }) {
  const t = useTranslations("mcpStudio.panel");
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className={section}>
      <h3 id={`${id}-h`} className={heading}>
        {t("server")}
      </h3>
      {tool.serverDescription === null ? (
        <StudioNotRecorded gap="record" testId="studio-panel-server-missing">
          {t("serverMissing")}
        </StudioNotRecorded>
      ) : (
        <p className="text-[13px] text-foreground">{tool.serverDescription}</p>
      )}
      {tool.annotations.length === 0 ? null : (
        <ul
          aria-label={t("annotations")}
          className="flex flex-wrap gap-1.5"
          data-testid="studio-panel-annotations"
        >
          {tool.annotations.map((annotation) => (
            <li key={annotation}>
              <Badge tone="quiet" dot={false} mono>
                {annotation}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Feedback({ tool }: { tool: StudioTool }) {
  const t = useTranslations("mcpStudio.panel");
  const locale = useLocale();
  const id = useId();
  const feedback = tool.feedback;
  return (
    <section aria-labelledby={`${id}-h`} className={section}>
      <h3 id={`${id}-h`} className={heading}>
        {t("feedback")}
      </h3>
      {feedback === null ? (
        <StudioNotRecorded gap="record" testId="studio-panel-feedback-missing">
          {t("feedbackMissing")}
        </StudioNotRecorded>
      ) : (
        <>
          <dl className={kvList} data-testid="studio-panel-feedback">
            <dt className={kvTerm}>{t("calls")}</dt>
            <dd className={kvValue}>{formatCount(feedback.calls, locale)}</dd>
            <dt className={kvTerm}>{t("schemaRejections")}</dt>
            <dd className={kvValue}>
              {formatCount(feedback.schemaRejections, locale)}
            </dd>
            <dt className={kvTerm}>{t("errorResults")}</dt>
            <dd className={kvValue}>
              {formatCount(feedback.errorResults, locale)}
            </dd>
            <dt className={kvTerm}>{t("retries")}</dt>
            <dd className={kvValue}>{formatCount(feedback.retries, locale)}</dd>
          </dl>
          {feedback.notes.length === 0 ? null : (
            <ul
              aria-label={t("notes")}
              className="flex flex-col gap-1.5 text-[13px] text-foreground"
            >
              {[...new Set(feedback.notes)].map((text) => (
                <li key={text} className={note}>
                  {text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function ToolPanel({
  serverId,
  tool,
  ops,
  canEdit,
  onStage,
  off,
  offFacts,
  open,
  onOpenChange,
  draft = draftDescription,
}: {
  serverId: string;
  tool: StudioTool;
  ops: readonly DraftOp[];
  canEdit: boolean;
  /** Stage an edit; false when the draft refused it for passing its limits. */
  onStage: (op: DraftOp) => boolean;
  /** The tool's off switch toggle, drawn on the server; absent for a tool with no version. */
  off: ReactNode;
  /** Who turned the tool off or back on, and when. */
  offFacts: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Draft's capability; the not-built stub until PR2 of #4678. */
  draft?: DraftDescription;
}) {
  const t = useTranslations("mcpStudio.panel");
  const id = useId();
  const [refused, setRefused] = useState(false);
  const stage = (op: DraftOp): void => {
    setRefused(!onStage(op));
  };
  return (
    <SheetDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tool.name}
      wide
      testId="studio-tool-panel"
    >
      <div className="flex flex-col gap-4">
        {refused ? (
          <FormAlert testId="studio-panel-refused">{t("refused")}</FormAlert>
        ) : null}
        <Classification
          tool={tool}
          ops={ops}
          canEdit={canEdit}
          onStage={stage}
        />
        <Description
          serverId={serverId}
          tool={tool}
          ops={ops}
          canEdit={canEdit}
          onStage={stage}
          draft={draft}
        />
        <Shaping tool={tool} />
        <ServerSays tool={tool} />
        <Feedback tool={tool} />
        <section aria-labelledby={`${id}-off`} className={section}>
          <h3 id={`${id}-off`} className={heading}>
            {t("off")}
          </h3>
          {tool.versionId === null ? (
            <p className="text-[13px] text-muted-foreground">{t("offNone")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {off}
              {offFacts}
            </div>
          )}
        </section>
      </div>
    </SheetDialog>
  );
}
