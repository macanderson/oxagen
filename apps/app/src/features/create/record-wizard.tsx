"use client";
// The context-record wizard (roadmap creation-spec §5; mockup `wzRecord`).
// Describe the concern, pick its kind, write the statement, read what the six
// checks will assert, and open the pull request. The kind comes before the
// sentence because it decides how the record reaches a run and what the checks
// assert about it, and each kind card says what that kind can never do.
//
// The last step calls propose_record, then open_context_pr: the proposal is
// the Context PR's own state, and open_context_pr cuts `context/<lineage>`
// from the main repository, commits `.oxagen/rules/<lineage>.toml` in the
// context-record/v0.1 format, and runs the six checks (MC spec §10.3). The
// record steers nothing until a person merges it. On success the page behind
// the dialog moves to Steering · Context PRs with the new pull request
// selected, so closing the wizard lands there (creation-spec §5).
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect } from "react";
import {
  ConstraintEffect,
  RECORD_KINDS,
  RecordForce,
  type RecordKind,
} from "@/data/contracts/steering";
import type { ActionResult } from "@/server/kernel";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes } from "@/shared/safe-path";
import {
  buttonSecondary,
  inputBase,
  linkText,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { PullRequestLink, SafeLink, useNavigate } from "@/ui/navigation";
import { RecordCard } from "@/ui/record-card";
import { type OpenedRecord, openRecordPr, proposeRecord } from "./actions";
import {
  DescriptionField,
  DraftNote,
  FileEditor,
  OptionCard,
  PullRequestPlan,
} from "./parts";
import {
  choiceKey,
  forceOf,
  forcesFor,
  hasEffect,
  isStable,
  lineageOf,
  type RecordChoice,
  STATEMENT_MAX,
  seedStatement,
  statementTokens,
} from "./record-file";
import type {
  CreateContext,
  StepId,
  StepProps,
  StepView,
  WizardKind,
} from "./wizard";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

type RecordDraft = {
  desc: string;
  kind: RecordKind | null;
  force: RecordForce | null;
  effect: ConstraintEffect;
  /** The statement as the operator edited it; null while it is the drafted one. */
  statement: string | null;
  /**
   * The proposal this wizard already made, under the choice it was made for.
   * A retry after a failed open reuses it instead of proposing twice.
   */
  proposal: { id: string; key: string } | null;
  submit:
    | { state: "idle" }
    | { state: "pending" }
    | { state: "failed"; failure: Failure }
    | { state: "opened"; record: OpenedRecord };
};

type Api = StepProps<RecordDraft>["api"];

const STEPS: readonly StepId[] = [
  "describe",
  "kind",
  "statement",
  "checks",
  "pullRequest",
];

const CHECKS = [
  "schema",
  "lineage",
  "hash",
  "secrets",
  "conflicts",
  "effect",
] as const;

const FAILURES = {
  org_role_required: "orgRoleRequired",
  no_principal: "noPrincipal",
  lineage_pr_open: "lineagePrOpen",
  governance_unreadable: "governanceUnreadable",
  workspace_repository_missing: "repositoryMissing",
  github_refused: "githubRefused",
  base_moved: "baseMoved",
  head_moved: "proposalMoved",
  already_merged: "proposalMoved",
  unanswered: "unanswered",
} as const;

function isKnownFailure(code: string): code is keyof typeof FAILURES {
  return Object.hasOwn(FAILURES, code);
}

function useFailureText(): (failure: Failure) => string {
  const t = useTranslations("createRecord.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
      case "unavailable":
        if (isKnownFailure(failure.code)) return t(FAILURES[failure.code]);
        // A status write refuses with proposal_<status> when another call
        // moved the proposal first.
        return failure.code.startsWith("proposal_")
          ? t("proposalMoved")
          : t("refused", { code: failure.code });
      case "invalid":
        return t("invalid", { field: failure.field ?? "input" });
      case "pending_approval":
        return t("pendingApproval", { request: failure.accessRequestId });
      case "exhausted":
        return t("refused", { code: failure.code });
    }
  };
}

const code = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;

