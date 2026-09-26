// A page of runs as the Fleet runs table reads it (ARCHITECTURE.md §1.2),
// from `list_runs`. A field is nullable exactly where the contract may not have
// recorded it (§3.4); a null renders as "not recorded".
import { z } from "zod";
import { PublicId } from "./common";
import { Cost } from "./money";

/**
 * `live`: open. `sealed`: ended with a sealed record. `halted`: an operator or
 * policy stopped it. Paused and compacted are facts beside the status
 * (`ingressPaused`, `compacted`), never statuses of their own (ADR-193).
 */
export const RunStatus = z.enum(["live", "sealed", "halted"]);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * How the run ended, in the word its store recorded. `status` is the
 * lifecycle and folds every sealed run into one word, so a run that finished
 * and a run that failed read the same there. This separates them.
 *
 * `running` while the run is open. `completed`, `failed`, and `cancelled`
 * come from the ledger; a wrapped session adds `crashed` (the harness died)
 * and `unknown` (the harness stopped reporting before it recorded an end).
 * `unknown` is a recorded answer and not a missing one: it says the record
 * does not show how the run ended, which is weaker than any of the others
 * and is rendered as such.
 */
export const RunOutcome = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "crashed",
  "unknown",
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

/**
 * The replay grade the seal recorded (spec §8.4), weakest first. The page
 * renders the recorded word and never a stronger one; null while the run is
 * live or its seal predates the recorder.
 */
export const ReplayGrade = z.enum(["inspect", "view", "fork", "retry"]);
export type ReplayGrade = z.infer<typeof ReplayGrade>;

/**
 * What `summarize_run` wrote: a light-tier model's account of what the run
 * changed. Labelled generated wherever it renders. The record is the frames,
 * never this sentence (ADR-058).
 */
const RunSummary = z.object({
  text: z.string().min(1),
  generatedAt: z.iso.datetime({ offset: true }),
  /** The model that wrote it, named beside the text so the reader can weigh it. */
  model: z.string().min(1),
});

/**
 * The witness verdict the rollup recorded (spec §8.5, §12.8; ADR-064), from
 * the closed vocabulary the runner writes. Only `flipped` marks a run proven.
 * Null when no witness reported on the run or the rollup has not rebuilt it;
 * a null reads "not recorded", never `unverified`, which is itself a recorded
 * answer a runner reached.
 */
const ProofVerdict = z.enum([
  "flipped",
  "failing",
  "unmoved",
  "unsatisfied",
  "tampered",
  "unverified",
  "waived",
]);

/**
 * Where the run's actions were observed from (spec §8.4). `observe` records
 * what an agent did and gives Oxagen no connection point, so every direct
 * command is refused: a page draws the controls disabled rather than offering
 * four that always fail.
 */
export const EnforcementTier = z.enum([
  "contained",
  "gateway",
  "harness",
  "observe",
]);
export type EnforcementTier = z.infer<typeof EnforcementTier>;

/**
 * Spec §7.3: which model request a steer rides, and whether the step in
 * flight is cut short to reach one sooner. It is a ceiling, not a promise:
 * each connection point carries the strongest mode it can at or below the one
 * asked for, and `dispatch_command` records both the request and what was
 * carried.
 *
 * Mirrors `tachoDeliveryModeSchema` (packages/tacho/src/wire.ts), the way
 * every view model here mirrors its contract enum.
 */
