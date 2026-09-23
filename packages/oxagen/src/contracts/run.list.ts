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
import { costSchema } from "./spend.shared";

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

export const runItemSchema = z
  .object({
    id: runPublicIdSchema,
    source: runSourceSchema,
    /** A ledger append fence, independent of the external process status. */
    ingressRevoked: z.boolean().optional(),
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
    /** Null until the rollup has priced the run's frames after its seal. */
    cost: runCostSchema.nullable(),
    reportedCost: runCostSchema.nullable().optional(),
    /** The goal a ledger run was admitted for; tacho records none. */
    taskRef: z.string().nullable(),
    /** RFC 3339. */
    startedAt: z.string().datetime(),
    /** RFC 3339; null while the run is live or no seal was recorded. */
    sealedAt: z.string().datetime().nullable(),
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
     * Where the run's actions were observed from (spec §8.4, §13.3). An
     * `observe`-tier session only records what an agent did: it gives Oxagen
     * no connection point, so every direct command is refused and a caller
     * disables the controls rather than offering four that always fail.
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
     * The model the run ended on, falling back to the one it started on; null
     * when the store recorded no model, which is every ledger run.
     */
    model: runModelSchema.nullable(),
    /** The machine the run ran on; null for a ledger run. */
    machine: runMachineSchema.nullable(),
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
    /** The generated name; null until `summarize_run` wrote one. */
    name: z.string().nullable(),
    summary: runSummarySchema.nullable(),
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

export const runList = registerCapability({
  name: "list_runs",
  domain: "run",
  description:
    "List the runs recorded in this workspace, newest first: evidence-ledger runs and root wrapped-agent sessions in one cursor-paged list, with the operator, the model, the machine, status, counts and metered cost each row recorded. The in-app agent's own turns are not listed.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
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
    })
    .strict(),
  output: z
    .object({
      runs: z.array(runItemSchema).max(100),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type RunListInput = z.output<typeof runList.input>;
export type RunListOutput = z.output<typeof runList.output>;
export type RunItem = z.output<typeof runItemSchema>;
