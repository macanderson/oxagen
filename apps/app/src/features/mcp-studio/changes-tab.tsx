"use client";
// A Studio server's Changes tab (#4678, "Changes"): the draft's tool surface
// diff, the edits staged, the files the steering PR would change, the tool
// checks' findings, and the button that opens the steering PR.
//
// The draft lives in this browser tab (use-draft.ts) until the person
// discards it. Opening the steering PR is lane M11's Review, in two calls:
// save_studio_draft stores the draft, then open_studio_review opens one
// steering PR from it, or adds a commit to the one an earlier Review opened.
// Both answer "not built" until #4688 merges. A save refused because someone
// saved the draft since this tab did reloads theirs and stages this tab's
// edits on top (mergeDrafts), and the person reviews the result before trying
// again. The findings come from lane M5's checks (#4672) and read as not
// recorded until they run. The PR carries tools.toml, the lock and the saved
// tests, never a credential.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  kvList,
  kvTerm,
  kvValue,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { PullRequestLink } from "@/ui/navigation";
import { StateWrap } from "@/ui/state-wrap";
import { cell, Table } from "@/ui/table";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import {
  type DraftLine,
  type DraftOp,
  draftFiles,
  draftLines,
  draftTokens,
  mergeDrafts,
  sourceRequired,
} from "./draft";
import type { StudioGap } from "./gaps";
import type { StudioRecord, StudioSourceType, StudioTool } from "./model";
import { StudioNotRecorded, StudioNotRecordedValue } from "./not-recorded";
import type { StudioAt } from "./route";
import {
  type GetStudioDraft,
  getStudioDraft,
  type OpenStudioReview,
  openStudioReview,
  type SaveStudioDraft,
  type StudioFinding,
  type StudioReview,
  saveStudioDraft,
} from "./seams";
import { useStudioDraft } from "./use-draft";

const CHANGE_TONE: Readonly<Record<DraftLine["change"], BadgeTone>> = {
  added: "allowed",
  removed: "denied",
  changed: "approval",
};

const LEVEL_TONE: Readonly<Record<StudioFinding["level"], BadgeTone>> = {
  error: "failed",
  warning: "denied",
  info: "quiet",
};

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId} className={panel}>
      <header className={panelHeader}>
        <h2 id={id} className={panelTitle}>
          {title}
        </h2>
      </header>
      <div className={`${panelBody} flex flex-col gap-3`}>{children}</div>
    </section>
  );
}

/** One staged edit in a line a person reads. */
function OpLabel({ op }: { op: DraftOp }) {
  const t = useTranslations("mcpStudio.changes.ops");
  const registry = useTranslations("tools.registry");
  switch (op.kind) {
    case "import":
      return <>{t("import", { tool: op.tool })}</>;
    case "remove":
      return <>{t("remove", { tool: op.tool })}</>;
    case "classify":
      return (
        <>
          {t("classify", {
            tool: op.tool,
            risk: registry(`risk.${op.risk}`),
            sideEffect: registry(`sideEffect.${op.sideEffect}`),
          })}
        </>
      );
    case "describe":
      return <>{t("describe", { tool: op.tool })}</>;
    case "test":
      return (
        <>{t("test", { tool: op.tool, environment: op.environment })}</>
      );
  }
}

/** What a diff line changes: the fields edited, or the tokens it adds or drops. */
function LineDetail({ line }: { line: DraftLine }) {
  const t = useTranslations("mcpStudio.changes.surface");
  const locale = useLocale();
  if (line.change === "changed") {
    return <>{line.fields.map((field) => t(`fields.${field}`)).join(", ")}</>;
  }
  if (line.tokens === null) return <>{t("tokensUnmeasured")}</>;
  const tokens = formatCount(line.tokens, locale);
  return (
    <>
      {line.change === "added"
        ? t("tokensAdded", { tokens })
        : t("tokensRemoved", { tokens })}
    </>
  );
}