export const DeliveryMode = z.enum(["next_step", "interrupt", "turn_boundary"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

/** The gaps a seal recorded, from the closed vocabulary (spec §13.1). */
const CompletenessGap = z.enum([
  "digest_only",
  "body_missing",
  "tool_bodies",
  "model_calls",
  "hooks_partial",
  "unobserved_tail",
  "chain_break",
  "telemetry_gap",
]);

/**
 * What the initiating principal is. It is what tells a reader why a run has no
 * operator name: an agent or a service has no person to name, while a `human`
 * with no name is a person whose record does not hold one.
 */
const OperatorKind = z.enum(["human", "agent", "service"]);

/**
 * The model the run was served by. `provider` is the vendor that served the
 * call and `tier` the capability class it belongs to inside that vendor's
 * family; either is null when the recorded id names none the platform
 * recognises, because a wrong vendor or class reads as a fact the record does
 * not hold.
 */
const RunModel = z.object({
  /**
   * The model id exactly as the store recorded it — a vendor slug such as
   * `claude-sonnet-5`, not a record this platform issues. It is named `slug`
   * rather than `id` because INV-11 reserves an `id` field on a view model for
   * a `PublicId`, and a reader who saw `id` here would reasonably expect one.
   */
  slug: z.string().min(1),
  provider: z.string().min(1).nullable(),
  tier: z.string().min(1).nullable(),
});

/** The machine a wrapped agent ran on. Null for a ledger run, which names no host. */
const RunMachine = z.object({
  recorded: z
    .object({
      platform: z.string().nullable(),
      osVersion: z.string().nullable(),
      arch: z.string().nullable(),
      recordedAt: z.iso.datetime(),
      eventHash: z.string(),
    })
    .optional(),
  hostname: z.string().min(1),
  platform: z.string().min(1),
  osVersion: z.string().min(1).nullable(),
  arch: z.string().min(1).nullable(),
  nodeVersion: z.string().min(1).nullable(),
});

/**
 * Why a pause, resume, steer or cancel cannot reach a wrapped run, mirrored
 * from `list_runs`' `commandBlock` (ADR-163). The enforcement tier is not
 * among them: an `observe`-tier run whose host is polling takes commands.
 */
const CommandBlock = z.enum([
  "run_sealed",
  "no_host",
  "host_revoked",
  "host_offline",
]);

/**
 * Why a run refuses commands. The schema stays module-local, since `RunRow`
 * composes it in this file; the type is exported because the Run controls, a
 * Fleet row's pause and the shared block copy each name one of its members.
 */
export type CommandBlock = z.infer<typeof CommandBlock>;

/**
 * Why a steer cannot reach a run that takes the other commands, mirrored from
 * `list_runs`' `steerBlock` (ADR-163): the harness reads steering text only
 * when a session starts.
 */
export const SteerBlock = z.enum(["no_prompt_carrier"]);
export type SteerBlock = z.infer<typeof SteerBlock>;

/**
 * Why a direct command cannot reach this run, or null when it can.
 *
 * The control plane answers it on the row from the same rule
 * `dispatch_command` refuses on, so a page never offers a control the handler
 * refuses (#3285, ADR-163). A row that carries no answer is read as
 * reachable, and the handler's refusal names the reason if it is not.
 *
 * Every surface that offers a run control answers from here: the Run page's
 * controls and the Fleet row controls. One rule, so a row cannot offer what
 * its run page refuses.
 */
export function commandBlockOf(run: {
  commandBlock?: CommandBlock | null;
}): CommandBlock | null {
  return run.commandBlock ?? null;
}

const Count = z.number().int().nonnegative();

/**
 * A run's token counts by class, from its `cost.run_totals` row. The Run
 * page's cost rollup and the Fleet row read the same shape.
 */
export const RunTokenCounts = z.object({
  inputUncached: Count,
  cacheRead: Count,
  cacheWrite5m: Count,
  cacheWrite1h: Count,
  output: Count,
  reasoning: Count,
});
export type RunTokenCounts = z.infer<typeof RunTokenCounts>;

/**
 * How often a page with no stream reads a live wrapped run again, so its
 * stale light moves without a reload: the host poll window that decides the
 * reading (`HOST_POLL_WINDOW_MS` in `@oxagen/oxagen`, five minutes). A light
 * then trails the host by at most two windows.
 */
export const STALE_REREAD_MS = 5 * 60_000;

/**
 * Whether a later read can change a row's stale light: a live wrapped run,
 * whose host can go quiet or come back. A ledger run has no host to miss.
 */
export function canGoStale(run: {
  status: RunStatus;
  source: "ledger" | "tacho";
}): boolean {
  return run.status === "live" && run.source === "tacho";
}

/** Why an open run reads stale: its host went quiet, or it was revoked. */
export type StaleReason = Extract<
  CommandBlock,
  "host_offline" | "host_revoked"
>;

/**
 * Why an open run's light reads stale, or null when it reads live.
 *
 * - `host_offline`: the host has not checked in within the poll window, five
 *   minutes (`HOST_POLL_WINDOW_MS`). The host polls every few seconds while
 *   its daemon runs, so a laptop that went to sleep or a daemon that was
 *   killed reads stale within minutes rather than live until Oxagen closes
 *   the run after 12 hours with no event.
 * - `host_revoked`: the host's enrollment was revoked, so Oxagen refuses its
 *   polls and its events, and the run is as unreachable as an offline one.
 *
 * A run with no host has no heartbeat to miss. A ledger run, and a wrapped
 * session no host is recorded for, read live until they seal. The Run page
 * reads the row again when its stream says the reading changed. Fleet reads
 * it again every `STALE_REREAD_MS` while it lists a live wrapped run.
 */
export function staleReason(run: {
  status: RunStatus;
  commandBlock?: CommandBlock | null;
}): StaleReason | null {
  if (run.status !== "live") return null;
  return run.commandBlock === "host_offline" ||
    run.commandBlock === "host_revoked"
    ? run.commandBlock
    : null;
}

/** Whether an open run's light reads stale (`staleReason`). */
export function isStale(run: {
  status: RunStatus;
  commandBlock?: CommandBlock | null;
}): boolean {
  return staleReason(run) !== null;
}

/** Token totals by kind, as the recorder counted them. */
/**
 * A pull request (or GitLab merge request) the run's frames name. The URL is
 * as recorded; the page links it only when it parses as a PullRequestUrl.
 * `state` is stored and kept current by forge webhooks (ADR-192). It is null
 * when no forge has reported it, and the page then says "status unknown"
 * rather than guessing "open".
 */
export const RunPullRequest = z.object({
  url: z.string().min(1),
  number: z.number().int().positive().nullable(),
  repository: z.string().min(1).nullable(),
  state: z.enum(["open", "draft", "merged", "closed"]).nullable(),
  /** When Oxagen last read `state`; null when it never has. */
  stateSeenAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type RunPullRequest = z.infer<typeof RunPullRequest>;

/**
 * Lines added and removed. `harness_reported` is the session's own total;
 * `git_observed` is git's uncommitted change, shown until the harness reports.
 */
export const RunDiff = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  basis: z.enum(["harness_reported", "git_observed"]),
});
export type RunDiff = z.infer<typeof RunDiff>;

/** Which runs a Fleet page lists by their pull requests. */
export const PullRequestFilter = z.enum(["any", "with", "without"]);
export type PullRequestFilter = z.infer<typeof PullRequestFilter>;

/** Where an effort value was read, mirrored from `@oxagen/oxagen/run-fit`. */
const EffortSource = z.enum(["request", "harness"]);

const FitCount = z.number().int().nonnegative();

/**
 * The Model fit reading (`runFitSchema` in `@oxagen/oxagen/run-fit`): whether
 * the model class and the effort setting were the right size for the sealed
 * run, with the figures it read and the seal it read. Generated from the
 * record, never the record itself.
 */
const RunFit = z.object({
  method: z.literal("run-fit/v1"),
  readAt: z.iso.datetime({ offset: true }),
  sealedAt: z.iso.datetime({ offset: true }),
  /** Null when the record lacks a figure the reading is keyed on. */
  read: z
    .object({
      prompts: FitCount,
      turns: FitCount,
      steps: FitCount,
      failed: FitCount,
      outputTokens: FitCount.nullable(),
      reasoningTokens: FitCount.nullable(),
    })
    .nullable(),
  /** Null when `read` is null or the model's class sits on no known ladder. */
  model: z
    .discriminatedUnion("verdict", [
      z.object({ verdict: z.literal("fit"), tier: z.string() }),
      z.object({
        verdict: z.enum(["over", "under"]),
        tier: z.string(),
        suggest: z.string(),
      }),
    ])
    .nullable(),
  effort: z.discriminatedUnion("verdict", [
    z.object({
      verdict: z.literal("fit"),
      effort: z.string().max(32),
      source: EffortSource,
    }),
    z.object({
      verdict: z.enum(["over", "under"]),
      effort: z.string().max(32),
      source: EffortSource,
      suggest: z.string().max(32),
    }),
    z.object({
      verdict: z.literal("unseen"),
      why: z.enum(["not_proxied", "not_sent"]),
    }),
  ]),
});

/** The columns `list_runs` orders by, mirrored from its `RUN_SORT_KEYS`. */
export const RunSortKey = z.enum([
  "started",
  "agent",
  "operator",
  "status",
  "tier",
  "replay",
  "cost",
]);
export type RunSortKey = z.infer<typeof RunSortKey>;

/**
 * The replay grades a Fleet page filters on, plus `not_recorded` for a run
 * whose seal recorded none. Mirrored from `list_runs`' `RUN_REPLAY_FILTERS`.
 */
export const RunReplayFilter = z.enum([
  "inspect",
  "view",
  "fork",
  "retry",
  "not_recorded",
]);
export type RunReplayFilter = z.infer<typeof RunReplayFilter>;

const RunTokens = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
});

