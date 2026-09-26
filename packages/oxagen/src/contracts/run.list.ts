/**
 * `list_runs`: the runs table on the Fleet page (apps/app/ARCHITECTURE.md
 * §1.2, WL-18). One list over the two stores that record runs today: the
 * evidence ledger (`agent.agent_runs`, public id `arun_…`) for runs an external
 * engine submits evidence for, and `tacho.sessions` (public id `tse_…`) for
 * wrapped agents. Root sessions only: a subagent chain is part of its parent's
 * run. Newest first, keyset-paged on an opaque cursor.
 *
 * The in-app agent's turns are runs too, admitted on the `chat` and
 * `api-chat` surfaces; they are excluded from this list, because the
 * assistant is Oxagen's and never the customer's (Mockups `71bc546`). `get_run`
 * still opens one by id.
 *
 * A console read is never a governed action (§1.5, ADR-052 exclusion 2):
 * `noBillingGate: true` keeps a page load off the GAU meter and reachable at
 * `remaining = 0`.
 *
 * Every field the store may not have recorded is nullable, and a null is what
 * a caller renders as "not recorded" (§3.4). Nothing here substitutes a zero,
 * a default or a neighbouring column for a value the row does not carry.
 */
import {
  COMPLETENESS_GAP_KINDS,
  GRADE_ENFORCEMENT_TIERS,
  REPLAY_GRADES,
} from "@oxagen/tacho";
import { z } from "zod";
import { PROOF_VERDICTS } from "@oxagen/run-evidence";
import { registerCapability } from "../registry";
import { costSchema, ratioSchema, tokenCountsSchema } from "./spend.shared";

/**
 * The surfaces an in-app agent turn is admitted on (`agent_runs.surface`;
 * `PlatformSurface` in @oxagen/run-ledger). Runs on these surfaces are the
 * assistant's own and stay out of the tenant's run lists.
 */
export const IN_APP_AGENT_SURFACES = ["chat", "api-chat"] as const;

/** A public id either store mints: the prefix names the store. */
export const runPublicIdSchema = z
  .string()
  .regex(/^(arun|tse)_[0-9a-z]+$/, "a run public id (arun_… or tse_…)");

/** Which store recorded the run. Halt and frames depend on it. */
export const runSourceSchema = z.enum(["ledger", "tacho"]);

/**
 * `live`: the run is open. `sealed`: it ended and its record is sealed.
 * `halted`: an operator or policy stopped it (a ledger `cancelled`, a tacho
 * `aborted`).
 *
 * Paused and compacted are facts beside the status, not statuses of their
 * own (ADR-193). A paused open run reads `live` with `ingressPaused: true`,
 * and a compacted ended run reads `sealed` with `compacted: true`. Every
 * open-run gate reads `live`, so a paused run stays open to all of them.
 */
export const runStatusSchema = z.enum(["live", "sealed", "halted"]);

/**
 * How a run ended, in the word its store recorded. `status` is the lifecycle
 * (open, sealed, halted) and three words cannot tell a run that finished from
 * one that failed, so the outcome travels beside it rather than folded into
 * it. Nothing here is derived: each word is the one the row holds.
 *
 * The ledger records `pending`, `running`, `completed`, `failed`, and
 * `cancelled`; `pending` is an admitted run with no attempt yet, which reads
 * `running` because that is the only thing an open run can be said to be
 * doing. A wrapped session records `running`, `completed`, `aborted`,
 * `crashed`, and `unknown`. `aborted` reads `cancelled`, the reading `status`
 * already gives it. `crashed` is a harness that died mid-run. `unknown` is a
 * session that stopped reporting before it recorded an end, and it stays
 * `unknown`: a run that may have finished is not a run that finished.
 */
export const runOutcomeSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "crashed",
  "unknown",
]);

/**
 * A metered cost, read from the run's `cost.run_totals` row (ADR-060). `basis`
 * says who observed the figure: the gateway, the harness that ran the agent,
 * both (`mixed`), or nobody with a price for the model (`estimated`). A
 * number never reads stronger than its basis.
 */
export const runCostSchema = costSchema;

/**
 * The replay grade the seal recorded (spec §8.4): the strongest verb a reader
 * can apply to the recording. Closed and ordered, weakest first. A caller
 * renders the recorded word and never a stronger one.
 */
export const replayGradeSchema = z.enum(REPLAY_GRADES);

