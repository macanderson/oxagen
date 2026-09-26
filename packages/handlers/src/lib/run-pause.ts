// The pause in force on a run (#3972): a pause on its way (`pausing`), one in
// force (`paused`), or one in force with a resume on its way (`resuming`),
// with where it took hold, who issued it, when, and the reason they gave.
//
// Every field is a recorded one. Whether the run is held is the rule
// `list_runs` reads `paused` by, `appliedHaltIsPause` below: the last pause or
// resume the host applied. `get_run` takes that answer from the run's row and
// reads the pause and resume rows behind it only to name them. A command on
// its way is one no host has settled: queued and not past its expiry, or
// sent, received or acknowledged, the rule the delivery report reads a
// status by (`reportedStatus`).
//
// A wrapped run's position is the `oxagen:command_applied` frame its host
// sealed (`applied_at_seq`), with the turn and step counted on the run's own
// chain up to that frame by the rules the header's `turns` and `steps` count
// by (`foldDelta` in tacho.events.ingest.ts). While the pause is on its way,
// the position is the run's head: the header's own counts. A ledger run's
// pause fences ingress and seals no frame, so it has no position, and it
// applies when it is dispatched, so it is never on its way.
import { schema, withTenantDb } from "@oxagen/database";
import type { RunPause } from "@oxagen/oxagen/contracts/run.list";
import {
  LLM_CALL_DUPLICATE_OF_ATTR,
  LLM_CALL_TOKEN_SOURCES,
} from "@oxagen/tacho";
import { chSelect } from "@oxagen/telemetry";
import {
  type AnyColumn,
  and,
  desc,
  eq,
  inArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { RunScope } from "../run.list";

const commands = schema.tachoControlCommands;
const users = schema.users;

/**
 * Whether the host holds the run paused: the last pause or resume it
 * acknowledged `applied` is a pause. Dispatch writes one `run` row per
 * recipient, addressed by public id, so `tacho_control_commands_target_idx`
 * answers it. A pause still queued, or one the host refused, does not count:
 * the pause dialog promises that the run's status says when it has applied.
 *
 * `list_runs` selects it as a wrapped session's `paused`, and `get_run`
 * reads the same row, so the two cannot disagree about one run. The target
 * is the outer query's columns, so the subquery is correlated.
 */
export function appliedHaltIsPause(target: {
  orgId: AnyColumn;
  workspaceId: AnyColumn;
  publicId: AnyColumn;
}): SQL<boolean> {
  return sql<boolean>`coalesce((
      select ${commands.command} = 'pause'
      from ${commands}
      where ${commands.orgId} = ${target.orgId}
        and ${commands.workspaceId} = ${target.workspaceId}
        and ${commands.targetKind} = 'run'
        and ${commands.targetId} = ${target.publicId}
        and ${commands.command} in ('pause', 'resume')
        and ${commands.outcome} = 'applied'
      order by ${commands.appliedAt} desc nulls last, ${commands.issuedAt} desc
      limit 1
    ), false)`;
}

/** The statuses of a command no host has settled yet. */
const OPEN_OUTCOMES = ["queued", "sent", "received", "acknowledged"] as const;

/**
 * The most pause and resume rows one read names. The rows a state is read
 * from are the newest: the pause in force, and a command queued behind it.
 */
export const PAUSE_ROWS_MAX = 50;

/** A pause or resume row addressed to the run, with its issuer. */
export type PauseCommandRow = {
  publicId: string;
  command: string;
  outcome: string;
  reason: string | null;
  issuedAt: Date;
  expiresAt: Date | null;
  appliedAt: Date | null;
  appliedAtSeq: number | null;
  /** The issuer's `users.public_id` (`usr_…`); null when the row names no user. */
  issuedByPublicId: string | null;
  /** The issuer's `users.display_name`, as stored. */
  issuedByName: string | null;
};

/** The turn and step at a frame, each null when none was counted. */
export type PausePosition = { turn: number | null; step: number | null };

export type RunPauseDeps = {
  /** The run's applied and open pause and resume rows, newest issued first. */
  pauseCommands: (
    scope: RunScope,
    runPublicId: string,
  ) => Promise<PauseCommandRow[]>;
  /** The turn and step at `seq` on a wrapped run's own chain. */
  pausePosition: (sessionUuid: string, seq: number) => Promise<PausePosition>;
};

/** The run as the pause read needs it. */
export type PauseTarget = {
  source: "ledger" | "tacho";
  publicId: string;
  /** The wrapped run's own chain; null for a ledger run. */
  sessionUuid: string | null;
  /** What `list_runs` reads as held: the ingress fence, or `appliedHaltIsPause`. */
  held: boolean;
  /** The run's head, as the header counts it; turns are null when none were counted. */
  turns: number | null;
  steps: number;
};

/**
 * A command no host has settled: queued and not past its expiry, or held by
 * the host. `reportedStatus` in tacho.command.list.ts reads the same rule.
 */
function isOpen(row: PauseCommandRow, now: Date): boolean {
  if (!(OPEN_OUTCOMES as readonly string[]).includes(row.outcome)) return false;
  return !(
    row.outcome === "queued" &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() <= now.getTime()
  );
}

/** `appliedHaltIsPause`'s order: applied latest first, the unrecorded instant last, then issued latest. */
function appliedOrder(a: PauseCommandRow, b: PauseCommandRow): number {
  const at = (row: PauseCommandRow) => row.appliedAt?.getTime() ?? null;
  const left = at(a);
  const right = at(b);
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  }
  return b.issuedAt.getTime() - a.issuedAt.getTime();
}