export const RunRow = z.object({
  id: PublicId,
  /** Which store recorded the run: the evidence ledger or a wrapped agent's session. */
  source: z.enum(["ledger", "tacho"]),
  /** `org_ns.ws_ns.slug` (ADR-024). */
  agentKey: z.string().min(1).nullable(),
  operatorId: PublicId.nullable(),
  operatorKind: OperatorKind.nullable(),
  /** The person's name; null for a principal that is not a person, and for a person with no name recorded. */
  operatorName: z.string().min(1).nullable(),
  status: RunStatus,
  outcome: RunOutcome,
  /** Distinct turns; null for a ledger run whose model-call payloads are encrypted. */
  turns: z.number().int().nonnegative().nullable(),
  /** Model calls plus tool calls. */
  steps: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  cost: Cost.nullable(),
  /**
   * True while `cost` is a running estimate: the run is open, or its rollup
   * predates the seal. The page labels such a figure an estimate.
   */
  costIsEstimate: z.boolean().optional(),
  reportedCost: Cost.nullable().optional(),
  model: RunModel.nullable(),
  /** The effort level the harness reported; null when it reported none. */
  effort: z.string().min(1).nullable().optional(),
  /** Whether always-on thinking was enabled; null when no frame recorded it. */
  thinking: z.boolean().nullable().optional(),
  /** The permission mode the session ended in; null when none was recorded. */
  permissionMode: z.string().min(1).nullable().optional(),
  /** Token totals from the session's counted model calls; null when none were recorded. */
  reportedTokens: RunTokens.nullable().optional(),
  machine: RunMachine.nullable(),
  /**
   * Where a wrapped session ran, as its start recorded it: the working
   * directory and the git branch. Null for a ledger run, and where the
   * session recorded neither. The Run header's checkout strip shows it while
   * the work read is in flight or after it failed.
   *
   * `repository` is the connected repository the session's remote matches,
   * null when none does. `get_run` answers it; a Fleet row leaves it out,
   * which reads as not read.
   */
  place: z
    .object({
      path: z.string().min(1).nullable(),
      branch: z.string().min(1).nullable(),
      repository: z
        .object({
          host: z.string(),
          owner: z.string(),
          name: z.string(),
          url: z.url(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  harness: z
    .object({
      name: z.string(),
      version: z.string().nullable(),
      runtime: z.string().nullable(),
    })
    .nullable()
    .optional(),
  taskRef: z.string().nullable(),
  /** The generated name; null until `summarize_run` wrote one. */
  enrichmentEnabled: z.boolean().optional(),
  /** Why the last automatic name and summary failed; absent once one exists. */
  enrichmentError: z.string().optional(),
  name: z.string().min(1).nullable(),
  summary: RunSummary.nullable(),
  /**
   * The pull requests the frames name. Absent when they were not read: every
   * ledger run, and a page whose read of them failed (`RunPage.warnings`).
   */
  pullRequests: z.array(RunPullRequest).optional(),
  /** `pr_open` calls counted for a wrapped session, some perhaps with no URL recorded. */
  pullRequestsOpened: z.number().int().nonnegative().optional(),
  /** Lines added and removed; null when nothing reported a change. */
  diff: RunDiff.nullable().optional(),
  /**
   * Token counts by class from the run's rollup row; null when the run has
   * no rollup row. Never zero-filled for a missing row.
   */
  tokens: RunTokenCounts.nullable().optional(),
  /**
   * The share of input served from cache, from 0 to 1, weighted by spend.
   * Null when there is no rollup row or it holds none. Never 0 in its place.
   */
  cacheHitRate: z.number().min(0).max(1).nullable().optional(),
  replayGrade: ReplayGrade.nullable(),
  verdict: ProofVerdict.nullable(),
  enforcementTier: EnforcementTier,
  /** Why a command cannot reach this run; null or absent when it can. */
  commandBlock: CommandBlock.nullable().optional(),
  /** Why a steer cannot reach this run; null or absent when it can. */
  steerBlock: SteerBlock.nullable().optional(),
  ingressRevoked: z.boolean().optional(),
  /**
   * The run is paused until someone resumes it. A ledger run reads this from
   * its ingress fence. A live wrapped run reads it from the last pause or
   * resume its host applied (#4112). A sealed wrapped run is never paused.
   */
  ingressPaused: z.boolean().optional(),
  /**
   * True when the run has ended and frame compaction moved its latest sealed
   * attempt's frames to the archive segment (ADR-058). False for a ledger run
   * that has not been compacted. Absent for a wrapped session, whose store
   * records no recording compaction.
   */
  compacted: z.boolean().optional(),
  /** Empty while the run is live, or where the seal recorded none. */
  completenessGaps: z.array(CompletenessGap),
  /**
   * Would `summarize_run` accept this run? The contract answers it from the
   * same rule the handler gates on, so a page that offers the action and a
   * handler that refuses it cannot drift (#3285).
   */
  canSummarize: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }),
  /** When the server recorded the seal; receipt time, so never a wall-clock end. */
  sealedAt: z.iso.datetime({ offset: true }).nullable(),
  /**
   * What sealed the run: `agent_stop`, its host's own end; `idle_timeout`,
   * Oxagen closing a run that sent nothing for 12 hours; or `operator`, a
   * person sealing it with Seal run (ADR-169). Null while open and for a
   * ledger run.
   */
  sealSource: z
    .enum(["agent_stop", "idle_timeout", "operator"])
    .nullable()
    .optional(),
  /** When the run stopped, by the recorder's clock; the end of a wall clock. */
  endedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /**
   * `host_enroller` when the operator is the person who enrolled the machine
   * a wrapped session ran on, which a page labels "enrolled by".
   */
  operatorAttribution: z
    .enum(["initiator", "host_enroller"])
    .nullable()
    .optional(),
  /**
   * The person's avatar value, from the same user row as `operatorName`; null
   * for an agent or service principal and for a person who set none.
   */
  operatorAvatarUrl: z.string().min(1).nullable().optional(),
  /**
   * The operator's workspace role when the run opened, stamped then and never
   * read live. Null when it was not recorded: a run from before the stamp, an
   * operator who is not a person, or a person with no membership here.
   */
  operatorRole: z
    .enum(["owner", "admin", "member", "billing", "compliance", "viewer"])
    .nullable()
    .optional(),
  /**
   * Where `effort` was read: `request` from a proxied request body, which
   * wins, or `harness` from the harness's own report. Null exactly when
   * `effort` is.
   */
  effortSource: EffortSource.nullable().default(null),
  /**
   * The Model fit reading for the sealed run, computed from the record after
   * the seal. Null for a live run, for a reading of an earlier seal, and for a
   * run with no reading yet.
   */
  fit: RunFit.nullable().default(null),
});
export type RunRow = z.infer<typeof RunRow>;

export const RunPage = z.object({
  runs: z.array(RunRow),
  /** Opaque; the next page's cursor, null on the last page. */
  nextCursor: z.string().nullable(),
  /**
   * How many runs in the workspace are live, whatever the page, the cursor
   * or the filter. Absent when the read could not count them.
   */
  liveRuns: z.number().int().nonnegative().optional(),
  /** `pull_requests_unread`: the page's pull requests could not be read. */
  warnings: z.array(z.enum(["pull_requests_unread"])).optional(),
  /**
   * The runs that match every filter and the search, whatever the page. Null
   * when more than `totalBound` match. Absent when the read did not count.
   */
  total: z.number().int().nonnegative().nullable().optional(),
  /** The most runs the read counts; present whenever `total` is. */
  totalBound: z.number().int().positive().optional(),
});
export type RunPage = z.infer<typeof RunPage>;