/**
 * The generated summary (`summarize_run`, G14): a light-tier model's account
 * of what changed. Labelled generated wherever it renders; the record is the
 * frames.
 */
export const runSummarySchema = z
  .object({
    text: z.string(),
    /** RFC 3339. */
    generatedAt: z.string().datetime(),
    /** The model id that wrote it. */
    model: z.string(),
  })
  .strict();

/**
 * What kind of principal the operator is (`iam.principals.kind`). It is the
 * field that tells a reader why `operatorName` is null: a run started by an
 * agent or a service has no person to name, while a `human` with no name is a
 * person whose name the record does not hold.
 */
export const operatorKindSchema = z.enum(["human", "agent", "service"]);

/**
 * The model the run was served by, as its recorded id and what that id
 * implies. `provider` is the vendor that served the call; `tier` is the
 * capability class the vendor names inside its own family (haiku, sonnet,
 * opus; mini, nano; flash, pro), not a billing tier and not Oxagen's
 * white-labelled fast/balanced/precise. Either is null when the id names none
 * that this platform recognises, because a wrong vendor or class on a run
 * record is worse than an absent one. Neither is ever computed from anything
 * but the id the record holds.
 */
export const runModelSchema = z
  .object({
    /** The model id exactly as the store recorded it. */
    id: z.string(),
    provider: z.string().nullable(),
    tier: z.string().nullable(),
  })
  .strict();

/**
 * The machine the run ran on, from the host the wrapped agent enrolled
 * (`tacho.hosts`). Null for a ledger run, which records evidence an external
 * engine submits and never names a host.
 *
 * The readable host facts live in Postgres under RLS on purpose, and only the
 * digests reach ClickHouse; a caller that reaches this row has already been
 * fenced to the host's own organisation and workspace, so the readable form
 * is what it is shown. Only facts about the machine are carried. The host's
 * local account name (`os_user`) is not, because the operator is already
 * named by `operatorName` and a second, weaker identifier for the same person
 * buys the reader nothing.
 */