/** What the draft adds up to: the record propose_record will be sent. */
function recordOf(api: Api, ctx: CreateContext) {
  const d = api.draft;
  const kind = d.kind ?? "rule";
  const seed = seedStatement(d.desc, d.kind);
  const statement = d.statement ?? seed;
  const lineageId = lineageOf(ctx.ws, d.desc);
  const force = forceOf(kind, d.force);
  const choice: RecordChoice = {
    lineageId,
    kind,
    force,
    ...(hasEffect(kind) ? { constraintEffect: d.effect } : {}),
    sharingScope: "workspace",
    statement: statement.trim(),
  };
  return {
    choice,
    seed,
    statement,
    edited: statement !== seed,
    path: `.oxagen/rules/${lineageId}.toml`,
    tokens: statementTokens(statement),
    fits: statement.trim() !== "" && statement.trim().length <= STATEMENT_MAX,
  };
}

function DescribeStep({ api }: StepProps<RecordDraft>) {
  const t = useTranslations("createRecord.describe");
  return (
    <div className="flex flex-col gap-3 text-sm">
      <DescriptionField
        api={api}
        placeholder={t("placeholder")}
        hint={t("hint")}
        suggestions={[
          t("suggestions.changelog"),
          t("suggestions.release"),
          t("suggestions.order"),
          t("suggestions.flake"),
        ]}
      />
      <p className="rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-muted-foreground">
        {t("noGrant")}
      </p>
    </div>
  );
}

