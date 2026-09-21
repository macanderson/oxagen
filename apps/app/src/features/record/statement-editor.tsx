"use client";
// The statement editor and the proposal it opens (#3395; mockups/pages/record.md).
//
// The editor holds the statement and nothing else. The lineage, the kind, the
// force and the scope are the rest of the file, and each is changed the same
// way: through `propose_record`, not here. Widening this box to the whole
// file would let a reader change a record's kind in a field labelled
// "statement", which is the one edit the checks cannot catch as a mistake.
//
// **Nothing here writes a row.** Discard returns the draft to what is in
// force. Propose a change opens the dialog, which calls
// `revise_context_record`: it raises a proposal carrying the kind, force,
// effect and scope unchanged, commits the record's file to a branch of its
// own, opens the pull request and runs the six §10.3 checks. The record in
// force does not move until somebody merges that pull request, and the header
// shows the open branch until they do.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useMemo, useState } from "react";
import { diffStat } from "@/shared/line-diff";
import { buttonGold, buttonSecondary, mono, panel } from "@/ui/control-styles";
import { CodeEditor } from "@/ui/code-editor";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useReviseFailure } from "./revise-failure";
import { reviseRecord } from "./actions";
import { recordLink, type RecordAt } from "./view";

/** The six §10.3 checks the pull request runs, in the order they run. */
const CHECKS = [
  "schema",
  "lineage_uniqueness",
  "record_hash",
  "secret_pii_scan",
  "conflict_against_active",
  "constraint_effect",
] as const;

/**
 * What the action answered: the Context PR's state, and its pull request when
 * one opened. The type is read off `reviseRecord` rather than restated, so the
 * status stays a union of the seven proposal states and `status.<state>` stays
 * a checked message key.
 */
type Opened = Extract<
  Awaited<ReturnType<typeof reviseRecord>>,
  { ok: true }
>["value"];

/** Ln and Col of the caret, 1-based, as the status line prints them. */
function caretAt(value: string, index: number): { line: number; col: number } {
  const before = value.slice(0, index);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, col: before.length - lastBreak };
}

function ProposeDialog({
  open,
  onOpenChange,
  at,
  base,
  draft,
  stat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  at: RecordAt;
  base: string;
  draft: string;
  stat: { added: number; removed: number };
}) {
  const t = useTranslations("record.propose");
  const failureText = useReviseFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);

  function openChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setFailure(null);
      setOpened(null);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const rationale = form.get("rationale");
    setPending(true);
    setFailure(null);
    try {
      const result = await reviseRecord(
        at.org,
        at.ws,
        at.lineage,
        draft,
        typeof rationale === "string" ? rationale : "",
      );
      if (result.ok) setOpened(result.value);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <SheetDialog
      open={open}
      onOpenChange={openChange}
      title={t("title")}
      subtitle={at.lineage}
      wide
      testId="record-propose"
    >
      {opened === null ? (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("diff", stat)}</p>
          {failure === null ? null : (
            <FormAlert testId="record-propose-failure">{failure}</FormAlert>
          )}
          <Diff base={base} draft={draft} />
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">
              {t("rationale")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("rationaleHint")}
            </span>
            <textarea
              name="rationale"
              rows={3}
              maxLength={4000}
              className="block w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-input-fg focus-visible:border-input-border-focus focus-visible:outline-2 focus-visible:outline-input-ring"
            />
          </label>
          <section
            aria-label={t("checksLabel")}
            className="flex flex-col gap-1"
          >
            <p className="text-sm text-muted-foreground">{t("checksLead")}</p>
            <ul className="flex flex-wrap gap-1.5">
              {CHECKS.map((check) => (
                <li
                  key={check}
                  data-check={check}
                  className={`${mono} rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground`}
                >
                  {check}
                </li>
              ))}
            </ul>
          </section>
          <SubmitButton
            pending={pending}
            label={t("submit")}
            pendingLabel={t("pending")}
          />
        </form>
      ) : (
        <div
          role="status"
          data-testid="record-propose-done"
          className="flex flex-col gap-2 text-sm"
        >
          <p>
            {opened.prNumber === null
              ? t("doneNoPr")
              : t("done", { number: opened.prNumber })}
          </p>
          <p className="text-muted-foreground">
            {t(`status.${opened.status}`)}
          </p>
          <p className="text-muted-foreground">{t("notInForce")}</p>
          <SafeLink to={recordLink(at)} className={buttonSecondary}>
            {t("reload")}
          </SafeLink>
        </div>
      )}
    </SheetDialog>
  );
}

