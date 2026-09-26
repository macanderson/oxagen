// The run row's record types and the mappers that turn a ledger run or a
// wrapped session into a `list_runs` row (`RunItem`). Moved out of
// `run.list.ts` unchanged to keep that file under 1,500 lines. `run.list.ts`
// re-exports every name it exported before, so importers keep their path.
//
// Every field the store may not have recorded maps to null, never to a
// substitute.
import {
  canSummarizeRun,
  commandBlockOf,
  RUN_LABEL_MAX,
  steerBlockOf,
  type RunItem,
  runMachineSnapshotSchema,
} from "@oxagen/oxagen/contracts/run.list";
import {
  type CompletenessGapKind,
  cutLabel,
  isCompletenessGapKind,
  isGradeEnforcementTier,
  isReplayGrade,
} from "@oxagen/tacho";
import { modelFactsOf } from "./model-facts";
import { compactedField } from "./run-list-status";
import { type RollupTokenColumns, rollupTokenFields } from "./run-list-tokens";

/** The generated summary columns a run row carries (`summarize_run`, G14). */
type GeneratedSummaryColumns = {
  name: string | null;
  /**
   * The deterministic fallback a wrapped session's ingest derives. A ledger
   * run has no such column, so it is optional here rather than shared.
   */
  title?: string | null;
  /** The title the harness gave the session itself; wrapped sessions only. */
  harnessTitle?: string | null;
  summary: string | null;
  summaryGeneratedAt: Date | null;
  summaryModel: string | null;
  /** Why the last automatic account failed, as a short reason code. */
  summaryError?: string | null;
};

type LedgerRunCore = GeneratedSummaryColumns & {
  runId: string;
  publicId: string;
  /** `agent_runs.status` (CHECK: pending, running, completed, failed, cancelled). */
  status: string;
  ingressRevoked?: boolean;
  ingressPaused?: boolean;
  createdAt: Date;
  startedAt: Date | null;
};

export type LedgerRunIdentity = {
  orgNamespace: string | null;
  workspaceNamespace: string | null;
  agentSlug: string | null;
  /** `iam.principals.public_id` for `agent_runs.initiating_principal_id`. */
  operatorPublicId: string | null;
  /** `iam.principals.kind`; null when no principal was recorded. */
  operatorKind: string | null;
  /** `auth.users.display_name` for a human principal; null for any other. */
  operatorUserName: string | null;
  /** `agent_runs.spec->>'goal'`: the task a run was admitted for. */
  goal: string | null;
};

export type LedgerRunRow = { run: LedgerRunCore; identity: LedgerRunIdentity };

/**
 * Counts folded from a run's V2 events. A step is one model call or one tool
 * call; a turn is a distinct `turn_index` among model calls, which travels
 * only in an inline payload, so an encrypted model call hides its turn.
 */
export type LedgerEventRollup = {
  frames: number;
  modelCalls: number;
  toolCalls: number;
  turnIndexes: number;
  opaqueModelCalls: number;
};

/** The durable event log is the authority: no events means zero of each. */
export const EMPTY_ROLLUP: LedgerEventRollup = {
  frames: 0,
  modelCalls: 0,
  toolCalls: 0,
  turnIndexes: 0,
  opaqueModelCalls: 0,
};

/** The latest seal of a run, as `ledgerSealQuery` reads it. */
export type LedgerSeal = {
  runId: string;
  attemptId: string;
  sealedAt: Date;
  /** Null on a seal written before the recorder graded. */
  replayGrade: string | null;
  completenessGaps: unknown;
  finalRunSeq: string | null;
  eventCount: number;
  merkleRoot: string | null;
  archiveSegmentRef: string | null;
  /** Null on a seal written before the column existed; read as `harness`. */
  enforcementTier: string | null;
  /** How the sealed attempt ended, as the seal recorded it. */
  terminalStatus: string;
  /** The digest of the attempt's last frame; null when it recorded none. */
  finalEventDigest: string | null;
  /** The fold of every frame digest in sequence; always written. */
  eventStreamDigest: string;
  /**
   * Whether frame compaction moved the attempt's frames to its archive
   * segment (`compactedProbe`, ADR-193). Absent when the read did not ask.
   */
  compacted?: boolean;
};