function KindStep({ api }: StepProps<RecordDraft>) {
  const t = useTranslations("createRecord.kind");
  const chosen = api.draft.kind;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <ul
        aria-label={t("cards")}
        className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
      >
        {RECORD_KINDS.map((k) => (
          <li key={k} data-kind={k} className="flex">
            <OptionCard
              title={t(`kinds.${k}.label`)}
              body={
                <>
                  <span className="block">{t(`kinds.${k}.about`)}</span>
                  <span className="mt-1 block text-foreground">
                    {t(`kinds.${k}.use`)}
                  </span>
                </>
              }
              note={t("never", { text: t(`kinds.${k}.never`) })}
              pressed={chosen === k}
              onPress={() => {
                api.update({ kind: k, submit: { state: "idle" } });
              }}
            />
          </li>
        ))}
      </ul>
      <div aria-live="polite">
        {chosen === null ? null : (
          <div data-testid="kind-deliver" className="flex flex-col gap-1.5">
            <p className="font-medium">
              {t("reaches", { kind: t(`kinds.${chosen}.label`) })}
            </p>
            <p className="rounded-lg border border-border border-l-2 border-l-brand bg-muted/30 px-3.5 py-3 text-muted-foreground">
              {t.rich(`kinds.${chosen}.deliver`, { code })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatementStep({ api, ctx }: StepProps<RecordDraft>) {
  const t = useTranslations("createRecord.statement");
  const record = recordOf(api, ctx);
  const d = api.draft;
  const kind = record.choice.kind;
  const forces = forcesFor(kind);
  const force = record.choice.force;
  const repo = ctx.repo.state === "bound" ? ctx.repo.fullName : null;
  const length = record.statement.trim().length;
  const set = (value: string) => {
    api.update({ statement: value === record.seed ? null : value });
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <DraftNote title={t("drafted.title")} body={t("drafted.body")} />
      <FileEditor
        path={t("path", { path: record.path })}
        value={record.statement}
        onChange={set}
        bar={
          <>
            <span
              data-testid="statement-tokens"
              className="rounded-md border border-border px-2 py-0.5"
            >
              {t("tokens", { tokens: record.tokens })}
            </span>
            <button
              type="button"
              className={`${buttonSecondary} min-h-8 px-3 py-1 text-xs`}
              disabled={!record.edited}
              onClick={() => {
                api.update({ statement: null });
              }}
            >
              {t("revert")}
            </button>
          </>
        }
      />
      <div aria-live="polite">
        {length === 0 ? (
          <FormAlert testId="statement-problem">{t("empty")}</FormAlert>
        ) : length > STATEMENT_MAX ? (
          <FormAlert testId="statement-problem">
            {t("tooLong", { count: length, max: STATEMENT_MAX })}
          </FormAlert>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="record-force" className="font-medium">
            {t("force.label")}
          </label>
          <select
            id="record-force"
            data-testid="record-force"
            value={force}
            aria-describedby="record-force-hint"
            onChange={(event) => {
              const chosen = RecordForce.options.find(
                (f) => f === event.target.value,
              );
              if (chosen !== undefined) api.update({ force: chosen });
            }}
            className={`${inputBase} ${mono}`}
          >
            {forces.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <p id="record-force-hint" className="text-xs text-muted-foreground">
            {isStable(force) ? t("force.stable") : t("force.selected")}
            {kind === "preference" ? ` ${t("force.preference")}` : null}
            {kind === "fact" || kind === "memory"
              ? ` ${t("force.informs")}`
              : null}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="record-scope" className="font-medium">
            {t("scope.label")}
          </label>
          <select
            id="record-scope"
            data-testid="record-scope"
            value="workspace"
            aria-describedby="record-scope-hint"
            onChange={() => {
              // One scope is open: see scope.repositoryClosed.
            }}
            className={`${inputBase} ${mono}`}
          >
            <option value="workspace">{t("scope.workspace")}</option>
            <option value="repository" disabled>
              {t("scope.repository")}
            </option>
          </select>
          <p id="record-scope-hint" className="text-xs text-muted-foreground">
            {t("scope.workspaceHint", {
              repository: repo ?? ctx.ws,
              workspace: ctx.wsName,
            })}{" "}
            {t("scope.repositoryClosed")}
          </p>
        </div>
      </div>
      {hasEffect(kind) ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="record-effect" className="font-medium">
            {t("effect.label")}
          </label>
          <select
            id="record-effect"
            data-testid="record-effect"
            value={d.effect}
            aria-describedby="record-effect-hint"
            onChange={(event) => {
              const chosen = ConstraintEffect.options.find(
                (e) => e === event.target.value,
              );
              if (chosen !== undefined) api.update({ effect: chosen });
            }}
            className={`${inputBase} ${mono} sm:max-w-60`}
          >
            {ConstraintEffect.options.map((effect) => (
              <option key={effect} value={effect}>
                {effect}
              </option>
            ))}
          </select>
          <p id="record-effect-hint" className="text-xs text-muted-foreground">
            {t("effect.hint")}
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <p className="font-medium">{t("preview.label")}</p>
        <div data-testid="record-preview">
          <RecordCard
            kind={kind}
            force={force}
            constraintEffect={record.choice.constraintEffect ?? null}
            sharingScope="workspace"
            lineage={record.choice.lineageId}
            statement={record.statement}
            badge={
              <span className="rounded-sm border border-dashed border-border px-1.5 py-0.5">
                {t("preview.badge")}
              </span>
            }
          />
        </div>
      </div>
      <p className="text-muted-foreground">
        {t("bundle", { tokens: record.tokens })}
      </p>
    </div>
  );
}

function ChecksStep({ api, ctx }: StepProps<RecordDraft>) {
  const t = useTranslations("createRecord.checks");
  const record = recordOf(api, ctx);
  const effect = record.choice.constraintEffect;
  const detail: Record<(typeof CHECKS)[number], ReactNode> = {
    schema: t.rich("items.schema.detail", { code }),
    lineage: t.rich("items.lineage.detail", {
      lineage: record.choice.lineageId,
      code,
    }),
    hash: t("items.hash.detail"),
    secrets: t("items.secrets.detail"),
    conflicts: t.rich("items.conflicts.detail", { code }),
    effect:
      effect === undefined
        ? t("items.effect.none")
        : t.rich("items.effect.constraint", { effect, code }),
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <ul data-testid="record-checks" className="flex flex-col gap-2">
        {CHECKS.map((c) => (
          <li
            key={c}
            className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[12rem_1fr] sm:gap-3"
          >
            <span className="font-medium text-foreground">
              {t(`items.${c}.name`)}
            </span>
            <span className="text-muted-foreground">{detail[c]}</span>
          </li>
        ))}
      </ul>
      <p className="rounded-lg border border-border border-l-2 border-l-brand bg-muted/30 px-3.5 py-3 text-muted-foreground">
        {t("fifth")}
      </p>
    </div>
  );
}

function PullRequestStep({ api, ctx }: StepProps<RecordDraft>) {
  const t = useTranslations("createRecord.pr");
  const failureText = useFailureText();
  const record = recordOf(api, ctx);
  const d = api.draft;
  const repo = ctx.repo;
  const lineage = record.choice.lineageId;
  const effect = record.choice.constraintEffect;
  const detail: Record<(typeof CHECKS)[number], ReactNode> = {
    schema: t.rich("checks.schema", { code }),
    lineage: t.rich("checks.lineage", { lineage, code }),
    hash: t("checks.hash"),
    secrets: t("checks.secrets"),
    conflicts: t("checks.conflicts"),
    effect:
      effect === undefined
        ? t("checks.noEffect")
        : t.rich("checks.effect", { effect, code }),
  };
  return (
    <div className="flex flex-col gap-3">
      <PullRequestPlan
        lead={t("lead")}
        base={
          repo.state === "bound" ? `${repo.fullName}:${repo.defaultRef}` : null
        }
        branch={`context/${lineage}`}
        files={[{ change: "add", path: record.path, note: t("fileRecord") }]}
        checks={CHECKS.map((c) => ({
          name: t(`names.${c}`),
          detail: detail[c],
        }))}
      />
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium">{t("rationale")}</p>
        <p
          data-testid="record-rationale"
          className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-muted-foreground"
        >
          {d.desc.trim()}
        </p>
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {repo.state === "loading" ? (
          <p className="text-sm text-muted-foreground">{t("repo.loading")}</p>
        ) : repo.state === "unbound" ? (
          <FormAlert testId="repo-state">{t("repo.unbound")}</FormAlert>
        ) : repo.state === "denied" ? (
          <FormAlert testId="repo-state">{t("repo.denied")}</FormAlert>
        ) : repo.state === "unavailable" ? (
          <FormAlert testId="repo-state">
            {t("repo.unavailable", { code: repo.code })}
          </FormAlert>
        ) : null}
        {d.submit.state === "failed" ? (
          <FormAlert testId="pr-failure">
            {failureText(d.submit.failure)}
          </FormAlert>
        ) : null}
        {d.submit.state === "failed" &&
        d.proposal !== null &&
        d.proposal.key === choiceKey(record.choice) ? (
          <p
            data-testid="proposal-kept"
            className="text-sm text-muted-foreground"
          >
            {t("proposalKept", { proposal: d.proposal.id })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

type CheckStatus = "passed" | "failed" | "running" | "pending";
const CHECK_STATUSES: readonly CheckStatus[] = [
  "passed",
  "failed",
  "running",
  "pending",
];
const CHECK_NAMES = [
  "schema",
  "lineage_uniqueness",
  "record_hash",
  "secret_pii_scan",
  "conflict_against_active",
  "constraint_effect",
] as const;

function statusOf(raw: string): CheckStatus {
  return CHECK_STATUSES.find((s) => s === raw) ?? "pending";
}

function Opened({ record, ctx }: { record: OpenedRecord; ctx: CreateContext }) {
  const t = useTranslations("createRecord.opened");
  const navigate = useNavigate();
  const target = routes.steering(ctx.org, ctx.ws, {
    tab: "prs",
    proposal: record.proposalId,
  });
  // The wizard closes on Context PRs with this pull request selected
  // (creation-spec §5): the page behind the dialog moves there now.
  useEffect(() => {
    navigate.push(target);
  }, [navigate, target]);
  const pr = record.pr;
  const url = pr === null ? null : parsePullRequestUrl(pr.url);
  const outcome =
    record.status === "checks_passed"
      ? t("passed")
      : record.status === "checks_failed"
        ? t("failed")
        : t("running");
  return (
    <div
      role="status"
      data-testid="pr-opened"
      className="flex flex-col gap-3 text-sm"
    >
      {pr === null ? (
        <p>{t("noPr")}</p>
      ) : (
        <>
          <p>
            {url === null ? (
              <span className={mono}>
                {t("link", { repository: pr.repository, number: pr.number })}
              </span>
            ) : (
              <PullRequestLink
                to={url}
                className="font-medium text-link underline"
              >
                {t("link", { repository: pr.repository, number: pr.number })}
              </PullRequestLink>
            )}
          </p>
          <p className={`${mono} break-all text-xs text-muted-foreground`}>
            {t("path", { path: pr.path, branch: pr.branch })}
          </p>
        </>
      )}
      {record.checks.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <p className="font-medium">{t("checks")}</p>
          <ul data-testid="opened-checks" className="flex flex-col gap-1">
            {record.checks.map((c) => {
              const name = CHECK_NAMES.find((n) => n === c.name);
              const status = statusOf(c.status);
              return (
                <li
                  key={c.name}
                  data-status={status}
                  className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[14rem_6rem_1fr] sm:gap-3"
                >
                  <span className="text-foreground">
                    {name === undefined ? c.name : t(`names.${name}`)}
                  </span>
                  <span
                    className={
                      status === "failed"
                        ? "font-medium text-destructive"
                        : status === "passed"
                          ? "text-success"
                          : "text-muted-foreground"
                    }
                  >
                    {t(`status.${status}`)}
                  </span>
                  <span className="text-muted-foreground">{c.summary}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-muted-foreground">{outcome}</p>
      <p>
        <SafeLink to={target} className={linkText}>
          {t("onContextPrs")}
        </SafeLink>
      </p>
    </div>
  );
}

function useRecordStep(props: StepProps<RecordDraft>): StepView {
  const t = useTranslations("createRecord");
  const { api, ctx, step } = props;
  const d = api.draft;
  const record = recordOf(api, ctx);
  if (step === 1)
    return {
      title: t("describe.title"),
      subtitle: t("describe.subtitle"),
      body: <DescribeStep {...props} />,
      primary: { label: t("describe.next"), enabled: d.desc.trim() !== "" },
    };
  if (step === 2)
    return {
      title: t("kind.title"),
      subtitle: t("kind.subtitle"),
      body: <KindStep {...props} />,
      primary: { label: t("kind.next"), enabled: d.kind !== null },
    };
  if (step === 3)
    return {
      title: t("statement.title"),
      subtitle: t("statement.subtitle"),
      body: <StatementStep {...props} />,
      primary: { label: t("statement.next"), enabled: record.fits },
    };
  if (step === 4)
    return {
      title: t("checks.title"),
      subtitle: t("checks.subtitle"),
      body: <ChecksStep {...props} />,
      primary: { label: t("checks.next"), enabled: record.fits },
    };
  if (d.submit.state === "opened")
    return {
      title: t("opened.title"),
      subtitle: t("opened.subtitle"),
      body: <Opened record={d.submit.record} ctx={ctx} />,
    };
  const fail = (failure: Failure) => {
    api.update({ submit: { state: "failed", failure } });
  };
  const submit = async () => {
    if (d.kind === null || !record.fits) return;
    const key = choiceKey(record.choice);
    api.update({ submit: { state: "pending" } });
    try {
      let proposalId =
        d.proposal !== null && d.proposal.key === key ? d.proposal.id : null;
      if (proposalId === null) {
        const proposed = await proposeRecord(ctx.org, ctx.ws, {
          record: record.choice,
          rationale: d.desc,
        });
        if (!proposed.ok) {
          fail(proposed);
          return;
        }
        proposalId = proposed.value.proposalId;
        api.write({ proposal: { id: proposalId, key } });
      }
      const opened = await openRecordPr(ctx.org, ctx.ws, proposalId);
      if (!opened.ok) {
        fail(opened);
        return;
      }
      api.update({ submit: { state: "opened", record: opened.value } });
    } catch {
      fail({ ok: false, reason: "unavailable", code: "unanswered" });
    }
  };
  return {
    title: t("pr.title"),
    subtitle: t("pr.subtitle"),
    body: <PullRequestStep {...props} />,
    primary: {
      label: t("pr.open"),
      pendingLabel: t("pr.opening"),
      pending: d.submit.state === "pending",
      enabled:
        ctx.repo.state === "bound" &&
        record.fits &&
        d.submit.state !== "pending",
      run: submit,
    },
  };
}

export const recordWizard: WizardKind<RecordDraft> = {
  kind: "record",
  need: "steering.write",
  init: (prefill) => ({
    desc: prefill?.description ?? "",
    kind: null,
    force: null,
    effect: "forbid",
    statement: null,
    proposal: null,
    submit: { state: "idle" },
  }),
  steps: () => STEPS,
  useStep: useRecordStep,
};
