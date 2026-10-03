"use client";
// A Studio server's Changes tab (#4678, "Changes"): the draft's tool surface
// diff, the edits staged, the files the steering PR would change, the tool
// checks' findings, and the button that opens the steering PR.
//
// The draft lives in this browser tab (use-draft.ts) until the person
// discards it. Opening the steering PR is lane M11's Review, in two calls
// (review-calls.ts): save_studio_draft stores the draft, then
// open_studio_review opens one steering PR from it, or adds a commit to the
// one an earlier Review opened. A save or a Review refused because someone
// saved the draft since this tab did reloads theirs and stages this tab's
// edits on top (mergeDrafts), and the person reviews the result before trying
// again. A stored draft this page cannot read leaves the tab's edits as they
// are. The findings come from list_studio_findings (#4742), which runs lane
// M5's checks on the saved draft, or on the folder when no draft is saved. It
// names the server by the folder the record gives, so until the record names
// one, the section says findings are not recorded. The PR carries tools.toml,
// the lock and the saved tests, and server.toml when the draft changes the
// exposure mode, never a credential.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useId, useMemo, useState } from "react";
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
  capTokens,
  type DraftLine,
  type DraftOp,
  draftExposure,
  draftFiles,
  draftLines,
  draftTokens,
  type ExposureMode,
  mergeDrafts,
  opTool,
  readDraftOps,
  sourceRequired,
} from "./draft";
import type { StudioRecord, StudioSourceType, StudioTool } from "./model";
import { StudioNotRecorded, StudioNotRecordedValue } from "./not-recorded";
import type { StudioAt } from "./route";
import { reviewCalls } from "./review-calls";
import { isReviewCode } from "./review-codes";
import type {
  GetStudioDraft,
  OpenStudioReview,
  SaveStudioDraft,
  StudioFinding,
  StudioReview,
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
  const modes = useTranslations("mcpStudio.tools.exposure.modes");
  const locale = useLocale();
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
    case "cap":
      return (
        <>
          {t("cap", {
            tool: op.tool,
            tokens: formatCount(capTokens(op.maxResultBytes), locale),
            paging:
              op.paging === undefined ? "keep" : op.paging ? "on" : "off",
          })}
        </>
      );
    case "expose":
      return <>{t("expose", { mode: modes(op.mode) })}</>;
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
  exposure,
}: {
  lines: readonly DraftLine[];
  before: number | null;
  after: number | null;
  /** The exposure mode before and after the draft; null when the draft leaves it. */
  exposure: { from: ExposureMode | null; to: ExposureMode } | null;
}) {
  const t = useTranslations("mcpStudio.changes.surface");
  const modes = useTranslations("mcpStudio.tools.exposure.modes");
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
        className="flex flex-wrap items-baseline gap-1.5 text-sm text-muted-foreground"
      >
        <span>{t("tokens")}</span>
        <span className={`${mono} text-foreground`}>{tokens(before)}</span>
        <span aria-hidden>→</span>
        <span className="sr-only">{t("to")}</span>
        <span className={`${mono} text-foreground`}>{tokens(after)}</span>
      </p>
      {exposure === null ? null : (
        <p
          data-testid="studio-changes-exposure"
          className="flex flex-wrap items-baseline gap-1.5 text-sm text-muted-foreground"
        >
          <span>{t("exposure")}</span>
          {exposure.from === null ? null : (
            <>
              <span className="text-foreground">{modes(exposure.from)}</span>
              <span aria-hidden>→</span>
              <span className="sr-only">{t("to")}</span>
            </>
          )}
          <span className="text-foreground">{modes(exposure.to)}</span>
        </p>
      )}
      {lines.length === 0 ? (
        exposure === null ? (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        ) : null
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
        <StudioNotRecorded gap="record" testId="studio-findings-missing">
          {t("missing")}
        </StudioNotRecorded>
      ) : findings.length === 0 ? (
        <p
          data-testid="studio-findings-none"
          className="text-sm text-muted-foreground"
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
                  <span className="block text-xs text-muted-foreground">
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
  /** The stored draft does not fit this page's draft shape, so the tab kept its own edits. */
  | { kind: "kept" }
  | { kind: "sourceMissing" }
  /** A refusal's code, or null when the call threw before Oxagen answered. */
  | { kind: "failed"; code: string | null };

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
      <dt className={kvTerm}>{t("branch")}</dt>
      <dd
        className={`${kvValue} ${mono} [overflow-wrap:anywhere]`}
        data-testid="studio-review-branch"
      >
        {review.branch}
      </dd>
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
            className="text-sm"
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
    case "kept":
      return <FormAlert testId="studio-pr-kept">{t("kept")}</FormAlert>;
    case "sourceMissing":
      return (
        <StudioNotRecorded gap="record" testId="studio-pr-source-missing">
          {t("sourceMissing")}
        </StudioNotRecorded>
      );
    case "failed": {
      const { code } = outcome;
      return (
        <FormAlert testId="studio-pr-failed">
          {code === null
            ? t("thrown")
            : isReviewCode(code)
              ? t(`codes.${code}`)
              : t("failed", { code })}
        </FormAlert>
      );
    }
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
  save: saveOverride,
  get: getOverride,
  open: openOverride,
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
  /** The tool checks' findings on the folder; null when none could be read. */
  findings: readonly StudioFinding[] | null;
  /** An org or workspace Owner or Admin, who can open the steering PR. */
  canEdit: boolean;
  /** Test seams; the tab calls lane M11's capabilities otherwise. */
  save?: SaveStudioDraft;
  get?: GetStudioDraft;
  open?: OpenStudioReview;
}) {
  const t = useTranslations("mcpStudio.changes");
  const locale = useLocale();
  const draft = useStudioDraft({ at, serverName, serverId });
  const calls = useMemo(
    () => reviewCalls({ org: at.org, ws: at.ws }),
    [at.org, at.ws],
  );
  const save = saveOverride ?? calls.save;
  const get = getOverride ?? calls.get;
  const open = openOverride ?? calls.open;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const view = { tools, exposure: record?.exposure.mode ?? null };
  const lines = draftLines(view, draft.ops);
  const exposureTo = draftExposure(view, draft.ops);
  const exposure =
    exposureTo === null
      ? null
      : { from: record?.exposure.mode ?? null, to: exposureTo };
  const files = draftFiles(view, draft.ops);
  const { before, after } = draftTokens(view, draft.ops);
  const empty = draft.ops.length === 0;
  // Lint flags an over-budget server only when its tools load directly
  // (over_definition_budget), so the warning follows the same rule, and
  // takes the mode the draft sets.
  const overBudget =
    record !== null &&
    (exposureTo ?? record.exposure.mode) === "direct" &&
    after !== null &&
    after > record.exposure.definitionBudget
      ? { tokens: after, budget: record.exposure.definitionBudget }
      : null;
  // Review runs the checks again, so its findings replace the folder's.
  const shown = outcome?.kind === "opened" ? outcome.review.findings : findings;

  /** Reload the stored draft and stage this tab's edits on top of it. */
  const reload = async (server: string): Promise<Outcome> => {
    const stored = await get({ server });
    if (!stored.ok) return { kind: "failed", code: stored.code };
    if (stored.draft === null) {
      // The stored draft is gone, so this tab's is saved as a new one.
      draft.replace({ revision: 0, ops: draft.ops });
      return { kind: "conflict", dropped: 0 };
    }
    const theirs = readDraftOps(stored.draft.ops);
    if (theirs === null) {
      // The stored draft holds edits this page cannot read, which a newer
      // page wrote. The tab keeps its own revision rather than taking the
      // stored one: a save replaces the whole operation list, so adopting
      // that revision would pass the next concurrency check and delete those
      // edits. Keeping it means the next save conflicts again instead, and
      // the message asks for a reload, which is what brings a page able to
      // read them. The local edits survive it, because the draft is in
      // sessionStorage.
      return { kind: "kept" };
    }
    const merged = mergeDrafts(theirs, draft.ops);
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
      return saved.reason === "conflict"
        ? reload(server)
        : { kind: "failed", code: saved.code };
    }
    // The save echoes the edits it stored. Should they not read back, the
    // tab keeps the ones it sent, which are the same edits.
    const stored = readDraftOps(saved.draft.ops) ?? draft.ops;
    draft.replace({ revision: saved.draft.revision, ops: stored });
    if (sourceRequired(stored, sourceType) && saved.draft.source === null) {
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
    // Someone saved between this tab's save and its Review, so the tab
    // reloads as it does for a save conflict. Any other refusal names its
    // reason (an unclassified import, a folder that does not compile): a
    // failure to fix, not a draft to reload.
    return opened.reason === "conflict"
      ? reload(server)
      : { kind: "failed", code: opened.code };
  };

  const openPr = async (server: string) => {
    setBusy(true);
    try {
      setOutcome(await review(server));
    } catch {
      // The request itself failed (the network, or the server before it
      // answered), so there is no code to name.
      setOutcome({ kind: "failed", code: null });
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
          <Surface
            lines={lines}
            before={before}
            after={after}
            exposure={exposure}
          />
          <Section title={t("edits.title")} testId="studio-changes-edits">
            <ul className="flex flex-col divide-y divide-border">
              {draft.ops.map((op, index) => (
                <li
                  // An edit's place in the draft is its identity: two saved
                  // tests of one tool are two edits.
                  key={`${op.kind}:${opTool(op) ?? ""}:${String(index)}`}
                  data-testid={`studio-edit-${String(index)}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <OpLabel op={op} />
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      data-testid={`studio-unstage-${String(index)}`}
                      aria-label={
                        op.kind === "expose"
                          ? t("edits.unstageExposure")
                          : t("edits.unstageNamed", { tool: op.tool })
                      }
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
            <ul className="flex flex-col gap-1 text-sm">
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
        <p className="text-sm text-muted-foreground">{t("pr.body")}</p>
        {overBudget !== null && !empty ? (
          <p
            data-testid="studio-pr-over-budget"
            className="flex flex-wrap items-center gap-2 text-sm text-foreground"
          >
            <Badge tone="denied">{t("pr.overBudgetBadge")}</Badge>
            <span>
              {t("pr.overBudget", {
                tokens: formatCount(overBudget.tokens, locale),
                budget: formatCount(overBudget.budget, locale),
              })}
            </span>
          </p>
        ) : null}
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
          <p className="text-sm text-muted-foreground">{t("pr.readOnly")}</p>
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