export const runMachineSnapshotSchema = z
  .object({
    platform: z.string().nullable(),
    osVersion: z.string().nullable(),
    arch: z.string().nullable(),
    recordedAt: z.string().datetime(),
    eventHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const runMachineSchema = z
  .object({
    hostname: z.string(),
    recorded: runMachineSnapshotSchema.optional(),
    /** The OS family the host enrolled as, e.g. `darwin`, `linux`. */
    platform: z.string(),
    osVersion: z.string().nullable(),
    /** The CPU architecture, e.g. `arm64`. */
    arch: z.string().nullable(),
    nodeVersion: z.string().nullable(),
  })
  .strict();

/**
 * Why an operator command cannot reach a wrapped run (ADR-163).
 *
 * - `run_sealed`: the session recorded an end, so nothing is listening.
 * - `no_host`: the session names no enrolled host to carry the command.
 * - `host_revoked`: the host's enrollment was revoked, so its polls are
 *   refused and it never takes the command.
 * - `host_offline`: the host has not polled within `HOST_POLL_WINDOW_MS`.
 *
 * The enforcement tier is deliberately absent. An `observe`-tier run records
 * policy verdicts without enforcing them, and its operator can still stop it:
 * the host's command poll is the connection point, whatever the tier.
 */
export const COMMAND_BLOCKS = [
  "run_sealed",
  "no_host",
  "host_revoked",
  "host_offline",
] as const;

export type CommandBlock = (typeof COMMAND_BLOCKS)[number];

/**
 * Why a steer or message cannot reach a wrapped run whose host takes the
 * other commands (ADR-163).
 *
 * - `no_prompt_carrier`: the run's harness reads steering text only when a
 *   session starts, and a live session has passed that point.
 */
export const STEER_BLOCKS = ["no_prompt_carrier"] as const;

export type SteerBlock = (typeof STEER_BLOCKS)[number];

/**
 * The runtimes whose hook adapter delivers no steering text to a live
 * session. Stella's adapter hands a hook's `additionalContext` to the agent
 * only at `SessionStart` and answers `{}` to every other event
 * (`stellaAnswer` in `packages/tacho/src/claude-code/stella-adapter.ts`).
 * Pause, resume and cancel still reach these runs through `PreToolUse`.
 */
const NO_PROMPT_CARRIER_RUNTIMES: ReadonlySet<string> = new Set(["stella"]);

/**
 * May a steer or message reach this wrapped run, given its harness? One rule,
 * read by `dispatch_command` and by every row that offers Steer.
 */
export function steerBlockOf(runtime: string | null): SteerBlock | null {
  return runtime !== null && NO_PROMPT_CARRIER_RUNTIMES.has(runtime)
    ? "no_prompt_carrier"
    : null;
}

/**
 * How long a host may go without a poll before its runs read as unreachable.
 * The daemon polls for commands every 2 s and backs off to at most 60 s, or
 * 15 min on a protocol mismatch, so five minutes is several missed polls of a
 * healthy host and short enough that a laptop that went to sleep stops
 * offering controls.
 */
export const HOST_POLL_WINDOW_MS = 5 * 60_000;

/** The most pull requests one row carries; a run that linked more says so with `pullRequestsOpened`. */
export const RUN_PULL_REQUEST_MAX = 10;

/**
 * A pull request (or GitLab merge request) the run's record names: an
 * `oxagen:pr_link` frame the harness wrote, or the URL a `pr_open` call
 * printed. The URL is the one recorded, unvalidated; a caller links it only
 * when it names a forge page it recognises.
 */
export const runPullRequestSchema = z
  .object({
    url: z.string().max(2048),
    /** The number the frame recorded; null when it recorded none. */
    number: z.number().int().positive().nullable(),
    /** `owner/name` as the frame recorded it; null when it recorded none. */
    repository: z.string().max(512).nullable(),
    /**
     * The state read from `tacho.run_pull_requests`, which forge webhooks and
     * one read when the link landed keep current (ADR-192). Null when no row
     * exists or no forge has reported the pull request, and a caller then
     * renders "status unknown", never a guessed "open".
     */
    state: z.enum(["open", "draft", "merged", "closed"]).nullable(),
    /**
     * RFC 3339; when Oxagen last read `state` from the forge. Null when it
     * never has. Absent when the read did not look.
     */
    stateSeenAt: z.string().datetime().nullable().optional(),
  })
  .strict();

/**
 * The lines a run added and removed. `harness_reported` is the session's own
 * total, which the harness reports when the session ends. `git_observed` is
 * the uncommitted change git reported at the last worktree check, used while
 * no harness total exists; committed work leaves it, so it is a floor.
 */
export const runDiffSchema = z
  .object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    basis: z.enum(["harness_reported", "git_observed"]),
  })
  .strict();

/** Which runs a page lists by their pull requests. */
export const RUN_PULL_REQUEST_FILTERS = ["any", "with", "without"] as const;

/**
 * The replay grades a page can filter on, plus `not_recorded` for a run whose
 * seal recorded no grade (`replayGrade: null`).
 */
export const RUN_REPLAY_FILTERS = [...REPLAY_GRADES, "not_recorded"] as const;

/**
 * The columns `list_runs` can order across both stores. Frames, name, pull
 * requests, lines changed and tokens are not here: no single SQL order covers
 * them in both stores, so a page cannot sort on them.
 */
export const RUN_SORT_KEYS = [
  "started",
  "agent",
  "operator",
  "status",
  "tier",
  "replay",
  "cost",
] as const;

/**
 * The most runs `list_runs` counts for `total`, and the largest `offset` it
 * accepts. Past it, `total` reads null and a caller shows the bound with a
 * plus sign.
 */
export const RUN_LIST_TOTAL_BOUND = 10_000;

/**
 * The most UTF-16 code units a run's `name` or `taskRef` carries. A harness
 * title and a ledger run's goal have no cap where they are written (a goal
 * may run to 8,192 characters), so the reads cut a longer one on a
 * code-point boundary and end it with an ellipsis (#4224).
 */
export const RUN_LABEL_MAX = 256;