const newestIssued = (a: PauseCommandRow, b: PauseCommandRow): number =>
  b.issuedAt.getTime() - a.issuedAt.getTime();

/** The pause's state and the rows behind it; null when no pause is in force or on its way. */
export type PauseState = {
  state: RunPause["state"];
  pause: PauseCommandRow;
  /** The resume on its way; set only while `resuming`. */
  resume: PauseCommandRow | null;
};

/**
 * The state `rows` put the run in, given whether it is `held`.
 *
 * Held: the pause in force is the last pause the host applied, and a resume
 * issued after it that no host has settled makes it `resuming`. A held run
 * whose rows name no applied pause has nothing to describe, so it reads none.
 *
 * Not held: a pause issued after the last applied pause or resume that no
 * host has settled makes it `pausing`.
 */
export function pauseStateOf(
  rows: readonly PauseCommandRow[],
  held: boolean,
  now: Date,
): PauseState | null {
  const applied = rows
    .filter(
      (row) =>
        row.outcome === "applied" &&
        (row.command === "pause" || row.command === "resume"),
    )
    .sort(appliedOrder);
  const open = rows.filter((row) => isOpen(row, now)).sort(newestIssued);
  if (held) {
    const pause = applied.find((row) => row.command === "pause");
    if (pause === undefined) return null;
    const resume = open.find(
      (row) =>
        row.command === "resume" &&
        row.issuedAt.getTime() >= pause.issuedAt.getTime(),
    );
    return resume === undefined
      ? { state: "paused", pause, resume: null }
      : { state: "resuming", pause, resume };
  }
  const last = applied[0];
  const pause = open.find(
    (row) =>
      row.command === "pause" &&
      (last === undefined ||
        row.issuedAt.getTime() >= last.issuedAt.getTime()),
  );
  return pause === undefined ? null : { state: "pausing", pause, resume: null };
}

const blankToNull = (value: string | null): string | null =>
  value === null || value.trim() === "" ? null : value;

/** A count as the contract's 1-based position: none counted reads as null. */
const positive = (count: number): number | null =>
  Number.isSafeInteger(count) && count > 0 ? count : null;

/**
 * The pause in force on `run`, or null when none is in force or on its way.
 * A position the read could not answer is left null, and the pause is still
 * returned: `onPositionFailure` is told why.
 */