export type LedgerRunRecord = LedgerRunRow & {
  rollup: LedgerEventRollup;
  /** The latest attempt seal; null while the run is open or none was recorded. */
  seal: LedgerSeal | null;
};

/** What a `cost.run_totals` row says about a run's spend. */
export type RunCost = {
  costMicros: bigint;
  currency: string;
  costBasis: NonNullable<RunItem["cost"]>["basis"];
};

/**
 * What a `cost.run_totals` row says about a run: its spend, its witness
 * verdict, and whether the run had sealed when the row was rebuilt (null: it
 * had not, so the spend is a running estimate).
 */
export type RunRollup = RollupTokenColumns & {
  cost: RunCost | null;
  verdict: RunItem["verdict"];
  sealedAt: Date | null;
};

export type TachoSessionColumns = GeneratedSummaryColumns & {
  harness?: string;
  harnessVersion?: string | null;
  runtime?: string;
  machineSnapshot?: unknown;
  /** `tacho.sessions.id`; foreign key for checkpoints and rollups. */
  id: string;
  publicId: string;
  sessionUuid: string;
  agentKey: string;
  outcome: string;
  numTurns: number;
  numModelCalls: number;
  numToolCalls: number;
  seqCount: number;
  startedAt: Date;
  /**
   * The row's server-clock birth, at or before its first frame's receipt.
   * Absent where a reader did not select it.
   */
  createdAt?: Date;
  sealedAt: Date | null;
  /** `agent_stop`, `idle_timeout` or `operator`; null while open or on a seal older than the column. */
  sealSource?: string | null;
  /** The `agent_stop` event's own timestamp, or after an idle close or an operator's seal the last event's; null while open. */
  endedAt?: Date | null;
  /** The model the session started on and the one it ended on; either may be unrecorded. */
  modelInitial: string | null;
  modelFinal: string | null;
  totalCostMicros?: number;
  costBasis?: string | null;
  /** The effort level the harness reported in its context frames. */
  effort?: string | null;
  /** The directories and git branches the session's start recorded; absent where not selected. */
  cwd?: string | null;
  projectDir?: string | null;
  worktreePath?: string | null;
  gitBranch?: string | null;
  worktreeBranch?: string | null;
  /** The digest of the session's git remote; absent where not selected. */
  gitRemoteDigest?: string | null;
  permissionModeInitial?: string | null;
  permissionModeFinal?: string | null;
  /** Token counters ingest folds from the session's counted `llm_call` frames. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** `pr_open` calls ingest counted; absent where a reader did not select it. */
  pullRequests?: number;
  /** The harness's line totals, written at the session's end; absent where not selected. */
  linesAdded?: number;
  linesRemoved?: number;
  /** Written by the seal at `agent_stop`; null while the session is open. */
  replayGrade: string | null;
  completenessGaps: unknown;
  /** `tacho.sessions.chain_verified`: false from the first chain break on. Absent where a reader did not select it. */
  chainVerified?: boolean;
  enforcementTier: string;
  /** The sealed commitment for the whole session; null while open. */
  finalHash: string | null;
  /**
   * The last pause or resume the host applied was a pause. Absent where a
   * reader did not select it.
   */
  paused?: boolean;
};

/**
 * The host columns the session's join carries. Every one is null when the
 * session names no host, or names one the workspace cannot read.
 */
export type TachoHostColumns = {
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  arch: string | null;
  nodeVersion: string | null;
  /** `tacho.hosts.status`; absent where a reader did not select it. */
  status?: string | null;
  /** The host's last poll; absent where a reader did not select it. */
  lastSeenAt?: Date | null;
};

