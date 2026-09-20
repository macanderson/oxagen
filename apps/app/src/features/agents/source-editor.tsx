"use client";
// The definition file in a source editor (mockup `pAgentSource`): the shared
// CodeEditor, syntax-coloured and parsed on every edit with the shared TOML
// subset so a line the editor cannot read is named; modified or unchanged
// against the base with a line diff stat; Discard back to the base; Save opens
// the commit dialog, which commits the draft to a branch and opens its pull
// request. The default branch is never written, and nothing is written to
// Postgres but the commit's cache.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useMemo, useState } from "react";
import { diffStat } from "@/shared/line-diff";
import type { SafePath } from "@/shared/safe-path";
import { parseTomlSubset } from "@/shared/toml-subset";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
} from "@/ui/control-styles";
import { CodeEditor } from "@/ui/code-editor";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { commitAgentDefinition } from "./actions";

type Committed = {
  branch: string;
  commitSha: string;
  pullRequest: { number: number; url: string };
};

const FIELDS = ["branch", "message", "source"] as const;

/** A text field of the submitted form; absent reads as empty. */
function textOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The commit sheet: the draft to a branch and its pull request. Shared with the Configuration form. */
export function CommitDialog({
  open,
  onOpenChange,
  org,
  ws,
  agentId,
  path,
  branch,
  draft,
  stat,
  after,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  org: string;
  ws: string;
  agentId: string;
  path: string;
  branch: string;
  draft: string;
  stat: { added: number; removed: number };
  after: SafePath;
}) {
  const t = useTranslations("agents.source.commit");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState<(typeof FIELDS)[number] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [committed, setCommitted] = useState<Committed | null>(null);

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
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setInvalid(null);
    setFailure(null);
    try {
      const result = await commitAgentDefinition(org, ws, {
        agentId,
        branch: textOf(form, "branch"),
        message: textOf(form, "message"),
        source: draft,
      });
      if (result.ok) {
        setCommitted(result.value);
        navigate.replace(after);
      } else if (result.reason === "invalid") {
        const field = FIELDS.find((name) => name === result.field) ?? null;
        setInvalid(field);
        if (field === null) setFailure(failureText(result));
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
      title={t("title", { path })}
      testId="commit-definition"
    >
      {committed === null ? (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("diff", stat)}</p>
          {failure === null ? null : (
            <FormAlert testId="commit-failure">{failure}</FormAlert>
          )}
          {invalid === "source" ? (
            <FormAlert testId="commit-failure">{t("invalid.source")}</FormAlert>
          ) : null}
          <Field
            id="commit-branch"
            name="branch"
            label={t("branch")}
            hint={t("branchHint")}
            defaultValue={branch}
            autoComplete="off"
            spellCheck={false}
            required
            error={invalid === "branch" ? t("invalid.branch") : undefined}
          />
          <Field
            id="commit-message"
            name="message"
            label={t("message")}
            hint={t("messageHint")}
            maxLength={200}
            error={invalid === "message" ? t("invalid.message") : undefined}
          />
          <SubmitButton
            pending={pending}
            label={t("submit")}
            pendingLabel={t("pending")}
          />
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

export function SourceEditor({
  org,
  ws,
  agentId,
  slug,
  path,
  base,
  branch,
  back,
  after,
}: {
  org: string;
  ws: string;
  agentId: string;
  /** The registered identity slug, which definition commits cannot change. */
  slug: string;
  /** `.oxagen/agents/<slug>.toml`. */
  path: string;
  /** The committed file, or the seed an agent with no committed file starts from. */
  base: string;
  /** The branch the commit dialog proposes. */
  branch: string;
  /** The agent's Definition section. */
  back: SafePath;
  /** This page, reloaded after a commit so the base is the committed file. */
  after: SafePath;
}) {
  const t = useTranslations("agents.source");
  const [draft, setDraft] = useState(base);
  const [committing, setCommitting] = useState(false);
  const parsed = useMemo(() => parseTomlSubset(draft), [draft]);
  const stat = useMemo(() => diffStat(base, draft), [base, draft]);
  const dirty = draft !== base;
  const matchesIdentity = parsed.ok && parsed.doc.slug === slug;

  return (
    <section aria-label={path} className={`${panel} flex flex-col`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-sm">
        <span className={`${mono} break-all`}>{path}</span>
        <span data-testid="draft-state" className="text-muted-foreground">
          {dirty ? t("modified") : t("unchanged")}
        </span>
        {dirty ? (
          <span data-testid="draft-stat" className={`${mono} text-xs`}>
            {t("stat", stat)}
          </span>
        ) : null}
        <span className="flex flex-1 flex-wrap justify-end gap-2">
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
        </span>
      </div>
      <p className="px-4 pt-3 text-xs text-muted-foreground">
        {t("identityLocked")}
      </p>
      {parsed.ok && !matchesIdentity ? (
        <div className="px-4 pt-3">
          <FormAlert testId="source-slug-error">
            {t("identityMismatch", { slug })}
          </FormAlert>
        </div>
      ) : null}
      {parsed.ok ? null : (
        <div className="px-4 pt-3">
          <FormAlert testId="parse-error">
            {t("parse.error", {
              line: parsed.line,
              reason: t(`parse.reason.${parsed.code}`),
            })}
          </FormAlert>
        </div>
      )}
      <div className="p-4">
        <CodeEditor
          value={draft}
          onChange={setDraft}
          language="toml"
          label={path}
        />
      </div>
      <CommitDialog
        open={committing}
        onOpenChange={setCommitting}
        org={org}
        ws={ws}
        agentId={agentId}
        path={path}
        branch={branch}
        draft={draft}
        stat={stat}
        after={after}
      />
    </section>
  );
}