export async function readRunPause(
  deps: RunPauseDeps,
  scope: RunScope,
  run: PauseTarget,
  now: Date,
  onPositionFailure: (err: unknown) => void,
): Promise<RunPause | null> {
  const rows = await deps.pauseCommands(scope, run.publicId);
  const found = pauseStateOf(rows, run.held, now);
  // A ledger run's pause applies when it is dispatched, so a pause the fence
  // does not hold is not one on its way.
  if (found === null || (run.source === "ledger" && found.state === "pausing"))
    return null;
  const { state, pause, resume } = found;
  let seq: string | null = null;
  let position: PausePosition = { turn: null, step: null };
  if (run.source === "tacho" && state === "pausing") {
    position = { turn: positive(run.turns ?? 0), step: positive(run.steps) };
  } else if (run.source === "tacho" && pause.appliedAtSeq !== null) {
    seq = String(pause.appliedAtSeq);
    if (run.sessionUuid !== null) {
      position = await deps
        .pausePosition(run.sessionUuid, pause.appliedAtSeq)
        .catch((err: unknown) => {
          onPositionFailure(err);
          return { turn: null, step: null };
        });
    }
  }
  return {
    state,
    commandId: pause.publicId,
    resumeCommandId: resume?.publicId ?? null,
    seq,
    turn: position.turn === null ? null : positive(position.turn),
    step: position.step === null ? null : positive(position.step),
    by:
      pause.issuedByPublicId === null
        ? null
        : {
            id: pause.issuedByPublicId,
            name: blankToNull(pause.issuedByName),
          },
    issuedAt: pause.issuedAt.toISOString(),
    appliedAt:
      state === "pausing" ? null : (pause.appliedAt?.toISOString() ?? null),
    reason: pause.reason,
  };
}

/** The run's applied and open pause and resume rows, newest issued first. */
export function postgresPauseCommands(
  scope: RunScope,
  runPublicId: string,
): Promise<PauseCommandRow[]> {
  return withTenantDb((tx) =>
    tx
      .select({
        publicId: commands.publicId,
        command: commands.command,
        outcome: commands.outcome,
        reason: commands.reason,
        issuedAt: commands.issuedAt,
        expiresAt: commands.expiresAt,
        appliedAt: commands.appliedAt,
        appliedAtSeq: commands.appliedAtSeq,
        issuedByPublicId: users.publicId,
        issuedByName: users.displayName,
      })
      .from(commands)
      .leftJoin(users, eq(users.id, commands.issuedByUserId))
      .where(
        and(
          eq(commands.orgId, scope.orgId),
          eq(commands.workspaceId, scope.workspaceId),
          eq(commands.targetKind, "run"),
          eq(commands.targetId, runPublicId),
          inArray(commands.command, ["pause", "resume"]),
          inArray(commands.outcome, ["applied", ...OPEN_OUTCOMES]),
        ),
      )
      .orderBy(desc(commands.issuedAt), desc(commands.publicId))
      .limit(PAUSE_ROWS_MAX),
  );
}

type RawPosition = {
  turns: string | number;
  model_calls: string | number;
  tool_calls: string | number;
};

/**
 * The turn and step at `seq` on one chain: the `turn_start` frames at or
 * before it, and the model and tool calls, counted by the rules the session
 * row's `num_turns`, `num_model_calls` and `num_tool_calls` count by
 * (`foldDelta`): a model call once, from a token-bearing source that is no
 * later sighting (`countsLlmCallUsage`), and a tool call from the hook or the
 * collector. One aggregate over the chain's prefix; nothing is folded.
 */
export async function clickhousePausePosition(
  sessionUuid: string,
  seq: number,
): Promise<PausePosition> {
  const result = await chSelect<RawPosition>({
    query: `SELECT
        countIf(kind = 'turn_start') AS turns,
        countIf(kind = 'llm_call' AND source IN {sources:Array(String)}
          AND attrs[{duplicateAttr:String}] = '') AS model_calls,
        countIf(kind = 'tool_call' AND source IN ('hook', 'collector')) AS tool_calls
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}
        AND seq <= {seq:UInt64}`,
    params: {
      sessionUuid,
      seq,
      sources: [...LLM_CALL_TOKEN_SOURCES],
      duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
    },
  });
  const row = result.data[0];
  if (row === undefined) return { turn: null, step: null };
  return {
    turn: positive(Number(row.turns)),
    step: positive(Number(row.model_calls) + Number(row.tool_calls)),
  };
}
