"use client";
// The pieces every creation wizard is built from (roadmap creation-spec §2;
// mockup `wzRail`, `wzDesc`, `wzDraftNote`, `wzFiles`, `wzChecks`,
// `wzPrStep`). A kind module composes its steps out of these, so the agent,
// context record and tool wizards read the same as the skill wizard without
// copying it.
import { Check, GitPullRequestArrow, Sparkles } from "lucide-react";
import { SourceFilename } from "@/ui/source-filename";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { buttonSecondary, mono, panel } from "@/ui/control-styles";
import { type DraftApi, railOf, type StepId } from "./wizard";

/** The step rail: every step, the one you are on in gold, the ones behind you ticked. */
export function Rail({
  steps,
  current,
}: {
  steps: readonly StepId[];
  current: number;
}) {
  const t = useTranslations("create");
  return (
    <ol
      aria-label={t("rail")}
      data-testid="wizard-rail"
      className="mb-4 flex flex-wrap gap-1.5"
    >
      {railOf(steps, current).map((s) => (
        <li
          key={s.id}
          data-state={s.state}
          aria-current={s.state === "current" ? "step" : undefined}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-muted/40 py-0.5 pl-1 pr-3 text-xs text-muted-foreground data-[state=current]:border-brand data-[state=current]:text-foreground"
        >
          <span
            aria-hidden="true"
            className={`grid size-[18px] place-items-center rounded-full border text-[10.5px] font-bold ${
              s.state === "current"
                ? "border-brand bg-brand text-brand-foreground"
                : s.state === "done"
                  ? "border-success text-success"
                  : "border-border bg-card"
            }`}
          >
            {s.state === "done" ? <Check className="size-2.5" /> : s.n}
          </span>
          <span>{t(`steps.${s.id}`)}</span>
          {s.state === "done" ? (
            <span className="sr-only">{t("railDone")}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

type Described = { desc: string };

/**
 * The description field (mockup `wzDesc` and `wzDescIn`). The textarea is
 * uncontrolled: typing writes the draft and re-renders only when the text
 * goes from empty to filled or back, which is the one change the step's gold
 * control keys on. A suggestion chip replaces the text, so it remounts the
 * field with the new value.
 */
export function DescriptionField({
  api,
  placeholder,
  hint,
  suggestions = [],
}: {
  api: DraftApi<Described>;
  placeholder: string;
  hint?: ReactNode;
  suggestions?: readonly string[];
}) {
  const t = useTranslations("create");
  const [seed, setSeed] = useState(0);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="wizard-desc" className="text-sm font-medium">
        {t("describe.label")}
      </label>
      <textarea
        key={seed}
        id="wizard-desc"
        data-testid="wizard-desc"
        rows={4}
        defaultValue={api.draft.desc}
        placeholder={placeholder}
        aria-describedby={hint ? "wizard-desc-hint" : undefined}
        onInput={(event) => {
          const value = event.currentTarget.value;
          const was = api.draft.desc.trim() !== "";
          api.write({ desc: value });
          if ((value.trim() !== "") !== was) api.update({});
        }}
        className="block w-full min-w-0 rounded-md border border-input-border bg-input-bg px-3 py-2.5 text-sm text-input-fg placeholder:text-input-placeholder focus-visible:border-input-border-focus focus-visible:outline-2 focus-visible:outline-input-ring"
      />
      {hint ? (
        <p id="wizard-desc-hint" className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className={`${buttonSecondary} min-h-8 px-3 py-1 text-xs`}
              onClick={() => {
                api.update({ desc: s });
                setSeed((n) => n + 1);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What stands above a drafted file: who drafted it, and that every line is
 * the operator's to change before anybody reviews it. Every drafting step
 * carries it (creation-spec §1).
 */
export function DraftNote({ title, body }: { title: string; body: string }) {
  return (
    <div
      data-testid="draft-note"
      className="mb-3 flex items-start gap-3 rounded-lg border border-border border-l-2 border-l-brand bg-muted/40 px-3.5 py-3"
    >
      <Sparkles
        aria-hidden="true"
        className="mt-0.5 size-4 flex-none text-muted-foreground"
      />
      <div className="flex flex-col gap-0.5 text-sm">
        <p className="font-semibold text-foreground">{title}</p>
        <p className="text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

/** A choice card on a first step: one way in, pressed when chosen. */
export function OptionCard({
  title,
  body,
  pressed,
  disabled = false,
  note,
  onPress,
}: {
  title: string;
  body: ReactNode;
  pressed: boolean;
  disabled?: boolean;
  /** Why a disabled way in is closed. */
  note?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onPress}
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-3.5 text-left text-sm transition-colors hover:border-input-border-hover aria-pressed:border-brand disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="font-semibold text-foreground">{title}</span>
      <span className="text-muted-foreground">{body}</span>
      {note ? (
        <span className="text-xs text-muted-foreground">{note}</span>
      ) : null}
    </button>
  );
}

/**
 * A file in a source editor: a gutter of line numbers beside the text. The
 * textarea holds the file itself, so what the pull request commits is the
 * bytes the operator saw.
 */
export function FileEditor({
  path,
  rename,
  value,
  onChange,
  bar,
}: {
  path: string;
  rename?: { name: string; onRename: (name: string) => boolean };
  value: string;
  onChange: (value: string) => void;
  /** Controls on the editor's bar, beside the path. */
  bar?: ReactNode;
}) {
  const lines = value.split("\n").length;
  return (
    <section aria-label={path} className={`${panel} flex flex-col`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        {rename ? (
          <SourceFilename path={path} {...rename} />
        ) : (
          <span className={`${mono} min-w-0 flex-1 break-all`}>{path}</span>
        )}
        {bar}
      </div>
      <div className="flex max-h-80 overflow-auto p-3 font-mono text-[12.5px] leading-5">
        <pre
          aria-hidden="true"
          className="select-none pr-3 text-right text-muted-foreground"
        >
          {Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n")}
        </pre>
        <textarea
          aria-label={path}
          data-testid="wizard-file"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          rows={Math.max(lines, 12)}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 resize-none bg-transparent leading-5 text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
        />
      </div>
    </section>
  );
}

export type PlannedFile = {
  change: "add" | "modify";
  path: string;
  note: string;
};

/**
 * The pull request every wizard ends on (mockup `wzPrStep`): the base branch
 * of the main repository, the branch it comes from, the files, and what the
 * checks will assert.
 */
export function PullRequestPlan({
  lead,
  base,
  branch,
  files,
  checks,
}: {
  lead: ReactNode;
  /** `owner/name` and its production branch, or null while it is unknown. */
  base: string | null;
  branch: string;
  files: readonly PlannedFile[];
  checks: readonly { name: string; detail: ReactNode }[];
}) {
  const t = useTranslations("create.pr");
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>{lead}</p>
      <div className={`${panel} overflow-hidden`}>
        <p className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <GitPullRequestArrow aria-hidden="true" className="size-3.5" />
          <span className={`${mono} text-foreground`}>
            {base ?? t("unknownBase")}
          </span>
          <span aria-hidden="true">←</span>
          <span className="sr-only">{t("from")}</span>
          <span data-testid="pr-branch" className={`${mono} text-foreground`}>
            {branch}
          </span>
        </p>
        <ul aria-label={t("files")} className="divide-y divide-border">
          {files.map((f) => (
            <li
              key={f.path}
              data-change={f.change}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2"
            >
              <span aria-hidden="true" className={`${mono} w-3 text-center`}>
                {f.change === "add" ? "+" : "~"}
              </span>
              <span className="sr-only">{t(`change.${f.change}`)}</span>
              <span className={`${mono} min-w-0 break-all`}>{f.path}</span>
              <span className="text-xs text-muted-foreground">{f.note}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="font-medium">{t("checks")}</p>
        <ul className="flex flex-col gap-1.5">
          {checks.map((c) => (
            <li
              key={c.name}
              className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[8rem_1fr] sm:gap-3"
            >
              <span className="font-medium text-foreground">{c.name}</span>
              <span className="text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