/**
 * The statement diff, line by line against what is in force.
 *
 * A record's statement is a few lines, so the whole of both sides is shown
 * rather than a window around the change: a reader approving a wording change
 * should see the wording, not a hunk header.
 */
/**
 * One side of the diff, each line carrying a key of its own. Two identical
 * lines in a statement are two different lines, so the key is the side and
 * the line's place in it, not the text.
 */
function numbered(side: "removed" | "added", value: string) {
  return value.split("\n").map((text, index) => ({
    key: `${side}-${String(index)}`,
    text,
  }));
}

function Diff({ base, draft }: { base: string; draft: string }) {
  const t = useTranslations("record.propose");
  const removed = numbered("removed", base);
  const added = numbered("added", draft);
  return (
    <div
      data-testid="record-diff"
      className={`${mono} flex flex-col overflow-hidden rounded-md border border-border text-xs`}
    >
      <p className="sr-only">{t("diffLabel")}</p>
      {removed.map((line) => (
        <span
          key={line.key}
          data-side="removed"
          className="whitespace-pre-wrap border-b border-border bg-destructive/10 px-2 py-1 text-foreground"
        >
          {`- ${line.text}`}
        </span>
      ))}
      {added.map((line) => (
        <span
          key={line.key}
          data-side="added"
          className="whitespace-pre-wrap bg-success/10 px-2 py-1 text-foreground"
        >
          {`+ ${line.text}`}
        </span>
      ))}
    </div>
  );
}

export function StatementEditor({
  at,
  path,
  statement,
  canWrite,
  pendingBranch,
}: {
  at: RecordAt;
  /** `.oxagen/rules/<lineage>.toml · statement`. */
  path: string;
  /** The statement in force; null on a record whose file carries none. */
  statement: string | null;
  /** Whether this viewer's role may open a proposal at all. */
  canWrite: boolean;
  /** The branch of a proposal already open against this lineage, if any. */
  pendingBranch: string | null;
}) {
  const t = useTranslations("record.editor");
  const base = statement ?? "";
  const [draft, setDraft] = useState(base);
  const [caret, setCaret] = useState(0);
  const [proposing, setProposing] = useState(false);
  const stat = useMemo(() => diffStat(base, draft), [base, draft]);
  const dirty = draft.trim() !== base.trim() && draft.trim() !== "";
  const position = caretAt(draft, Math.min(caret, draft.length));

  return (
    <section aria-label={path} className={`${panel} flex flex-col`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-sm">
        <span className={`${mono} min-w-0 break-all`}>{path}</span>
        <span data-testid="draft-state" className="text-muted-foreground">
          {dirty ? t("modified") : t("unchanged")}
        </span>
        {dirty ? (
          <span data-testid="draft-stat" className={`${mono} text-xs`}>
            {t("stat", stat)}
          </span>
        ) : null}
        <span className="flex flex-1 flex-wrap justify-end gap-2">
          <button
            type="button"
            className={buttonSecondary}
            disabled={draft === base}
            onClick={() => {
              setDraft(base);
            }}
          >
            {t("discard")}
          </button>
          {/* The page's one gold action. Gold is identity, so it marks the
              act this page exists for and never a state. */}
          <button
            type="button"
            data-testid="record-propose-open"
            className={buttonGold}
            disabled={!dirty || !canWrite || pendingBranch !== null}
            onClick={() => {
              setProposing(true);
            }}
          >
            {t("propose")}
          </button>
        </span>
      </div>
      {canWrite ? null : (
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {t("readOnly")}
        </p>
      )}
      {pendingBranch === null ? null : (
        <p
          data-testid="record-pending-note"
          className="px-4 pt-3 text-xs text-muted-foreground"
        >
          {t("pending", { branch: pendingBranch })}
        </p>
      )}
      <div className="p-4">
        <CodeEditor
          value={draft}
          onChange={setDraft}
          onCaret={setCaret}
          language="text"
          label={path}
          minRows={6}
        />
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <span className={mono} data-testid="record-caret">
          {t("caret", position)}
        </span>
        <span>{t("counts", countsOf(draft))}</span>
        {/* The compiled bundle's token budget is held per bundle version and
            no read the app may make carries it, so the record's share of it
            is named as not recorded rather than guessed from the text. */}
        <span data-state="not-recorded">{t("tokenCost")}</span>
      </div>
      <ProposeDialog
        open={proposing}
        onOpenChange={setProposing}
        at={at}
        base={base}
        draft={draft}
        stat={stat}
      />
    </section>
  );
}

function countsOf(draft: string): { lines: number; characters: number } {
  return { lines: draft.split("\n").length, characters: draft.length };
}
