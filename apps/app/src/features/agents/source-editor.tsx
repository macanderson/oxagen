"use client";
// The agent source page's body (spec pages/agent-source.md): the header with
// the file path, its chips and the three actions, then the editor panel with
// its bar, the gutter and textarea, and the status line; and the commit
// dialog both this page and the Definition tab's form open.
//
// The draft is the one the form edits too (`draft-store.ts`), so a change made
// on either survives moving between them until it is discarded or committed.
// The TOML is parsed on every edit with the shared subset and a line it
// cannot read is named. Save opens the commit dialog, which commits the draft
// to a branch and opens its pull request through `commit_agent_definition`;
// the default branch is never written, and nothing lands in Postgres but the
// commit's cache.
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildDiff } from "@/shared/line-diff";
import type { SafePath } from "@/shared/safe-path";
import { parseTomlSubset } from "@/shared/toml-subset";
import { Badge } from "@/ui/badge";
import { CodeEditor } from "@/ui/code-editor";
import { DiffPanel } from "@/ui/code-panel";
import {
  buttonPrimary,
  buttonSecondary,
  eyebrow,
  inputBase,
  mono,
  panel,
} from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog, SheetFooterAction } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { commitAgentDefinition } from "./actions";
import { useDefinitionDraft } from "./draft-store";
import { NotBacked } from "./parts";
import {
  type Edit,
  findAll,
  indent,
  lineCol,
  outdent,
  toggleComment,
} from "./source-keys";

type Committed = {
  branch: string;
  commitSha: string;
  pullRequest: { number: number; url: string };
};

const NEW_BRANCH = "+new";

