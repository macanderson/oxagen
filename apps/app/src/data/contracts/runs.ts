// A page of runs as the Fleet runs table reads it (ARCHITECTURE.md §1.2),
// from `list_runs`. A field is nullable exactly where the contract may not have
// recorded it (§3.4); a null renders as "not recorded".
import { z } from "zod";
import { PublicId } from "./common";
import { Cost } from "./money";

/** `live`: open. `sealed`: ended with a sealed record. `halted`: an operator or policy stopped it. */
export const RunStatus = z.enum(["live", "sealed", "halted"]);
export type RunStatus = z.infer<typeof RunStatus>;

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
export const RunSummary = z.object({
  text: z.string().min(1),
  generatedAt: z.iso.datetime({ offset: true }),
  /** The model that wrote it, named beside the text so the reader can weigh it. */
  model: z.string().min(1),
});
export type RunSummary = z.infer<typeof RunSummary>;

/**
 * The witness verdict the rollup recorded (spec §8.5, §12.8; ADR-064), from
 * the closed vocabulary the runner writes. Only `flipped` marks a run proven.
 * Null when no witness reported on the run or the rollup has not rebuilt it;
 * a null reads "not recorded", never `unverified`, which is itself a recorded
 * answer a runner reached.
 */
export const ProofVerdict = z.enum([
  "flipped",
  "failing",
  "unmoved",
  "unsatisfied",
  "tampered",
  "unverified",
  "waived",
]);
export type ProofVerdict = z.infer<typeof ProofVerdict>;

/**
 * Where the run's actions were observed from (spec §8.4). `observe` records
 * what an agent did and gives Oxagen no connection point, so every direct
 * command is refused: a page draws the controls disabled rather than offering
 * four that always fail.
 */
export const EnforcementTier = z.enum(["gateway", "harness", "observe"]);
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
export const RunModel = z.object({
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
export type RunModel = z.infer<typeof RunModel>;

/** The machine a wrapped agent ran on. Null for a ledger run, which names no host. */
export const RunMachine = z.object({
  hostname: z.string().min(1),
  platform: z.string().min(1),
  osVersion: z.string().min(1).nullable(),
  arch: z.string().min(1).nullable(),
  nodeVersion: z.string().min(1).nullable(),
});
export type RunMachine = z.infer<typeof RunMachine>;

/**
 * Can a direct command reach this run? An `observe`-tier session only records
 * what an agent did and gives Oxagen no connection point, so a queued pause,
 * resume, steer or cancel would have nothing to travel down (#3285).
 *
 * Every surface that offers a run control answers from here: the Run page's
 * controls and the Fleet row controls. One rule, so a row cannot offer what
 * its run page refuses.
 */
export function acceptsCommands(tier: EnforcementTier): boolean {
  return tier !== "observe";
}

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
  /** Distinct turns; null for a ledger run whose model-call payloads are encrypted. */
  turns: z.number().int().nonnegative().nullable(),
  /** Model calls plus tool calls. */
  steps: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  cost: Cost.nullable(),
  model: RunModel.nullable(),
  machine: RunMachine.nullable(),
  taskRef: z.string().nullable(),
  /** The generated name; null until `summarize_run` wrote one. */
  name: z.string().min(1).nullable(),
  summary: RunSummary.nullable(),
  replayGrade: ReplayGrade.nullable(),
  verdict: ProofVerdict.nullable(),
  enforcementTier: EnforcementTier,
  /** Empty while the run is live, or where the seal recorded none. */
  completenessGaps: z.array(CompletenessGap),
  /**
   * Would `summarize_run` accept this run? The contract answers it from the
   * same rule the handler gates on, so a page that offers the action and a
   * handler that refuses it cannot drift (#3285).
   */
  canSummarize: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }),
  sealedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RunRow = z.infer<typeof RunRow>;

export const RunPage = z.object({
  runs: z.array(RunRow),
  /** Opaque; the next page's cursor, null on the last page. */
  nextCursor: z.string().nullable(),
});
export type RunPage = z.infer<typeof RunPage>;
