/**
 * `list_runs`: the runs table on the Fleet page (apps/app/ARCHITECTURE.md
 * §1.2, WL-18). One list over the two stores that record runs today: the
 * evidence ledger (`agent.agent_runs`, public id `arun_…`) for runs an external
 * engine submits evidence for, and `tacho.sessions` (public id `tse_…`) for
 * wrapped agents. Root sessions only: a subagent chain is part of its parent's
 * run. Newest first, keyset-paged on an opaque cursor.
 *
 * A console read is never a governed action (§1.5, ADR-052 exclusion 2):
 * `noBillingGate: true` keeps a page load off the GAU meter and reachable at
 * `remaining = 0`.
 *
 * Every field the store may not have recorded is nullable, and a null is what
 * a caller renders as "not recorded" (§3.4). Nothing here substitutes a zero,
 * a default or a neighbouring column for a value the row does not carry.
 */
import { REPLAY_GRADES } from "@oxagen/tacho";
import { z } from "zod";
import { PROOF_VERDICTS } from "@oxagen/run-evidence";
import { registerCapability } from "../registry";
import { costSchema } from "./spend.shared";

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

export const runItemSchema = z
  .object({
    id: runPublicIdSchema,
    source: runSourceSchema,
    /** `org_ns.ws_ns.slug` (ADR-024); null when the ledger row names no agent. */
    agentKey: z.string().nullable(),
    /** The initiating principal's public id; null when none was recorded. */
    operatorId: z.string().nullable(),
    status: runStatusSchema,
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
    /** The generated name; null until `summarize_run` wrote one. */
    name: z.string().nullable(),
    summary: runSummarySchema.nullable(),
  })
  .strict();

export const runList = registerCapability({
  name: "list_runs",
  domain: "run",
  description:
    "List the runs recorded in this workspace, newest first: evidence-ledger runs and root wrapped-agent sessions in one cursor-paged list, with the operator, status, counts and metered cost each row recorded.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