/** The commit sheet: the diff, the branch, the summary, and the pull request. Shared with the Definition tab's form. */
export function CommitDialog({
  open,
  onOpenChange,
  org,
  ws,
  agentId,
  path,
  branch,
  base,
  draft,
  after,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  org: string;
  ws: string;
  agentId: string;
  path: string;
  /** The branch the last commit used, or the one proposed for a first commit. */
  branch: string;
  /** The file the draft is compared against. */
  base: string;
  draft: string;
  /** Reloaded after a commit, so the base becomes the committed file. */
  after: SafePath;
}) {
  const t = useTranslations("agents.source.commit");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const diff = useMemo(() => buildDiff(base, draft), [base, draft]);
  const [choice, setChoice] = useState(branch);
  const [newBranch, setNewBranch] = useState("");
  const [summary, setSummary] = useState("");
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState<
    "branch" | "message" | "source" | null
  >(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [committed, setCommitted] = useState<Committed | null>(null);
  const target = choice === NEW_BRANCH ? newBranch.trim() : choice;
  const ready = target !== "" && summary.trim() !== "";

  function openChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setInvalid(null);
      setFailure(null);
      setCommitted(null);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !ready) return;
    setPending(true);
    setInvalid(null);
    setFailure(null);
    try {
      const result = await commitAgentDefinition(org, ws, {
        agentId,
        branch: target,
        message: summary,
        source: draft,
      });
      if (result.ok) {
        setCommitted(result.value);
        navigate.replace(after);
      } else if (
        result.reason === "invalid" &&
        (result.field === "branch" ||
          result.field === "message" ||
          result.field === "source")
      ) {
        setInvalid(result.field);
      } else {
        setFailure(failureText(result));
      }
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
      subtitle={path}
      closeLabel={t("cancel")}
      wide
      testId="commit-definition"
    >
      {committed === null ? (
        <form
          id="commit-definition-form"
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          <DiffPanel diff={diff} path={path} label={t("diffLabel")} />
          {failure === null ? null : (
            <FormAlert testId="commit-failure">{failure}</FormAlert>
          )}
          {invalid === "source" ? (
            <FormAlert testId="commit-failure">{t("invalid.source")}</FormAlert>
          ) : null}
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor="commit-branch"
          >
            <span className="font-medium">{t("branch")}</span>
            <select
              id="commit-branch"
              value={choice}
              className={`${inputBase} max-md:text-base`}
              aria-invalid={invalid === "branch" ? true : undefined}
              onChange={(event) => {
                setChoice(event.target.value);
              }}
            >
              <option value={branch}>{branch}</option>
              <option value={NEW_BRANCH}>{t("newBranch")}</option>
            </select>
            <span className="text-xs text-muted-foreground">
              {t("branchHint")}
            </span>
          </label>
          {choice === NEW_BRANCH ? (
            <Field
              id="commit-new-branch"
              name="branch"
              label={t("newBranchName")}
              value={newBranch}
              onChange={(event) => {
                setNewBranch(event.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
              required
              error={invalid === "branch" ? t("invalid.branch") : undefined}
            />
          ) : invalid === "branch" ? (
            <FormAlert testId="commit-failure">{t("invalid.branch")}</FormAlert>
          ) : null}
          <Field
            id="commit-summary"
            name="message"
            label={t("summary")}
            hint={t("summaryHint")}
            value={summary}
            onChange={(event) => {
              setSummary(event.target.value);
            }}
            maxLength={200}
            required
            error={invalid === "message" ? t("invalid.message") : undefined}
          />
          <NotBacked gap="commit_description">{t("description")}</NotBacked>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked disabled className="mt-1 size-4" />
            <span className="flex flex-col">
              <span>{t("pullRequestBox")}</span>
              <span className="text-xs text-muted-foreground">
                {t("pullRequestHint")}
              </span>
            </span>
          </label>
          <SheetFooterAction>
            <button
              type="submit"
              form="commit-definition-form"
              className={buttonPrimary}
              disabled={!ready || pending}
              data-touch-target=""
            >
              {pending ? t("pending") : t("submit")}
            </button>
          </SheetFooterAction>
        </form>
      ) : (
        <div
          role="status"
          data-testid="commit-done"
          className="flex flex-col gap-2 text-sm"
        >
          <p>
            {t("done", {
              commit: committed.commitSha,
              branch: committed.branch,
            })}
          </p>
          <p className={`${mono} break-all text-xs`}>
            {t("pullRequest", {
              number: committed.pullRequest.number,
              url: committed.pullRequest.url,
            })}
          </p>
        </div>
      )}
    </SheetDialog>
  );
}

/** Keys that only modify the next key, and so end no find jump. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

export function SourceEditor({
  org,
  ws,
  agentId,
  agentKey,
  slug,
  path,
  base,
  branch,
  commit,
  repository,
  back,
  after,
}: {
  org: string;
  ws: string;
  agentId: string;
  agentKey: string | null;
  /** The registered identity slug, which definition commits cannot change. */
  slug: string;
  /** `.oxagen/agents/<slug>.toml`. */
  path: string;
  /** The committed file, or the seed an agent with no committed file starts from. */
  base: string;
  /** The branch the last commit used, or the one proposed for a first commit. */
  branch: string;
  /** The commit the base is, or null before the first commit. */
  commit: string | null;
  /** `owner/repo` of the last commit, or null when none is recorded. */
  repository: string | null;
  /** The agent's Definition tab. */
  back: SafePath;
  /** This page, reloaded after a commit so the base is the committed file. */
  after: SafePath;
}) {
  const t = useTranslations("agents.source");
  const [draft, setDraft] = useDefinitionDraft(slug, base);
  const [committing, setCommitting] = useState(false);
  const [caret, setCaret] = useState(0);
  const [find, setFind] = useState("");
  const [current, setCurrent] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  // The match a find jump selected in the editor, or null once the person
  // does anything else there. While it is set, Enter and Shift+Enter in the
  // editor keep stepping through matches instead of typing a newline over
  // the selected match (#4035).
  const jumpedRef = useRef<{ start: number; end: number } | null>(null);
  const parsed = useMemo(() => parseTomlSubset(draft), [draft]);
  const matches = useMemo(() => findAll(draft, find), [draft, find]);
  const dirty = draft !== base;
  const matchesIdentity = parsed.ok && parsed.doc.slug === slug;
  const position = lineCol(draft, caret);

  function apply(edit: Edit) {
    setDraft(edit.value);
    setCaret(edit.start);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(edit.start, edit.end);
    });
  }

  function jump(direction: 1 | -1) {
    if (matches.length === 0) return;
    const index =
      current === null
        ? direction === 1
          ? 0
          : matches.length - 1
        : (current + direction + matches.length) % matches.length;
    const at = matches[index] ?? 0;
    setCurrent(index);
    setCaret(at);
    // The textarea paints no selection without focus, so the jump focuses it.
    jumpedRef.current = { start: at, end: at + find.length };
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(at, at + find.length);
  }

  /**
   * Keys that belong to the find while the editor still shows the match a jump
   * selected: Enter steps on, Shift+Enter steps back, Escape returns to the
   * find box. A click or a caret move changes the selection, which ends it.
   */
  function onFindKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    // A modifier pressed on its own, such as the Shift of Shift+Enter, is
    // part of the next key and leaves the jump in place.
    if (MODIFIER_KEYS.has(event.key)) return false;
    const jumped = jumpedRef.current;
    jumpedRef.current = null;
    if (jumped === null || event.nativeEvent.isComposing) return false;
    const { selectionStart, selectionEnd } = event.currentTarget;
    if (selectionStart !== jumped.start || selectionEnd !== jumped.end) {
      return false;
    }
    const mod = event.metaKey || event.ctrlKey || event.altKey;
    if (event.key === "Enter" && !mod) {
      event.preventDefault();
      jump(event.shiftKey ? -1 : 1);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      findInputRef.current?.focus();
      findInputRef.current?.select();
      return true;
    }
    return false;
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (onFindKey(event)) return;
    const mod = event.metaKey || event.ctrlKey;
    const {
      selectionStart: start,
      selectionEnd: end,
      value,
    } = event.currentTarget;
    const key = event.key.toLowerCase();
    if (mod && key === "s") {
      event.preventDefault();
      setCommitting(true);
    } else if (mod && key === "f") {
      event.preventDefault();
      findInputRef.current?.focus();
      findInputRef.current?.select();
    } else if (mod && event.key === "/") {
      event.preventDefault();
      apply(toggleComment(value, start, end));
    } else if (event.key === "Tab" && !mod) {
      event.preventDefault();
      apply(
        event.shiftKey ? outdent(value, start, end) : indent(value, start, end),
      );
    }
  }

  const chip = `${mono} text-[11px]`;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-source">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <p className={eyebrow}>{t("eyebrow")}</p>
          <h1 className="break-all font-mono text-lg font-bold text-foreground">
            {path}
          </h1>
          <ul
            aria-label={t("facts")}
            className="flex flex-wrap items-center gap-2"
          >
            <li>
              <Badge tone="quiet" dot={false}>
                <span className={chip}>{repository ?? t("noRepository")}</span>
              </Badge>
            </li>
            <li>
              <Badge tone="quiet" dot={false}>
                <span className={chip}>
                  {commit === null
                    ? t("uncommitted")
                    : t("branchAt", { branch, commit: commit.slice(0, 7) })}
                </span>
              </Badge>
            </li>
            <li>
              <Badge tone="quiet" dot={false}>
                {t("truth")}
              </Badge>
            </li>
            {agentKey === null ? null : (
              <li>
                <Badge tone="quiet" dot={false}>
                  <span className={chip}>{agentKey}</span>
                </Badge>
              </li>
            )}
          </ul>
          <p className="max-w-[70ch] text-[13px] text-muted-foreground">
            {t("lead")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <SafeLink to={back} className={buttonSecondary}>
            {t("back")}
          </SafeLink>
          <button
            type="button"
            className={buttonSecondary}
            disabled={!dirty}
            onClick={() => {
              setDraft(base);
            }}
          >
            {t("discard")}
          </button>
          <button
            type="button"
            className={buttonPrimary}
            disabled={!parsed.ok || !matchesIdentity}
            onClick={() => {
              setCommitting(true);
            }}
          >
            {t("save")}
          </button>
        </div>
      </header>
      {parsed.ok && !matchesIdentity ? (
        <FormAlert testId="source-slug-error">
          {t("identityMismatch", { slug })}
        </FormAlert>
      ) : null}
      {parsed.ok ? null : (
        <FormAlert testId="parse-error">
          {t("parse.error", {
            line: parsed.line,
            reason: t(`parse.reason.${parsed.code}`),
          })}
        </FormAlert>
      )}
      <section aria-label={path} className={`${panel} flex flex-col`}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-hl px-4 py-2.5 text-[13px]">
          <span className={`${mono} min-w-0 break-all`}>{path}</span>
          <span
            data-testid="draft-state"
            data-dirty={dirty ? "true" : "false"}
            className="inline-flex items-center gap-1.5 text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className={`size-2 rounded-full border ${dirty ? "border-info bg-info" : "border-border"}`}
            />
            {dirty ? t("modified") : t("unchanged")}
          </span>
          <label className="ml-auto flex items-center gap-2">
            <input
              ref={findInputRef}
              type="search"
              value={find}
              placeholder={t("find.placeholder")}
              aria-label={t("find.label")}
              className={`${inputBase} w-44 py-1 max-md:text-base`}
              onChange={(event) => {
                setFind(event.target.value);
                setCurrent(null);
                jumpedRef.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  jump(event.shiftKey ? -1 : 1);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setFind("");
                  setCurrent(null);
                  textareaRef.current?.focus();
                }
              }}
            />
            <span
              data-testid="find-count"
              aria-live="polite"
              className={`${mono} text-xs text-dim`}
            >
              {find === ""
                ? null
                : current === null
                  ? String(matches.length)
                  : t("find.of", {
                      index: current + 1,
                      count: matches.length,
                    })}
            </span>
          </label>
        </div>
        <CodeEditor
          value={draft}
          onChange={setDraft}
          language="toml"
          label={path}
          onCaret={setCaret}
          onKeyDown={onKey}
          textareaRef={textareaRef}
        />
        <div
          data-testid="editor-status"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[11.5px] text-muted-foreground"
        >
          <span data-testid="caret">
            {t("position", { line: position.line, col: position.col })}
          </span>
          <span>{t("format")}</span>
          <span>{t("spaces")}</span>
          <span>{t("lineEndings")}</span>
          <span>{t("encoding")}</span>
          <span className="ml-auto text-dim">{t("keys")}</span>
        </div>
      </section>
      <CommitDialog
        open={committing}
        onOpenChange={setCommitting}
        org={org}
        ws={ws}
        agentId={agentId}
        path={path}
        branch={branch}
        base={base}
        draft={draft}
        after={after}
      />
    </div>
  );
}