export const runItemSchema = z
  .object({
    id: runPublicIdSchema,
    source: runSourceSchema,
    /** A ledger append fence, independent of the external process status. */
    ingressRevoked: z.boolean().optional(),
    /**
     * The run is paused until someone resumes it. A ledger run reads this from
     * its ingress fence. A live wrapped run reads it from the last pause or
     * resume its host applied (#4112). A sealed wrapped run is never paused.
     */
    ingressPaused: z.boolean().optional(),
    /** `org_ns.ws_ns.slug` (ADR-024); null when the ledger row names no agent. */
    agentKey: z.string().nullable(),
    /** The initiating principal's public id; null when none was recorded. */
    operatorId: z.string().nullable(),
    /** What the initiating principal is; null when none was recorded. */
    operatorKind: operatorKindSchema.nullable(),
    /**
     * The person's name, from the user the initiating principal acts for.
     * Null for every principal that is not a person, and null for a person
     * whose user record carries no name: `operatorKind` is what separates the
     * two. Never a name derived from an email address, and never an email.
     */
    operatorName: z.string().nullable(),
    /**
     * How the record came to name `operatorId`. `initiator` is the principal
     * the run itself was admitted for. `host_enroller` is the person who
     * enrolled the machine a wrapped session ran on: a wrapped session carries
     * no principal Oxagen can map to an org member, so the enroller is the
     * nearest recorded fact, and a caller labels it "enrolled by" rather than
     * as the person at the keyboard. Null when no operator was recorded.
     */
    operatorAttribution: z.enum(["initiator", "host_enroller"]).nullable(),
    status: runStatusSchema,
    outcome: runOutcomeSchema,
    /**
     * Distinct turns. Null for a ledger run whose model-call payloads are
     * encrypted, since the turn index travels inside them.
     */
    turns: z.number().int().nonnegative().nullable(),
    /** Model calls plus tool calls. */
    steps: z.number().int().nonnegative(),
    /** Recorded events (ledger) or hash-chained events (tacho). */
    frames: z.number().int().nonnegative(),
    /**
     * The run's priced cost, from its rollup row; null until a rollup has
     * priced any of its frames. The row is rebuilt as the run records frames
     * and again at its seal (#3980), so an open run carries a figure too.
     */
    cost: runCostSchema.nullable(),
    /**
     * True while `cost` is a running estimate: the run is still open, or its
     * row was last rebuilt before the seal. False once the rollup has priced
     * the sealed run, and false when there is no cost.
     */
    costIsEstimate: z.boolean().optional(),
    reportedCost: runCostSchema.nullable().optional(),
    /**
     * The goal a ledger run was admitted for, cut to `RUN_LABEL_MAX` with an
     * ellipsis. The run's spec keeps the whole goal. Null for a wrapped
     * session: no dispatch record names its task, and a task is never
     * inferred from a branch name or model output. The issues a session's
     * pull requests close are read by `get_run_work`.
     */
    taskRef: z.string().max(RUN_LABEL_MAX).nullable(),
    /** RFC 3339. */
    startedAt: z.string().datetime(),
    /**
     * RFC 3339; when the server recorded the seal. Null while the run is live
     * or no seal was recorded. This is receipt time, which trails the stop by
     * however long the host took to ship it; a wall clock reads `endedAt`.
     */
    sealedAt: z.string().datetime().nullable(),
    /**
     * What sealed a wrapped session: `agent_stop`, its host's own end,
     * which the host's next `agent_start` on the chain reopens (ADR-172);
     * `idle_timeout`, the control plane closing a run that sent nothing for
     * twelve hours, which the run's next event reopens; or `operator`, a
     * person sealing it through `seal_run` (ADR-169), which is final. Null
     * while the run is open, and for a ledger run.
     */
    sealSource: z
      .enum(["agent_stop", "idle_timeout", "operator"])
      .nullable()
      .optional(),
    /**
     * RFC 3339; when the run stopped, by the recorder's own clock: the stop
     * event's timestamp for a wrapped session, the seal for a ledger run.
     * For a session Oxagen closed for silence (`sealSource: idle_timeout`)
     * it is the last event recorded, since no stop was. Null while the run is
     * live or no stop was recorded.
     */
    endedAt: z.string().datetime().nullable(),
    /**
     * The grade the seal recorded; null while the run is live or its seal
     * predates the recorder. Never computed on read.
     */
    replayGrade: replayGradeSchema.nullable(),
    /**
     * The run's witness verdict as the rollup recorded it (spec §8.5, §12.8;
     * ADR-064); null when no witness reported on the run or the rollup has
     * not rebuilt it. Only `flipped` marks a run proven.
     */
    verdict: z.enum(PROOF_VERDICTS).nullable(),
    /**
     * Where the run's actions were observed from (spec §8.4, §13.3). The tier
     * says how much of a policy verdict Oxagen could enforce. It does not
     * decide whether the operator's controls reach the run: that is
     * `commandBlock` (ADR-163).
     *
     * A ledger run has no recorded tier of its own: its evidence is submitted
     * by an engine Oxagen did not host (ADR-043), which is `harness`, unless
     * its model calls were observed at Oxagen's own gateway.
     */
    enforcementTier: z.enum(GRADE_ENFORCEMENT_TIERS),
    /**
     * The gaps the seal recorded (spec §13.1), empty while the run is live or
     * where the seal recorded none. An unknown word the store holds is dropped
     * rather than passed on: a caller decides from a closed vocabulary.
     */
    completenessGaps: z.array(z.enum(COMPLETENESS_GAP_KINDS)),
    /**
     * Would `summarize_run` accept this run? The capability refuses a live run
     * and a `digest_only` recording, and a caller that cannot see why offers a
     * button that is guaranteed to end in a conflict. Both read one rule
     * (`canSummarizeRun`), so the row and the handler cannot drift.
     */
    canSummarize: z.boolean(),
    /**
     * Why a pause, resume, steer or cancel cannot reach this run, or null when
     * it can. `dispatch_command` refuses on the same rule (`commandBlockOf`),
     * so a row never offers a control its handler refuses (ADR-163). Always
     * null for a ledger run, whose controls fence evidence ingress instead.
     * Optional so a row built before the field reads as "not known", which a
     * caller treats as deliverable and lets the handler decide.
     */
    commandBlock: z.enum(COMMAND_BLOCKS).nullable().optional(),
    /**
     * Why a steer or message cannot reach this run when the other commands
     * can, or null when it can. `dispatch_command` refuses on the same rule
     * (`steerBlockOf`). Null for a ledger run. Optional, read like
     * `commandBlock`: absent means not known.
     */
    steerBlock: z.enum(STEER_BLOCKS).nullable().optional(),
    /**
     * The model the run ended on, falling back to the one it started on; null
     * when the store recorded no model, which is every ledger run.
     */
    model: runModelSchema.nullable(),
    /**
     * The effort level the harness reported in its context frames, as it
     * reported it. Null when the harness reported none, and for every ledger
     * run. Oxagen never infers one.
     */
    effort: z.string().nullable().optional(),
    /**
     * Whether the session had always-on thinking enabled, from the latest
     * session config frame. Null when no frame recorded it, and for every
     * ledger run. `get_run` answers it; `list_runs` leaves it out.
     */
    thinking: z.boolean().nullable().optional(),
    /**
     * The permission mode the session ended in, falling back to the one it
     * started in. Null when none was recorded, and for every ledger run.
     */
    permissionMode: z.string().nullable().optional(),
    /**
     * Token totals ingest folded from the session's counted model calls. Null
     * when the session recorded no usage, and for every ledger run. The
     * rollup's totals win over these once it has priced the run.
     */
    reportedTokens: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
      })
      .strict()
      .nullable()
      .optional(),
    /** The machine the run ran on; null for a ledger run. */
    machine: runMachineSchema.nullable(),
    /**
     * Where a wrapped session ran, as its start recorded it: the working
     * directory and the git branch (the worktree's branch when it ran in one).
     * Each is null where the session recorded none, and the whole is null for
     * a ledger run, which records no host.
     *
     * `repository` is the connected repository whose remote matches the
     * digest the session recorded, or null when none matches. The session
     * keeps only that digest, so naming the repository takes a read of the
     * workspace's connected repositories: `get_run` makes it, and `list_runs`
     * does not, so a list row leaves `repository` out.
     */
    place: z
      .object({
        path: z.string().nullable(),
        branch: z.string().nullable(),
        repository: z
          .object({
            host: z.string(),
            owner: z.string(),
            name: z.string(),
            url: z.string().url(),
          })
          .strict()
          .nullable()
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
    /** The recorded agent harness, independent of its model and wrapper. */
    harness: z
      .object({
        name: z.string(),
        version: z.string().nullable(),
        runtime: z.string().nullable(),
      })
      .nullable()
      .optional(),
    /** False when the workspace turned automatic run names and summaries off (ADR-153). */
    enrichmentEnabled: z.boolean().optional(),
    /**
     * Why the last automatic account failed, as a short reason code such as
     * `model_refused` or `credit_refused:<code>`. Absent once an account exists.
     */
    enrichmentError: z.string().optional(),
    /**
     * What the run is called, cut to `RUN_LABEL_MAX` with an ellipsis. A
     * wrapped session reads the title its harness gave it first, then the
     * name Oxagen wrote (the model's, or the fallback from the first
     * prompt), then the title ingest derived. A ledger run reads the name
     * Oxagen wrote. With automatic accounts turned off, only the harness
     * title is read. Null when there is none.
     */
    name: z.string().max(RUN_LABEL_MAX).nullable(),
    summary: runSummarySchema.nullable(),
    /**
     * The pull requests the run's frames name, earliest first. Absent when
     * they were not read: every ledger run (its receipts name a repository
     * id, not a page, and are read by `get_run_work`), and a wrapped session
     * whose frames could not be read (the page then carries a warning). An
     * empty array is a read that found none.
     */
    pullRequests: z
      .array(runPullRequestSchema)
      .max(RUN_PULL_REQUEST_MAX)
      .optional(),
    /**
     * How many `pr_open` calls ingest counted for a wrapped session, including
     * any whose output named no URL. Absent for a ledger run.
     */
    pullRequestsOpened: z.number().int().nonnegative().optional(),
    /** Lines added and removed; null when neither the harness nor git reported any. */
    diff: runDiffSchema.nullable().optional(),
    /**
     * The run's token counts by class, from its `cost.run_totals` row. Null
     * when the run has no rollup row. The column is NOT NULL, so an unpriced
     * row still carries counts. Never zero-filled for a missing row. Absent
     * when the read did not look.
     */
    tokens: tokenCountsSchema.nullable().optional(),
    /**
     * `cost.run_totals.cache_hit_rate`: cache reads over uncached input plus
     * cache reads, weighted by spend over the run's frames, from 0 to 1. Null
     * when there is no row or the row holds none. Never 0 in place of a
     * missing figure.
     */
    cacheHitRate: ratioSchema.nullable().optional(),
    /**
     * True when the run has ended and frame compaction removed its latest
     * sealed attempt's hot frames, so the run is read from its archive segment
     * (ADR-058). False for a ledger run that has not been compacted. Absent for
     * a wrapped session, whose store records no recording compaction.
     * `tacho.sessions.num_compactions` counts context compactions and is never
     * read for this.
     */
    compacted: z.boolean().optional(),
  })
  .strict();