function Surface({
  lines,
  before,
  after,
}: {
  lines: readonly DraftLine[];
  before: number | null;
  after: number | null;
}) {
  const t = useTranslations("mcpStudio.changes.surface");
  const locale = useLocale();
  const tokens = (value: number | null) =>
    value === null ? (
      <StudioNotRecordedValue gap="record" />
    ) : (
      formatCount(value, locale)
    );
  return (
    <Section title={t("title")} testId="studio-changes-surface">
      <p
        data-testid="studio-changes-tokens"
        className="flex flex-wrap items-baseline gap-1.5 text-[13px] text-muted-foreground"
      >
        <span>{t("tokens")}</span>
        <span className={`${mono} text-foreground`}>{tokens(before)}</span>
        <span aria-hidden>→</span>
        <span className="sr-only">{t("to")}</span>
        <span className={`${mono} text-foreground`}>{tokens(after)}</span>
      </p>
      {lines.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t("none")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.change") },
            { label: t("columns.tool") },
            { label: t("columns.detail") },
          ]}
        >
          {lines.map((line) => (
            <tr
              key={line.tool}
              data-testid={`studio-change-${line.tool}`}
              data-change={line.change}
            >
              <td className={cell}>
                <Badge tone={CHANGE_TONE[line.change]}>
                  {t(`kinds.${line.change}`)}
                </Badge>
              </td>
              <td className={`${cell} ${mono}`}>{line.tool}</td>
              <td className={cell}>
                <LineDetail line={line} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function Findings({
  findings,
}: {
  findings: readonly StudioFinding[] | null;
}) {
  const t = useTranslations("mcpStudio.changes.findings");
  return (
    <Section title={t("title")} testId="studio-changes-findings">
      {findings === null ? (
        <StudioNotRecorded gap="findings" testId="studio-findings-missing">
          {t("missing")}
        </StudioNotRecorded>
      ) : findings.length === 0 ? (
        <p
          data-testid="studio-findings-none"
          className="text-[13px] text-muted-foreground"
        >
          {t("none")}
        </p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.level") },
            { label: t("columns.rule") },
            { label: t("columns.tool") },
            { label: t("columns.message") },
            { label: t("columns.fix") },
          ]}
        >
          {findings.map((finding, index) => (
            <tr
              // A rule can fire twice on one tool, at two fields.
              key={`${finding.rule}:${finding.tool ?? ""}:${finding.field ?? ""}:${String(index)}`}
              data-testid="studio-finding"
              data-level={finding.level}
            >
              <td className={cell}>
                <Badge tone={LEVEL_TONE[finding.level]}>
                  {t(`levels.${finding.level}`)}
                </Badge>
              </td>
              <td className={`${cell} ${mono}`}>{finding.rule}</td>
              <td className={`${cell} ${mono}`}>
                {finding.tool ?? t("server")}
                {finding.field === null ? null : (
                  <span className="block text-[11.5px] text-muted-foreground">
                    {finding.field}
                  </span>
                )}
              </td>
              <td className={cell}>{finding.message}</td>
              <td className={cell}>{finding.fix}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

/** How the last Review went, shown under the button. */
type Outcome =
  | { kind: "opened"; review: StudioReview; updated: boolean }
  | { kind: "conflict"; dropped: number }
  | { kind: "sourceMissing" }
  | { kind: "notBuilt"; gap: StudioGap }
  | { kind: "failed"; message: string };

/** What the steering PR carries, from Review's answer. */
function ReviewSummary({ review }: { review: StudioReview }) {
  const t = useTranslations("mcpStudio.changes.review");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  return (
    <dl
      className={kvList}
      aria-label={t("title")}
      data-testid="studio-review-summary"
    >
      <dt className={kvTerm}>{t("imported")}</dt>
      <dd className={kvValue}>{count(review.imported.length)}</dd>
      <dt className={kvTerm}>{t("removed")}</dt>
      <dd className={kvValue}>{count(review.removed.length)}</dd>
      <dt className={kvTerm}>{t("reclassified")}</dt>
      <dd className={kvValue}>{count(review.reclassified.length)}</dd>
      <dt className={kvTerm}>{t("tokens")}</dt>
      <dd className={kvValue} data-testid="studio-review-tokens">
        {t("tokensValue", {
          definitions: count(review.tokens.definitions),
          budget: count(review.tokens.budget),
        })}
      </dd>
    </dl>
  );
}

function Opened({ outcome }: { outcome: Outcome }) {
  const t = useTranslations("mcpStudio.changes.pr");
  switch (outcome.kind) {
    case "opened": {
      const { review } = outcome;
      const url = parsePullRequestUrl(review.url);
      // A PR number is an identifier, not a quantity: #4678, never #4,678.
      const number = String(review.number);
      const label = outcome.updated
        ? t("updated", { number })
        : t("opened", { number });
      return (
        <div className="flex flex-col gap-3">
          <p
            role="status"
            data-testid="studio-pr-opened"
            data-updated={outcome.updated || undefined}
            className="text-[13px]"
          >
            {url === null ? (
              label
            ) : (
              <PullRequestLink
                to={url}
                className="text-app-link-fg underline-offset-2 hover:underline"
              >
                {label}
              </PullRequestLink>
            )}
          </p>
          <ReviewSummary review={review} />
        </div>
      );
    }
    case "conflict":
      return (
        <FormAlert testId="studio-pr-conflict">
          {t("conflict")}
          {outcome.dropped === 0
            ? null
            : ` ${t("conflictDropped", { count: outcome.dropped })}`}
        </FormAlert>
      );
    case "sourceMissing":
      return (
        <StudioNotRecorded gap="record" testId="studio-pr-source-missing">
          {t("sourceMissing")}
        </StudioNotRecorded>
      );
    case "notBuilt":
      return (
        <StudioNotRecorded gap={outcome.gap} testId="studio-pr-not-built">
          {t("notBuilt")}
        </StudioNotRecorded>
      );
    case "failed":
      return (
        <FormAlert testId="studio-pr-failed">
          {t("failed", { message: outcome.message })}
        </FormAlert>
      );
  }
}

export function ChangesTab({
  at,
  serverName,
  serverId,
  record,
  sourceType,
  tools,
  findings,
  canEdit,
  save = saveStudioDraft,
  get = getStudioDraft,
  open = openStudioReview,
}: {
  /** The workspace the draft belongs to. */
  at: StudioAt;
  /** The folder name M11 keys the draft by; null until the record names it. */
  serverName: string | null;
  serverId: string;
  record: StudioRecord | null;
  /** Where the server's tools come from; null until the record says. */
  sourceType: StudioSourceType | null;
  tools: readonly Pick<StudioTool, "name" | "imported" | "tokens">[];
  /** The tool checks' findings on the folder; null until the checks run. */
  findings: readonly StudioFinding[] | null;
  /** An org Owner or Admin, who can open the steering PR and discard edits. */
  canEdit: boolean;
  save?: SaveStudioDraft;
  get?: GetStudioDraft;
  open?: OpenStudioReview;
}) {
  const t = useTranslations("mcpStudio.changes");
  const draft = useStudioDraft({ at, serverName, serverId });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const view = { tools };
  const lines = draftLines(view, draft.ops);
  const files = draftFiles(view, draft.ops);
  const { before, after } = draftTokens(view, draft.ops);
  const empty = draft.ops.length === 0;
  // Review runs the checks again, so its findings replace the folder's.
  const shown = outcome?.kind === "opened" ? outcome.review.findings : findings;

  /** Reload the stored draft and stage this tab's edits on top of it. */
  const reload = async (server: string): Promise<Outcome> => {
    const stored = await get({ server });
    if (!stored.ok) {
      return stored.reason === "not_built"
        ? { kind: "notBuilt", gap: stored.gap }
        : { kind: "failed", message: stored.message };
    }
    if (stored.draft === null) {
      // The stored draft is gone, so this tab's is saved as a new one.
      draft.replace({ revision: 0, ops: draft.ops });
      return { kind: "conflict", dropped: 0 };
    }
    const merged = mergeDrafts(stored.draft.ops, draft.ops);
    draft.replace({ revision: stored.draft.revision, ops: merged.ops });
    return { kind: "conflict", dropped: merged.dropped };
  };

  const review = async (server: string): Promise<Outcome> => {
    const saved = await save({
      server,
      serverId,
      ops: draft.ops,
      revision: draft.revision,
    });
    if (!saved.ok) {
      if (saved.reason === "conflict") return reload(server);
      return saved.reason === "not_built"
        ? { kind: "notBuilt", gap: saved.gap }
        : { kind: "failed", message: saved.message };
    }
    draft.replace({ revision: saved.draft.revision, ops: saved.draft.ops });
    if (
      sourceRequired(saved.draft.ops, sourceType) &&
      saved.draft.source === null
    ) {
      return { kind: "sourceMissing" };
    }
    const opened = await open({ server, revision: saved.draft.revision });
    if (opened.ok) {
      return {
        kind: "opened",
        review: opened.review,
        updated: saved.draft.pr !== null,
      };
    }
    // A Review refused after a clean save names its reason (an unclassified
    // import, a folder that does not compile), so it reads as a failure to
    // fix rather than a draft to reload.
    return opened.reason === "not_built"
      ? { kind: "notBuilt", gap: opened.gap }
      : { kind: "failed", message: opened.message };
  };

  const openPr = async (server: string) => {
    setBusy(true);
    try {
      setOutcome(await review(server));
    } catch (error) {
      setOutcome({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="studio-changes">
      {empty && outcome === null ? (
        <StateWrap
          tone="neutral"
          testId="studio-changes-empty"
          title={t("empty.title")}
        >
          {t("empty.body")}
        </StateWrap>
      ) : null}
      {empty ? null : (
        <>
          <Surface lines={lines} before={before} after={after} />
          <Section title={t("edits.title")} testId="studio-changes-edits">
            <ul className="flex flex-col divide-y divide-border">
              {draft.ops.map((op, index) => (
                <li
                  // An edit's place in the draft is its identity: two saved
                  // tests of one tool are two edits.
                  key={`${op.kind}:${op.tool}:${String(index)}`}
                  data-testid={`studio-edit-${String(index)}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <OpLabel op={op} />
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      data-testid={`studio-unstage-${String(index)}`}
                      aria-label={t("edits.unstageNamed", { tool: op.tool })}
                      disabled={busy}
                      className={buttonSecondary}
                      onClick={() => {
                        draft.unstage(index);
                      }}
                    >
                      {t("edits.unstage")}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
          <Section title={t("files.title")} testId="studio-changes-files">
            <ul className="flex flex-col gap-1 text-[13px]">
              {files.map((file) => (
                <li key={file} className={mono}>
                  {record === null ? file : `${record.folder}/${file}`}
                </li>
              ))}
            </ul>
            {record === null ? (
              <StudioNotRecorded gap="record" testId="studio-folder-missing">
                {t("files.folderMissing")}
              </StudioNotRecorded>
            ) : null}
          </Section>
        </>
      )}
      <Findings findings={shown} />
      <Section title={t("pr.title")} testId="studio-changes-pr">
        <p className="text-[13px] text-muted-foreground">{t("pr.body")}</p>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="studio-pr-open"
              disabled={empty || serverName === null}
              aria-disabled={busy || undefined}
              className={buttonPrimary}
              onClick={() => {
                if (busy || empty || serverName === null) return;
                void openPr(serverName);
              }}
            >
              {busy ? t("pr.opening") : t("pr.open")}
            </button>
            <button
              type="button"
              data-testid="studio-draft-discard"
              disabled={empty || busy}
              className={buttonSecondary}
              onClick={() => {
                draft.discard();
                setOutcome(null);
              }}
            >
              {t("pr.discard")}
            </button>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t("pr.readOnly")}</p>
        )}
        {canEdit && serverName === null ? (
          <StudioNotRecorded gap="record" testId="studio-pr-no-server">
            {t("pr.folderMissing")}
          </StudioNotRecorded>
        ) : null}
        {outcome === null ? null : <Opened outcome={outcome} />}
      </Section>
    </div>
  );
}