export type TachoSessionRow = {
  session: TachoSessionColumns;
  /** `iam.principals.public_id` for `initiating_principal_id`. */
  operatorPublicId: string | null;
  /** `iam.principals.kind`; null when no principal was recorded. */
  operatorKind: string | null;
  /** `auth.users.display_name` for a human principal; null for any other. */
  operatorUserName: string | null;
  /** The enrolled host the session ran on, as its left join read it. */
  host: TachoHostColumns | null;
};

/**
 * The agent key `org_ns.ws_ns.slug` (ADR-024), or null when a namespace or the
 * slug is missing, never a malformed `..slug`.
 */
export function composeAgentKey(
  orgNamespace: string | null,
  workspaceNamespace: string | null,
  slug: string | null,
): string | null {
  if (!orgNamespace || !workspaceNamespace || !slug) return null;
  return `${orgNamespace}.${workspaceNamespace}.${slug}`;
}

const LEDGER_RUN_STATUS: Readonly<Record<string, RunItem["status"]>> = {
  pending: "live",
  running: "live",
  completed: "sealed",
  failed: "sealed",
  cancelled: "halted",
};

/**
 * The ledger statuses `ledgerRunStatus` reads as live, from its own table, so
 * the count and the rows cannot disagree on which runs are open.
 */
export const LEDGER_LIVE_STATUSES: readonly string[] = Object.keys(
  LEDGER_RUN_STATUS,
).filter((status) => LEDGER_RUN_STATUS[status] === "live");

/** The session outcomes `tachoRunStatus` reads as live. */
export const TACHO_LIVE_OUTCOMES: readonly string[] = ["running"];

/**
 * `pending` (admitted, no attempt yet) and `running` are both open runs. Every
 * terminal outcome is sealed except a cancel, which is a halt. A word outside
 * the column's CHECK is a broken row, and the read fails rather than guesses.
 */
export function ledgerRunStatus(status: string): RunItem["status"] {
  const mapped = Object.hasOwn(LEDGER_RUN_STATUS, status)
    ? LEDGER_RUN_STATUS[status]
    : undefined;
  if (!mapped)
    throw new RangeError(`ledger run status outside the CHECK: ${status}`);
  return mapped;
}