/**
 * May a run be summarised? `summarize_run`'s gate, as one rule both its
 * handler and every row that offers the action read (#3285).
 *
 * A live run is refused because the record is not yet complete; a
 * `digest_only` recording is refused because there are no bodies for a model
 * to read and a summary written from receipts alone would be the placeholder
 * the interface forbids.
 */
export function canSummarizeRun(input: {
  status: z.output<typeof runStatusSchema>;
  completenessGaps: readonly string[];
}): boolean {
  if (input.status === "live") return false;
  return !input.completenessGaps.includes("digest_only");
}

/**
 * May an operator command reach this wrapped run? One rule, read by
 * `dispatch_command` and by every row that offers the controls.
 */
export function commandBlockOf(input: {
  /** `tacho.sessions.outcome`; `running` is live. */
  outcome: string;
  /**
   * Who ended the session. `idle_timeout` is the control plane closing a
   * session for silence (ADR-159), not the host's word, so a host that is
   * still polling can take the command and its next frame reopens the run.
   * Absent where the store does not record it.
   */
  sealSource?: string | null;
  /** The session's host, or null when it names none. */
  host: { status: string; lastSeenAt: Date | null } | null;
  now: Date;
}): CommandBlock | null {
  if (input.outcome !== "running" && input.sealSource !== "idle_timeout")
    return "run_sealed";
  if (input.host === null) return "no_host";
  if (input.host.status === "revoked") return "host_revoked";
  const seen = input.host.lastSeenAt?.getTime() ?? null;
  if (seen === null || input.now.getTime() - seen > HOST_POLL_WINDOW_MS)
    return "host_offline";
  return null;
}

export const runList = registerCapability({
  name: "list_runs",
  domain: "run",
  description:
    "List the runs recorded in this workspace, newest first: evidence-ledger runs and root wrapped-agent sessions in one cursor-paged list, with the operator, the model, the machine, status, counts and metered cost each row recorded. The in-app agent's own turns are not listed.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "run" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      limit: z.number().int().min(1).max(100).default(50),
      /** Opaque; only a cursor this capability returned is accepted. */
      cursor: z.string().max(256).optional(),
      /**
       * Absent or `any` lists every run. `with` lists wrapped sessions whose
       * record names a pull request or counted one opened; `without` lists
       * those that do neither. Either leaves out ledger runs, whose pull
       * requests this read cannot see.
       * A filtered page may hold fewer than `limit` runs with a `nextCursor`:
       * the read looks through a bounded number of runs per page.
       */
      pullRequests: z.enum(RUN_PULL_REQUEST_FILTERS).optional(),
      /*
       * The filters, search, sort and offset below are optional with no
       * default, so a call that sends none lists exactly as a call before
       * them did (#3837).
       */
      /** Only runs in these statuses. Absent lists every status. */
      status: z.array(runStatusSchema).min(1).max(3).optional(),
      /**
       * Only runs published at these tiers. A ledger run with no graded seal
       * reads `harness`.
       */
      tier: z.array(z.enum(GRADE_ENFORCEMENT_TIERS)).min(1).max(4).optional(),
      /** Only runs with these grades; `not_recorded` matches a null grade. */
      replayGrade: z.array(z.enum(RUN_REPLAY_FILTERS)).min(1).max(5).optional(),
      /**
       * A case-insensitive substring matched against the public id, the name,
       * the harness title, the agent key, the operator's name, the model id,
       * the hostname, and a ledger run's goal.
       */
      query: z.string().trim().min(1).max(200).optional(),
      /**
       * The order of the list. Absent means `started` descending. Nulls sort
       * last in both directions.
       */
      sort: z
        .object({
          key: z.enum(RUN_SORT_KEYS),
          dir: z.enum(["asc", "desc"]),
        })
        .strict()
        .optional(),
      /**
       * Rows to skip in the filtered, sorted list. The handler refuses an
       * `offset` sent with a `cursor` as `invalid_input` (`cursor_with_offset`).
       */
      offset: z.number().int().min(0).max(RUN_LIST_TOTAL_BOUND).optional(),
      /**
       * Answer `total` and `totalBound`. Counting reads every matching row in
       * both stores up to the bound, so a caller that prints no pager (a
       * picker, the agents page) leaves it off and pays for the page alone.
       */
      count: z.boolean().optional(),
      /**
       * `true` answers `liveRuns`, the workspace's live count. The count reads
       * every root session the workspace holds, so a read that does not show
       * it leaves this out and pays nothing for it. Fleet sets it.
       */
      countLive: z.boolean().optional(),
    })
    .strict(),
  output: z
    .object({
      runs: z.array(runItemSchema).max(100),
      nextCursor: z.string().nullable(),
      /**
       * How many runs in the workspace are live, whatever the page, the
       * cursor or the pull-request filter: the ledger runs still running and
       * the root wrapped sessions still open that `list_runs` would list. A
       * wrapped session whose host is revoked or has not polled within
       * `HOST_POLL_WINDOW_MS` is not counted, since its row reads stale. A
       * session with no host is counted. Answered only when the input sets
       * `countLive`, and absent when the count could not be read.
       */
      liveRuns: z.number().int().nonnegative().optional(),
      /**
       * `pull_requests_unread`: the pull-request frames could not be read, so
       * rows carry no `pullRequests` and a filtered page decided on the
       * counted `pr_open` calls alone.
       */
      warnings: z.array(z.enum(["pull_requests_unread"])).optional(),
      /**
       * The runs that match every filter and the search across both stores,
       * whatever the page. Null when more than `totalBound` match. Absent when
       * the read did not count: the caller did not ask (`count`), a
       * `pullRequests` filter of `with` or `without`, which only the
       * ClickHouse frames answer, or a count that failed.
       */
      total: z.number().int().nonnegative().nullable().optional(),
      /** `RUN_LIST_TOTAL_BOUND`, present whenever `total` is. */
      totalBound: z.number().int().positive().optional(),
    })
    .strict(),
});

export type RunListInput = z.output<typeof runList.input>;
export type RunListOutput = z.output<typeof runList.output>;
export type RunItem = z.output<typeof runItemSchema>;
export type RunPullRequest = z.output<typeof runPullRequestSchema>;
export type RunDiff = z.output<typeof runDiffSchema>;
export type RunPullRequestFilter = (typeof RUN_PULL_REQUEST_FILTERS)[number];
export type RunSortKey = (typeof RUN_SORT_KEYS)[number];
export type RunReplayFilter = (typeof RUN_REPLAY_FILTERS)[number];