const LEDGER_RUN_OUTCOME: Readonly<Record<string, RunItem["outcome"]>> = {
  pending: "running",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * The word the ledger row holds, carried through. `status` folds `completed`
 * and `failed` into one word because both are sealed, so a reader who needs
 * to know which of the two happened reads this instead. A word outside the
 * column's CHECK is a broken row, and the read fails rather than guesses.
 */
export function ledgerRunOutcome(status: string): RunItem["outcome"] {
  const mapped = Object.hasOwn(LEDGER_RUN_OUTCOME, status)
    ? LEDGER_RUN_OUTCOME[status]
    : undefined;
  if (!mapped)
    throw new RangeError(`ledger run status outside the CHECK: ${status}`);
  return mapped;
}

/**
 * The recorded grade, or null: a seal the recorder never graded, an open run,
 * or a word outside the ladder (a broken row reads as ungraded, never as a
 * stronger word). Nothing computes a grade on read.
 */
function recordedGrade(grade: string | null): RunItem["replayGrade"] {
  return isReplayGrade(grade) ? grade : null;
}

/** The gaps column as a string list; anything else is no gaps. */
export function recordedGaps(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * The gaps a row publishes: the recorded list narrowed to the closed
 * vocabulary. A word the store holds that the vocabulary does not name is
 * dropped rather than passed on, because a caller decides from a closed set
 * and cannot act on a gap kind it has never heard of.
 */
export function publishedGaps(value: unknown): CompletenessGapKind[] {
  return recordedGaps(value).filter(isCompletenessGapKind);
}

/**
 * Where a recording's actions were observed from. A wrapped session records
 * its own tier; a ledger run's seal records the tier it was graded under, and
 * a seal written before that column existed — or a run that has not sealed —
 * reads as `harness`, which is what a submitted recording is (ADR-043).
 */
export function publishedTier(value: unknown): RunItem["enforcementTier"] {
  return isGradeEnforcementTier(value) ? value : "harness";
}

/** The generated summary, present only when all three columns were set together. */
function generatedSummary(
  columns: GeneratedSummaryColumns,
): RunItem["summary"] {
  if (
    columns.summary === null ||
    columns.summaryGeneratedAt === null ||
    columns.summaryModel === null
  )
    return null;
  return {
    text: columns.summary,
    generatedAt: columns.summaryGeneratedAt.toISOString(),
    model: columns.summaryModel,
  };
}

/** The failure reason, carried only while the run has no account to show. */
function enrichmentError(
  columns: GeneratedSummaryColumns,
): Pick<RunItem, "enrichmentError"> {
  return columns.summaryError && generatedSummary(columns) === null
    ? { enrichmentError: columns.summaryError }
    : {};
}

/** Integer micro-units as the wire's decimal string; refuses a float or NaN. */
export function microsString(micros: number): string {
  if (!Number.isSafeInteger(micros))
    throw new RangeError(
      `cost micros must be a safe integer: ${String(micros)}`,
    );
  return String(micros);
}

/**
 * The run's cost as its rollup row records it. No row yet — the rollup has
 * not priced any of its frames — means no cost, never zero.
 */
function rollupCost(rollup: RunRollup | undefined): RunItem["cost"] {
  const row = rollup?.cost;
  if (!row) return null;
  return {
    micros: row.costMicros.toString(),
    currency: row.currency,
    basis: row.costBasis,
  };
}

/**
 * Whether the run's cost is still an estimate: the run is open, or its row
 * was rebuilt before the seal and the seal's rollup has not landed yet.
 */
export function costIsEstimate(
  runSealedAt: Date | string | null,
  rollup: RunRollup | undefined,
): boolean {
  if (!rollup?.cost) return false;
  return runSealedAt === null || rollup.sealedAt === null;
}

/**
 * What sealed a sealed session. A seal written before `seal_source` existed
 * was an `agent_stop`, which is the only thing that sealed a session then.
 * `operator` is a person's `seal_run` (#4073).
 */
export function recordedSealSource(
  sealedAt: Date | null,
  source: string | null | undefined,
): RunItem["sealSource"] {
  if (sealedAt === null) return null;
  if (source === "idle_timeout") return "idle_timeout";
  if (source === "operator") return "operator";
  if (source === null || source === undefined || source === "agent_stop")
    return "agent_stop";
  throw new RangeError(
    `tacho session seal source outside the CHECK: ${source}`,
  );
}

/**
 * A run's name or task reference as the reads return it: cut to
 * `RUN_LABEL_MAX` with an ellipsis (#4224). A ledger run's goal may run to
 * 8,192 characters, and a harness title stored before ingest cut it has no
 * bound, so every read cuts rather than trusting the column.
 */
export function runLabel(text: string | null | undefined): string | null {
  return text == null ? null : cutLabel(text, RUN_LABEL_MAX);
}

/** A column an enrolment left empty reads as unrecorded, never as a value. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;

/**
 * The principal's kind as the column's CHECK spells it, or null. A word
 * outside the CHECK is a broken row, and it reads as "not recorded" rather
 * than as a kind this reader would draw conclusions from.
 */
export function principalKind(kind: string | null): RunItem["operatorKind"] {
  return PRINCIPAL_KINDS.find((known) => known === kind) ?? null;
}

/**
 * The machine as its host row records it, or null. A session with no host, and
 * a host row whose join found nothing, both answer null; the two facts the
 * host table requires (`hostname` and `platform`) are what a row is judged
 * present by, and the optional ones stay null where the enrolment left them.
 */
export function toRunMachine(
  host: TachoHostColumns | null | undefined,
  snapshot?: unknown,
): RunItem["machine"] {
  const hostname = host?.hostname?.trim() ?? "";
  const platform = host?.platform?.trim() ?? "";
  if (hostname.length === 0 || platform.length === 0) return null;
  const recorded = runMachineSnapshotSchema.safeParse(snapshot);
  return {
    hostname,
    ...(recorded.success ? { recorded: recorded.data } : {}),
    platform,
    osVersion: blankToNull(host?.osVersion),
    arch: blankToNull(host?.arch),
    nodeVersion: blankToNull(host?.nodeVersion),
  };
}

export function toLedgerRunItem(
  record: LedgerRunRecord,
  totals: RunRollup | undefined,
): RunItem {
  const { run, identity, rollup } = record;
  const status = ledgerRunStatus(run.status);
  const outcome = ledgerRunOutcome(run.status);
  // A live run has sealed nothing, so it has recorded no gaps — not "none".
  const gaps =
    status === "live" ? [] : publishedGaps(record.seal?.completenessGaps);
  return {
    id: run.publicId,
    source: "ledger",
    ingressRevoked: run.ingressRevoked ?? false,
    ingressPaused: run.ingressPaused ?? false,
    agentKey: composeAgentKey(
      identity.orgNamespace,
      identity.workspaceNamespace,
      identity.agentSlug,
    ),
    operatorId: identity.operatorPublicId,
    operatorKind: principalKind(identity.operatorKind),
    operatorName: blankToNull(identity.operatorUserName),
    operatorAttribution: identity.operatorPublicId ? "initiator" : null,
    status,
    outcome,
    turns: rollup.opaqueModelCalls === 0 ? rollup.turnIndexes : null,
    steps: rollup.modelCalls + rollup.toolCalls,
    frames: rollup.frames,
    cost: rollupCost(totals),
    costIsEstimate: costIsEstimate(
      status === "live" ? null : (record.seal?.sealedAt ?? null),
      totals,
    ),
    ...rollupTokenFields(totals),
    taskRef: runLabel(identity.goal),
    startedAt: (run.startedAt ?? run.createdAt).toISOString(),
    sealedAt:
      status === "live" ? null : (record.seal?.sealedAt.toISOString() ?? null),
    sealSource: null,
    // The ledger records no stop instant apart from its seal.
    endedAt:
      status === "live" ? null : (record.seal?.sealedAt.toISOString() ?? null),
    replayGrade:
      status === "live"
        ? null
        : recordedGrade(record.seal?.replayGrade ?? null),
    verdict: totals?.verdict ?? null,
    enforcementTier: publishedTier(record.seal?.enforcementTier),
    ...compactedField(status, record.seal),
    // A ledger run's controls fence evidence ingress; no host carries them.
    commandBlock: null,
    steerBlock: null,
    completenessGaps: gaps,
    canSummarize: canSummarizeRun({ status, completenessGaps: gaps }),
    // The ledger records evidence an external engine submits. It names no
    // model, harness or host on the run row, so each stays null rather than
    // being reconstructed from a frame that may not be there.
    model: null,
    effort: null,
    permissionMode: null,
    reportedTokens: null,
    machine: null,
    place: null,
    harness: null,
    name: runLabel(run.name),
    summary: generatedSummary(run),
    ...enrichmentError(run),
  };
}

/**
 * Session outcome → status. `aborted` is a stop the operator or harness
 * forced; every other terminal outcome was sealed at `agent_stop`.
 */
export function tachoRunStatus(outcome: string): RunItem["status"] {
  switch (outcome) {
    case "running":
      return "live";
    case "aborted":
      return "halted";
    case "completed":
    case "crashed":
    case "unknown":
      return "sealed";
    default:
      // A word outside the column's CHECK is a broken row. Reading it as
      // sealed would say the record is complete when nothing said so, which
      // is the one direction a status may never be wrong in. The ledger's
      // reader already fails here, and this one now fails the same way.
      throw new RangeError(
        `tacho session outcome outside the CHECK: ${outcome}`,
      );
  }
}

/**
 * The word the session row holds. `aborted` reads `cancelled`, the reading
 * `tachoRunStatus` already gives it, and `unknown` stays `unknown`: a session
 * whose harness stopped reporting before it recorded an end has not been
 * shown to have finished.
 */
export function tachoRunOutcome(outcome: string): RunItem["outcome"] {
  switch (outcome) {
    case "running":
      return "running";
    case "aborted":
      return "cancelled";
    case "completed":
      return "completed";
    case "crashed":
      return "crashed";
    case "unknown":
      return "unknown";
    default:
      throw new RangeError(
        `tacho session outcome outside the CHECK: ${outcome}`,
      );
  }
}

/**
 * The name a wrapped session shows, first match wins:
 *
 * 1. The title the harness gave the session (Claude Code's `ai-title`). The
 *    operator already sees it in their terminal, so a name Oxagen wrote does
 *    not replace it.
 * 2. `name`: the model-written name, or until one exists, the first sentence
 *    of the first prompt plus the branch that `run.enrich` writes.
 * 3. `title`: the place-and-counts title the ingest derives.
 *
 * A run always has something to be called. The name is cut to
 * `RUN_LABEL_MAX` (`runLabel`).
 */
export function tachoRunName(session: {
  harnessTitle?: string | null;
  name: string | null;
  title?: string | null;
}): string | null {
  return runLabel(session.harnessTitle ?? session.name ?? session.title);
}

/**
 * The run row's `commandBlock`: `dispatch_command`'s rule read over the same
 * session and host (ADR-163). Omitted when the reader selected no host
 * liveness, so a caller reads "not known" rather than a refusal nobody made.
 */
function tachoCommandBlock(
  row: TachoSessionRow,
  now: Date,
): Pick<RunItem, "commandBlock"> {
  const host = row.host?.hostname == null ? null : row.host;
  if (host !== null && host.status === undefined) return {};
  return {
    commandBlock: commandBlockOf({
      outcome: row.session.outcome,
      sealSource: row.session.sealSource,
      host:
        host === null || host.status == null
          ? null
          : { status: host.status, lastSeenAt: host.lastSeenAt ?? null },
      now,
    }),
  };
}

/**
 * The session's token counters, as ingest folded them from the counted
 * `llm_call` frames. Null for a session that recorded no model usage, so a
 * header says "not recorded" rather than "0 tokens".
 */
export function reportedTokensOf(
  session: Pick<
    TachoSessionColumns,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
  >,
): RunItem["reportedTokens"] {
  const count = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const input = count(session.inputTokens);
  const output = count(session.outputTokens);
  const cacheRead = count(session.cacheReadTokens);
  const cacheWrite = count(session.cacheCreationTokens);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    input + output + cacheRead + cacheWrite === 0
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Where the session ran, as its start recorded it. A session that ran in a
 * worktree names the worktree and its branch, the branch its work went to.
 * The path is read in the order `get_run_work` names a checkout's
 * (`coalesce(worktree_path, project_dir, cwd)`), so the header shows the same
 * folder before and after that read answers. Omitted when the reader selected
 * none of the columns, so a caller reads "not known" rather than "not
 * recorded"; null when the session recorded neither a path nor a branch.
 */
export function tachoPlace(
  session: Pick<
    TachoSessionColumns,
    "cwd" | "projectDir" | "worktreePath" | "gitBranch" | "worktreeBranch"
  >,
): Pick<RunItem, "place"> {
  if (
    session.cwd === undefined &&
    session.projectDir === undefined &&
    session.worktreePath === undefined &&
    session.gitBranch === undefined &&
    session.worktreeBranch === undefined
  )
    return {};
  const path =
    blankToNull(session.worktreePath ?? null) ??
    blankToNull(session.projectDir ?? null) ??
    blankToNull(session.cwd ?? null);
  const branch =
    blankToNull(session.worktreeBranch ?? null) ??
    blankToNull(session.gitBranch ?? null);
  return { place: path === null && branch === null ? null : { path, branch } };
}

export function toTachoRunItem(
  row: TachoSessionRow,
  totals: RunRollup | undefined,
  now: Date = new Date(),
): RunItem {
  const { session } = row;
  const status = tachoRunStatus(session.outcome);
  const outcome = tachoRunOutcome(session.outcome);
  const gaps = status === "live" ? [] : publishedGaps(session.completenessGaps);
  return {
    id: session.publicId,
    source: "tacho",
    agentKey: session.agentKey,
    operatorId: row.operatorPublicId,
    operatorKind: principalKind(row.operatorKind),
    operatorName: blankToNull(row.operatorUserName),
    // Ingest attributes a wrapped session to the host's enroller
    // (`enrollingPrincipalId`), not to whoever ran it.
    operatorAttribution: row.operatorPublicId ? "host_enroller" : null,
    status,
    outcome,
    turns: session.numTurns,
    steps: session.numModelCalls + session.numToolCalls,
    frames: session.seqCount,
    cost: rollupCost(totals),
    costIsEstimate: costIsEstimate(session.sealedAt, totals),
    ...rollupTokenFields(totals),
    reportedCost:
      Number.isSafeInteger(session.totalCostMicros) &&
      ((session.totalCostMicros ?? 0) > 0 || session.costBasis != null)
        ? {
            micros: microsString(session.totalCostMicros ?? 0),
            currency: "USD",
            basis: "client_attested",
          }
        : null,
    // No dispatch record names a wrapped session's task (see the contract).
    taskRef: null,
    startedAt: session.startedAt.toISOString(),
    sealedAt: session.sealedAt?.toISOString() ?? null,
    sealSource: recordedSealSource(session.sealedAt, session.sealSource),
    // The stop event's own timestamp (`terminalPatch`), never receipt time.
    endedAt:
      status === "live" ? null : (session.endedAt?.toISOString() ?? null),
    replayGrade: recordedGrade(session.replayGrade),
    verdict: totals?.verdict ?? null,
    enforcementTier: publishedTier(session.enforcementTier),
    ...tachoCommandBlock(row, now),
    // Only a live session can be paused. A sealed one has ended, whatever
    // pause it ended under.
    ...(session.paused === undefined
      ? {}
      : { ingressPaused: status === "live" && session.paused }),
    // Whether a steer can reach it (`steerBlockOf`); omitted when the reader
    // selected no runtime.
    ...(session.runtime === undefined
      ? {}
      : { steerBlock: steerBlockOf(session.runtime) }),
    completenessGaps: gaps,
    canSummarize: canSummarizeRun({ status, completenessGaps: gaps }),
    // The model the session ended on is the one that did most of its work, so
    // it is the one a row reports; a session that never recorded a switch has
    // only the one it started on.
    model: modelFactsOf(session.modelFinal ?? session.modelInitial),
    effort: blankToNull(session.effort ?? null),
    permissionMode: blankToNull(
      session.permissionModeFinal ?? session.permissionModeInitial ?? null,
    ),
    reportedTokens: reportedTokensOf(session),
    machine: toRunMachine(row.host, row.session.machineSnapshot),
    ...tachoPlace(session),
    harness: session.harness
      ? {
          name: session.harness,
          version: blankToNull(session.harnessVersion ?? null),
          runtime: session.runtime ?? null,
        }
      : null,
    name: tachoRunName(session),
    summary: generatedSummary(session),
    ...enrichmentError(session),
  };
}
