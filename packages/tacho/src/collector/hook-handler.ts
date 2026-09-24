/**
 * `handleHookEvent`: one Claude Code-shaped hook payload in, the chained Tacho
 * events and the hook's JSON answer out (spec section 5.4). Pure over its
 * dependencies: the registry, the current policy view, a clock, and an
 * optional bundle refresh for the `defer` path. The daemon, the spool
 * replay, and (in PR 5) the Claude Agent SDK adapter all call this.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import {
  hookInputSchema,
  normalizeHook,
  type HookDraft,
  type HookInput,
} from "../claude-code/hooks";
import { digestText } from "../claude-code/context";
import { classifyShellEffect } from "../claude-code/tools";
import type { TachoEvent } from "../envelope";
import {
  type DeliveredPrompt,
  steeringManifestFrame,
} from "./steering-manifest";
import type { FrameBody } from "../evidence/frame-body";
import { toProtocolTimestamp } from "../timestamp";
import {
  customAgentNameProblem,
  type CommandAcknowledgement,
  type DenyGeneration,
  type PolicyBundle,
  TACHO_CREDENTIAL_BASIS_ATTR,
  TACHO_CREDENTIAL_HARNESS_HELD,
  type TachoCredentialBasis,
  type TachoHarness,
} from "../wire";
import {
  type Evaluation,
  type EvaluationInput,
  evaluatePreToolUse,
  type MatchContext,
} from "../host/bundle";
import {
  rememberHookId,
  sawHookId,
  type SessionRecord,
  type SessionRegistry,
} from "./registry";

export interface PolicyView {
  bundle: PolicyBundle;
  verified: boolean;
  hostStatus: PolicyBundle["host_status"];
  denyGeneration: DenyGeneration;
  controlReachable: boolean;
  /**
   * When the control plane last confirmed this mandate's etag, as epoch ms.
   * Freshness is measured from here rather than from `expires_at`; see
   * `isStale` in host/bundle.ts for why the two are not the same thing.
   */
  mandateConfirmedAt?: number;
  /**
   * Whether this session was started by the contained launcher (ADR-152).
   * Absent answers no. A mandate that requires the contained tier refuses a
   * session the launcher did not start.
   */
  launchedContained?: (harnessSessionId: string) => boolean;
}

/**
 * The mandate requires `contained` and this session is not one the launcher
 * started. Read only from a verified bundle, so a requirement written into
 * the host file cannot refuse a session. Enforce mode only: an observe host
 * records and never refuses.
 */
export function containmentUnmet(
  view: PolicyView,
  record: Pick<SessionRecord, "harnessSessionId">,
): boolean {
  return (
    view.verified &&
    view.bundle.mode === "enforce" &&
    view.bundle.containment?.required === true &&
    view.launchedContained?.(record.harnessSessionId) !== true
  );
}

export const CONTAINMENT_REQUIRED_REASON =
  "This agent's mandate requires the contained tier. Start it with `tacho run --contained`.";

export interface HookHandlerDeps {
  registry: SessionRegistry;
  policy: () => PolicyView;
  /** Refresh the bundle synchronously for a stale-bundle `defer`; absent in `tacho-hook`. */
  refreshBundle?: () => Promise<void>;
  /**
   * Called with the acknowledgement for a queued operator message once a
   * boundary settles it: `applied` with the frame that carries it, or
   * `failed` for one whose deadline passed while it waited.
   */
  acknowledge?: (ack: CommandAcknowledgement) => void;
  now: () => number;
  /** Home and platform for rule matching; absent, the host this runs on. */
  match?: MatchContext;
  /**
   * Which credential a successful `git push` went out with (ADR-151). The
   * daemon answers from the host's GitHub custody receipts
   * (`pushCredentialBasis` in `./push-basis`). Absent, every push is
   * `harness_held`, because nothing then shows the proxy carried it.
   */
  pushCredentialBasis?: (
    command: string,
    cwd: string | undefined,
  ) => Promise<TachoCredentialBasis>;
}

export interface HookReplay {
  /**
   * When the event was received: by `tacho-hook` while the daemon was down,
   * or by the daemon itself when it deferred the event to a later tick. The
   * frame's `ts` is this, not the time the deferred work finished.
   */
  receivedAt: string;
  /** The decision `tacho-hook` made from the cached bundle. */
  evaluation?: Evaluation;
  /**
   * The daemon received the hook live and deferred it (a SessionEnd waiting
   * for its git read). The frame carries `hook.received_at` and not
   * `hook.replayed`, which means a spool replay and nothing else.
   */
  deferred?: boolean;
}

function replayAttrs(replay: HookReplay | undefined): Record<string, string> {
  if (replay === undefined) return {};
  return {
    ...(replay.deferred === true ? {} : { "hook.replayed": "1" }),
    "hook.received_at": replay.receivedAt,
  };
}

export interface HookOutcome {
  events: TachoEvent[];
  /**
   * The bodies of the events above that carry one, drained from the session
   * chain and its children. They travel with the events to the WAL so a body
   * is never written to a session file whose event is still in memory.
   */
  bodies: FrameBody[];
  /** The JSON document the hook prints on stdout (empty object = continue). */
  response: Record<string, unknown>;
  record?: SessionRecord;
  evaluation?: Evaluation;
  /**
   * The key this hook holds in its session's replay ledger (see
   * `hookLedgerKey`), or undefined when it has none. The daemon forgets it
   * when the WAL write fails and journals it when the write lands.
   */
  hookKey?: string;
}

/** `HookOutcome` before the bodies are drained; `routeHook` returns this. */
type RoutedOutcome = Omit<HookOutcome, "bodies">;

function policyFacts(
  evaluation: Evaluation,
  view: PolicyView,
): Record<string, unknown> {
  return {
    policy_decision: evaluation.decision,
    policy_source: evaluation.source,
    policy_reason_code: evaluation.reason_code,
    policy_reason_digest: digestText(evaluation.reason),
    risk_grade: evaluation.risk_grade,
    bundle_version: evaluation.bundle_version,
    bundle_mode: evaluation.bundle_mode,
    deny_generation_org: view.denyGeneration.org,
    deny_generation_ws: view.denyGeneration.workspace,
    ...(evaluation.rule !== undefined ? { policy_rule: evaluation.rule } : {}),
    ...(evaluation.capability_id !== undefined
      ? { capability_id: evaluation.capability_id }
      : {}),
  };
}

function policyAttrs(
  evaluation: Evaluation,
  replay?: HookReplay,
): Record<string, string> {
  return {
    "policy.evaluated": evaluation.evaluated,
    "policy.read_only": evaluation.read_only ? "1" : "0",
    "policy.stale": evaluation.stale ? "1" : "0",
    ...replayAttrs(replay),
  };
}

/**
 * The harness process pid: Claude Code exports `CLAUDE_PID`; for a harness
 * that exports nothing (Stella) `tacho-hook` finds the process itself and
 * passes it as `TACHO_HARNESS_PID`. The registry sweep seals the chain when
 * that process is gone.
 */
export function pidFromEnv(
  env: Record<string, string | undefined>,
): number | undefined {
  for (const name of ["CLAUDE_PID", "TACHO_HARNESS_PID"]) {
    const pid = env[name];
    if (pid !== undefined && /^\d+$/.test(pid)) return Number(pid);
  }
  return undefined;
}

function operatorBlock(
  view: PolicyView,
  record: SessionRecord,
): { code: string; reason: string; source: "human" | "bundle" } | undefined {
  if (view.hostStatus === "suspended" || view.hostStatus === "revoked") {
    return {
      code: `host_${view.hostStatus}`,
      reason: `This host is ${view.hostStatus} by its Oxagen operator.`,
      source: "human",
    };
  }
  if (view.hostStatus === "paused") {
    return {
      code: "host_paused",
      reason: "This host is paused by its Oxagen operator.",
      source: "human",
    };
  }
  if (record.control.cancelled !== null) {
    return {
      code: "session_cancelled",
      reason: `This session was cancelled by its Oxagen operator: ${record.control.cancelled}`,
      source: "human",
    };
  }
  if (record.control.paused !== null) {
    return {
      code: "session_paused",
      reason: `This session is paused by its Oxagen operator: ${record.control.paused}`,
      source: "human",
    };
  }
  if (containmentUnmet(view, record)) {
    return {
      code: "containment_required",
      reason: CONTAINMENT_REQUIRED_REASON,
      source: "bundle",
    };
  }
  return undefined;
}

/**
 * Stella issues no tool-use id, so `tacho-hook` derives one from the call
 * itself (`stellaToolUseId`): the same tool with the same input digests to
 * the same id, which is what pairs a PreToolUse with its PostToolUse. Two
 * identical calls in one session would then also share it, and the trace
 * oracles read that as one call executed twice and one effect performed
 * twice — a legitimate repeat of a shell command reported as a replay. The
 * daemon numbers each invocation instead: the PreToolUse that opens a call
 * writes the id, keyed by the derived one, and every later event on that
 * call reads it back, so the pair still matches and the invocations are told
 * apart. The chain seq supplies the number, so a daemon restart cannot
 * reissue one the chain already used.
 *
 * Only a derived id is rewritten, and only for the harness that derives it:
 * a harness with real tool-use ids is left exactly as it arrived.
 */
function invocationToolUseId(
  raw: unknown,
  input: HookInput,
  record: SessionRecord,
): unknown {
  const derived = input.tool_use_id;
  if (record.harness !== "stella" || derived === undefined) return raw;
  if (input.hook_event_name === "PreToolUse") {
    record.toolUseIds[derived] =
      `${derived}_${record.recorder.chainCursor.seq}`;
  }
  const id = record.toolUseIds[derived];
  if (id === undefined) return raw;
  if (input.hook_event_name === "PostToolUse")
    delete record.toolUseIds[derived];
  return { ...(raw as Record<string, unknown>), tool_use_id: id };
}

/**
 * Whether a message drained at this boundary actually reaches the agent.
 *
 * Claude Code takes `additionalContext` at SessionStart, UserPromptSubmit,
 * PostToolUse and PostToolUseFailure, and a `Stop` answered
 * `decision: "block"` continues the turn with the reason as the next thing
 * the model reads. Codex documents the same PostToolUse and Stop answers.
 * The mid-turn boundaries are what let a steer reach an agent working on its
 * own: before them a steer waited for a human prompt that an autonomous run
 * never sends, and expired "before a boundary".
 *
 * Stella reads only SessionStart stdout as prompt text and answers every
 * other event with a decision document that has nowhere to put prose
 * (`stellaAnswer`, which also turns a `Stop` block into a deny). Cursor's
 * `additional_context` is a field of its sessionStart answer, its
 * beforeSubmitPrompt answer carries only a `user_message` shown to the
 * person, and its stop answer takes a `followup_message` that continues the
 * agent (`cursorAnswer`). Draining at a boundary that cannot carry the text
 * would seal `message_delivered` and tell the fleet the command applied while
 * the agent never saw a word, so the message stays queued for one that can.
 *
 * `PreToolUse` carries an `interrupt` steer as the reason a tool call is
 * refused, which every harness passes to the agent except Stella's.
 */
function deliversMessages(
  harness: TachoHarness | undefined,
  hookEventName: string,
): boolean {
  if (harness === "stella") return hookEventName === "SessionStart";
  if (harness === "cursor")
    return (
      hookEventName === "SessionStart" ||
      hookEventName === "Stop" ||
      hookEventName === "PreToolUse"
    );
  return MESSAGE_BOUNDARIES.has(hookEventName);
}

const MESSAGE_BOUNDARIES = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

/** What the agent is told when the operator resumes it mid-turn. */
export const RESUMED_TEXT = "Resumed by the operator. Continue the task.";

/**
 * The most text one hook answer hands the agent, the steering prefix and the
 * messages together with their joiners, whether it rides in
 * `additionalContext`, a `Stop` block's reason or an interrupt's refusal.
 * Claude Code keeps 10,000 characters of `additionalContext`; past that the
 * text is saved to a file and the model reads a preview and a path, while
 * every message in it would still be sealed `command_applied`.
 */
export const ADDITIONAL_CONTEXT_MAX_CHARS = 9_500;

/** What an answer puts between the prefix and each message. */
const CONTEXT_JOINER = "\n\n";

/**
 * Inject the queued prompt content at this boundary and chain one
 * `oxagen:command_applied` per item: the `control.steer` frame of the
 * Mission Control spec (§8.2) in the wrapper vocabulary, carrying the
 * requested and the achieved mode, the degradation, and `interrupted`. The
 * hook adapter alone can never set it. The model proxy does, when it cut an
 * in-flight call so this steer would land sooner. The event's own seq is the frame the
 * control plane records as `applied_at_seq`.
 *
 * An item whose deadline passed while it waited (a session paused past a
 * steer's expiry, then resumed) is dropped here: no injection, no frame, and
 * an `expired` acknowledgement. The row is the host's once it left on the
 * wire (spec §7.4), so the host records that its expiry passed with no
 * boundary reached, and the chain holds no frame for it.
 *
 * `used` is how many characters the answer already carries (the steering
 * prefix at SessionStart, or the room a mid-turn answer holds back). Items
 * are taken in order while the answer stays under
 * `ADDITIONAL_CONTEXT_MAX_CHARS`; the first that does not fit stays queued
 * with everything behind it, for the next boundary. One longer than a whole
 * answer could never be delivered, so it is acknowledged `failed` rather
 * than left to hold up the queue.
 */
function drainMessages(
  record: SessionRecord,
  deps: HookHandlerDeps,
  events: TachoEvent[],
  used = 0,
): DeliveredPrompt[] {
  const delivered: DeliveredPrompt[] = [];
  const now = deps.now();
  const queue = record.control.messages.splice(0);
  for (const [index, message] of queue.entries()) {
    if (message.expiresAt !== null && Date.parse(message.expiresAt) < now) {
      deps.acknowledge?.({
        command_id: message.id,
        status: "expired",
        session_uuid: record.recorder.sessionUuid,
        detail: "expired before a boundary",
      });
      continue;
    }
    if (message.text.length > ADDITIONAL_CONTEXT_MAX_CHARS) {
      deps.acknowledge?.({
        command_id: message.id,
        status: "failed",
        session_uuid: record.recorder.sessionUuid,
        detail: `longer than the ${ADDITIONAL_CONTEXT_MAX_CHARS} characters a hook delivers`,
      });
      continue;
    }
    const size = (used > 0 ? CONTEXT_JOINER.length : 0) + message.text.length;
    if (used + size > ADDITIONAL_CONTEXT_MAX_CHARS) {
      record.control.messages.unshift(...queue.slice(index));
      break;
    }
    used += size;
    delivered.push({
      id: message.id,
      text: message.text,
      command: message.command ?? "message",
      issuedAt: message.issuedAt ?? toProtocolTimestamp(now),
    });
    const event = record.recorder.sealCollectorEvent(
      "oxagen:command_applied",
      {
        policy_decision: "allow",
        policy_source: "human",
        policy_reason_code: `${message.command}_delivered`,
        policy_reason_digest: digestText(message.text),
      },
      {
        attrs: {
          "command.id": message.id,
          "command.name": message.command,
          "command.interrupted": message.interrupted === true ? "1" : "0",
          ...(message.requestedMode !== null
            ? { "command.requested_mode": message.requestedMode }
            : {}),
          ...(message.deliveryMode !== null
            ? { "command.delivery_mode": message.deliveryMode }
            : {}),
          ...(message.degradedReason !== null
            ? { "command.degraded_reason": message.degradedReason }
            : {}),
        },
      },
    );
    events.push(event);
    deps.acknowledge?.({
      command_id: message.id,
      status: "applied",
      session_uuid: record.recorder.sessionUuid,
      applied_at_seq: event.seq,
    });
  }
  return delivered;
}

/**
 * The continuation a resume owes the agent (`SessionControl.resumeOwed`),
 * sealed as the `oxagen:command_applied` frame of its delivery. The resume
 * was acknowledged when it applied, so this sends no acknowledgement.
 */
function drainContinuation(
  record: SessionRecord,
  events: TachoEvent[],
): string | undefined {
  const commandId = record.control.resumeOwed;
  if (commandId === undefined) return undefined;
  record.control.resumeOwed = undefined;
  events.push(
    record.recorder.sealCollectorEvent(
      "oxagen:command_applied",
      {
        policy_decision: "allow",
        policy_source: "human",
        policy_reason_code: "resume_delivered",
        policy_reason_digest: digestText(RESUMED_TEXT),
      },
      { attrs: { "command.id": commandId, "command.name": "resume" } },
    ),
  );
  return RESUMED_TEXT;
}

/**
 * Everything queued for the agent that this mid-turn boundary delivers: the
 * operator's messages and steers, then a resume's continuation. Empty when
 * the boundary cannot carry text for this harness, when it fired inside a
 * subagent (a steer is addressed to the agent the operator is watching, and
 * text in a subagent's context never reaches it), or when this is a spool
 * replay, whose answer reaches no harness. Each item leaves the queue as it
 * is sealed, and the daemon runs hooks one at a time, so parallel tool calls
 * cannot deliver the same steer twice.
 *
 * `used` is what the answer carries besides these texts (an interrupt's
 * lead). Room for a resume's continuation is kept as well, so the whole
 * answer stays under `ADDITIONAL_CONTEXT_MAX_CHARS`.
 */
function drainMidTurn(
  input: HookInput,
  record: SessionRecord,
  deps: HookHandlerDeps,
  events: TachoEvent[],
  replay: HookReplay | undefined,
  used = 0,
): string[] {
  if (
    replay !== undefined ||
    input.agent_id !== undefined ||
    !deliversMessages(record.harness, input.hook_event_name)
  )
    return [];
  const owed =
    record.control.resumeOwed === undefined ? 0 : RESUMED_TEXT.length;
  const texts = drainMessages(record, deps, events, used + owed).map(
    (m) => m.text,
  );
  const continuation = drainContinuation(record, events);
  if (continuation !== undefined) texts.push(continuation);
  return texts;
}

/**
 * The events a harness fires once per tool call, each with the harness's
 * own id for that call. A second arrival of one of them with the same id is
 * a replay, never a new call.
 */
const TOOL_CALL_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
]);

/**
 * The key a hook holds in its session's replay ledger
 * (`SessionRecord.hookIds`), or undefined when nothing can tell its replay
 * from a new hook.
 *
 * The client's `hook_id` comes first. A `tacho-hook` older than the id, and
 * a spool file it left behind, send none, so a tool-call event falls back to
 * `${hook_event_name}:${tool_use_id}`: the harness issues that id once per
 * call. Stella is left out because the daemon derives its tool-use ids (see
 * `invocationToolUseId`). An event with no id of its own (`Stop`,
 * `UserPromptSubmit`, `Notification`) gets no key. Two of them can carry
 * byte-identical payloads and both be real, so a key built from the content
 * would drop a real one.
 */
export function hookLedgerKey(
  raw: unknown,
  harness: TachoHarness | undefined,
  hookId: string | undefined,
): string | undefined {
  if (hookId !== undefined) return hookId;
  if (harness === "stella" || typeof raw !== "object" || raw === null)
    return undefined;
  const { hook_event_name: event, tool_use_id: id } = raw as Record<
    string,
    unknown
  >;
  if (typeof event !== "string" || !TOOL_CALL_HOOK_EVENTS.has(event))
    return undefined;
  if (typeof id !== "string" || id.length === 0) return undefined;
  return `${event}:${id}`;
}

/**
 * Map one hook payload to its events and its answer. `agent` names a custom
 * agent (`tacho hook --agent <name>`): its payload is Claude Code's shape and
 * its session is labelled `runtime: "custom"`, `harness: <name>`.
 *
 * `hookId` names one hook invocation, the same id `tacho-hook` sends on both
 * its live request and the spool file it falls back to when that request
 * times out on the client's own side (see `HookRunDeps.hookId` in
 * `claude-code/hook-client.ts`). A client timeout does not mean the daemon
 * never received the hook. This function may already have run for it, so a
 * replay whose ledger key (`hookLedgerKey`) this session already recorded is
 * dropped rather than sealing everything a second time.
 */
export async function handleHookEvent(
  raw: unknown,
  env: Record<string, string | undefined>,
  deps: HookHandlerDeps,
  replay?: HookReplay,
  harness?: TachoHarness,
  agent?: string,
  hookId?: string,
): Promise<HookOutcome> {
  const outcome = await routeHook(
    raw,
    env,
    deps,
    replay,
    harness,
    agent,
    hookId,
  );
  // Remembered after the route, not before it: a route that throws (a
  // policy read, a git lookup, a parse) sends the client a failure, the
  // client spools the same id, and that replay is the only copy the daemon
  // will ever see. Remembering a key the ledger already holds is a no-op, so
  // the dedupe branch passes through here harmlessly. A WAL write that fails
  // after this point is undone by the daemon with `forgetHookId`. The time
  // is the one `ensure` stamped on the record, so this reads no clock.
  const hookKey =
    outcome.record === undefined
      ? undefined
      : hookLedgerKey(raw, outcome.record.harness, hookId);
  if (hookKey !== undefined && outcome.record !== undefined) {
    rememberHookId(
      outcome.record,
      hookKey,
      Date.parse(outcome.record.lastSeenAt),
    );
  }
  // Drained after the route, whichever branch returned: every event the
  // route sealed is in `events` by now, so every body is pending on the
  // recorder, and taking them here is what keeps the two lists paired.
  return {
    ...outcome,
    bodies: outcome.record?.recorder.takeBodies() ?? [],
    ...(hookKey === undefined ? {} : { hookKey }),
  };
}

/**
 * The `evaluatePreToolUse` request for one view of the policy.
 *
 * Both paths that evaluate a tool go through here, and so does each path's
 * second attempt after a refresh: `PreToolUse` for the agent's own call, and
 * `SubagentStart` for the subagent Cursor is about to launch. Building the
 * request by hand at each of the four sites is what let `mandateConfirmedAt`
 * reach the parent's evaluation and not the subagent's — past the bundle's
 * signed lifetime the subagent then measured freshness from `issued_at`, and
 * in enforce mode that denied every subagent launch on a host whose mandate
 * the daemon had been confirming by `not_modified` the whole time. One
 * builder, reading the view it is handed, is what stops the parent and the
 * subagent drifting apart again.
 */
function evaluationRequestFor(
  view: PolicyView,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  record: SessionRecord,
  deps: HookHandlerDeps,
  input: HookInput,
): EvaluationInput {
  return {
    bundle: view.bundle,
    bundleVerified: view.verified,
    toolName,
    ...(toolInput !== undefined ? { toolInput } : {}),
    hostStatus: view.hostStatus,
    session: record.control,
    ...(containmentUnmet(view, record) ? { containmentUnmet: true } : {}),
    latestDenyGeneration: view.denyGeneration,
    controlReachable: view.controlReachable,
    ...(view.mandateConfirmedAt !== undefined
      ? { mandateConfirmedAt: view.mandateConfirmedAt }
      : {}),
    // Stella's own read-only claim for the tool, as `tacho-hook` reads it.
    ...(input["tool_read_only"] === true ? { harnessReadOnly: true } : {}),
    now: deps.now(),
    context: {
      ...(deps.match ?? hostMatchContext()),
      ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    },
  };
}

/**
 * Home and platform for rule matching when the caller names none: the host
 * this runs on, as `tacho-hook` reads them offline. Without them a `~/`
 * rule never matched and a Windows path was not folded in the daemon.
 */
function hostMatchContext(): MatchContext {
  let home: string | undefined;
  try {
    home = homedir();
  } catch {
    home = undefined;
  }
  return {
    ...(home !== undefined && home.length > 0 ? { home } : {}),
    platform: process.platform,
  };
}

/**
 * The credential basis for a hook that records a successful `git push`, or
 * undefined for any other hook. Only a completed push seals the `command`
 * frame that carries it, so only `PostToolUse` asks.
 */
async function gitPushBasis(
  input: HookInput,
  record: SessionRecord,
  deps: HookHandlerDeps,
): Promise<TachoCredentialBasis | undefined> {
  if (input.hook_event_name !== "PostToolUse") return undefined;
  const command = input.tool_input?.["command"];
  if (
    typeof command !== "string" ||
    classifyShellEffect(command) !== "git_push"
  )
    return undefined;
  if (deps.pushCredentialBasis === undefined)
    return TACHO_CREDENTIAL_HARNESS_HELD;
  // The registry keeps the session's working directory, and for Cursor it
  // keeps the explicit root over one inferred from the workspace list.
  try {
    return await deps.pushCredentialBasis(command, record.cwd ?? input.cwd);
  } catch {
    // A failed read proves nothing about the proxy, and the hook must still
    // record the push.
    return TACHO_CREDENTIAL_HARNESS_HELD;
  }
}

async function routeHook(
  raw: unknown,
  env: Record<string, string | undefined>,
  deps: HookHandlerDeps,
  replay?: HookReplay,
  harness?: TachoHarness,
  agent?: string,
  hookId?: string,
): Promise<RoutedOutcome> {
  const input = hookInputSchema.parse(raw);
  // The daemon checks again: anything holding the local token can post an
  // envelope without going through `tacho-hook`.
  const agentProblem =
    agent !== undefined ? customAgentNameProblem(agent) : undefined;
  if (agentProblem !== undefined) {
    throw new Error(
      `invalid custom agent name ${JSON.stringify(agent)}; ${agentProblem}`,
    );
  }
  const at = replay?.receivedAt ?? toProtocolTimestamp(deps.now());
  const inferredCwd =
    harness === "cursor" && input["cursor_cwd_inferred"] === true;
  const { record, reopened } = deps.registry.ensure(input.session_id, {
    ambient: false,
    lastHookEvent: input.hook_event_name,
    ...(harness !== undefined ? { harness } : {}),
    ...(agent !== undefined ? { customAgent: agent } : {}),
    ...(input.transcript_path !== undefined
      ? { transcriptPath: input.transcript_path }
      : {}),
    ...(input.cwd !== undefined && !inferredCwd ? { cwd: input.cwd } : {}),
    ...(pidFromEnv(env) !== undefined ? { pid: pidFromEnv(env) } : {}),
  });
  if (inferredCwd && record.cwd === undefined && input.cwd !== undefined) {
    record.cwd = input.cwd;
  }
  const wrote = writtenDir(input);
  if (wrote !== undefined) record.workDir = wrote;
  // This hook reopened a session the sweep closed for quiet, so the chain
  // starts again, and says so first. The control plane reopens a run whose
  // host sealed it only on an `agent_start` (ADR-170). A `SessionStart`
  // seals its own; every other hook gets this one from the daemon.
  const reopening: TachoEvent[] =
    reopened === true && input.hook_event_name !== "SessionStart"
      ? [
          record.recorder.sealCollectorEvent(
            "agent_start",
            {
              session_start_source: "reopen",
              resume_of_session_id: record.harnessSessionId,
              resume_last_seq_seen: record.recorder.chainCursor.seq - 1,
            },
            {
              ts: at,
              hook_event_name: input.hook_event_name,
              attrs: replayAttrs(replay),
            },
          ),
        ]
      : [];
  // A replay of a hook this session already recorded — the client's own
  // request timed out and it fell back to a spool file, but the daemon had
  // already processed the live request before that timeout fired. Sealing
  // it again would open a second turn, a second tool_call, or (for
  // `UserPromptSubmit`) a phantom prompt nobody sent twice. Nothing new is
  // sealed for the replay; the answer is empty, which is safe here because a
  // replay is fed back into the daemon for its record only, not read by a
  // harness waiting on stdout. The key is remembered only once the route
  // succeeds (in `handleHookEvent`), so a live request that threw leaves no
  // sighting behind and its spool replay is sealed. A key the harness issued
  // (no `hook_id`) drops only a replay: a live request is answered in full,
  // because a harness waiting on a `PreToolUse` must get the policy's
  // decision, never an empty answer.
  const hookKey = hookLedgerKey(raw, record.harness, hookId);
  if (
    hookKey !== undefined &&
    (hookId !== undefined || replay !== undefined) &&
    sawHookId(record, hookKey)
  ) {
    return { events: reopening, response: {}, record };
  }
  // Stella's tool-use ids are derived from the call, so the daemon numbers
  // each invocation before anything reads the payload.
  const payload = invocationToolUseId(raw, input, record);
  const view = deps.policy();
  const events: TachoEvent[] = [...reopening];
  const replayed = replayAttrs(replay);
  const pushBasis = await gitPushBasis(input, record, deps);
  const withReplay = (draft: HookDraft): HookDraft => ({
    ...draft,
    ...(inferredCwd && record.cwd !== undefined
      ? { context: { ...draft.context, cwd: record.cwd } }
      : {}),
    attrs: {
      ...draft.attrs,
      ...replayed,
      // The push's own `command` frame carries the basis, the way every
      // model-proxy frame does, so a reader counts bypass pushes from the
      // frame rather than from a missing `token_use` beside it (#3788).
      ...(pushBasis !== undefined &&
      draft.kind === "command" &&
      draft.body["effect_kind"] === "git_push"
        ? { [TACHO_CREDENTIAL_BASIS_ATTR]: pushBasis }
        : {}),
    },
  });

  switch (input.hook_event_name) {
    case "SessionStart": {
      const block = operatorBlock(view, record);
      const context = view.bundle.context.system;
      // A blocked start answers with `continue: false` and carries no
      // context, so a message drained here would be sealed as delivered and
      // dropped. It waits for a start that is not blocked.
      // A replay's answer reaches no harness, so nothing drains there.
      const messages =
        block === undefined && replay === undefined
          ? drainMessages(record, deps, events, context?.length ?? 0)
          : [];
      const additional =
        block === undefined
          ? [context ?? "", ...messages.map((m) => m.text)]
              .filter((s) => s.length > 0)
              .join(CONTEXT_JOINER)
          : "";
      events.push(
        ...record.recorder.ingestHook(payload, env, at, (draft) =>
          withReplay({
            ...draft,
            attrs: {
              ...draft.attrs,
              ...(context !== null
                ? { "oxagen.context_digest": digestText(context) }
                : {}),
              // How much text this answer hands the agent, prefix and
              // messages together, to set against Claude Code's limit.
              "oxagen.delivered_chars": String(additional.length),
              ...(block !== undefined
                ? { "policy.reason_code": block.code }
                : {}),
            },
          }),
        ),
      );
      if (block !== undefined) {
        events.push(
          record.recorder.sealCollectorEvent(
            "policy_decision",
            {
              policy_decision: "deny",
              policy_source: block.source,
              policy_reason_code: block.code,
              policy_reason_digest: digestText(block.reason),
              bundle_version: view.bundle.version,
              bundle_mode: view.bundle.mode,
            },
            { hook_event_name: "SessionStart", attrs: replayed },
          ),
        );
        return {
          events,
          response: { continue: false, stopReason: block.reason },
          record,
        };
      }
      // What the agent was shown at this start, sealed into its chain beside
      // the start event (ADR-093): the bundle's manifest, and every steer
      // delivered with the prefix. A bundle from a control plane that signs
      // no manifest seals no frame, and the start event's context digest is
      // still the record of the text.
      const manifest = view.bundle.context.manifest;
      if (manifest !== undefined) {
        events.push(
          record.recorder.sealCollectorEvent(
            "steering.manifest",
            steeringManifestFrame(manifest, view.bundle, messages),
            { hook_event_name: "SessionStart", attrs: replayed },
          ),
        );
      }
      return {
        events,
        response:
          additional.length > 0
            ? {
                hookSpecificOutput: {
                  hookEventName: "SessionStart",
                  additionalContext: additional,
                },
              }
            : {},
        record,
      };
    }

    case "UserPromptSubmit": {
      const block = operatorBlock(view, record);
      const messages =
        block === undefined &&
        replay === undefined &&
        deliversMessages(record.harness, input.hook_event_name)
          ? drainMessages(record, deps, events)
          : [];
      // A person prompting supersedes a resume's continuation.
      if (block === undefined) record.control.resumeOwed = undefined;
      events.push(
        ...record.recorder.ingestHook(payload, env, at, (draft) =>
          withReplay({
            ...draft,
            body: {
              ...draft.body,
              policy_decision: block === undefined ? "allow" : "deny",
              policy_source: block?.source ?? "bundle",
              policy_reason_code: block?.code ?? "boundary_clear",
              bundle_version: view.bundle.version,
              bundle_mode: view.bundle.mode,
            },
          }),
        ),
      );
      if (block !== undefined) {
        return {
          events,
          response: { decision: "block", reason: block.reason },
          record,
        };
      }
      return {
        events,
        response:
          messages.length > 0
            ? {
                hookSpecificOutput: {
                  hookEventName: "UserPromptSubmit",
                  additionalContext: messages
                    .map((m) => m.text)
                    .join(CONTEXT_JOINER),
                },
              }
            : {},
        record,
      };
    }

    case "PreToolUse": {
      const toolName = input.tool_name ?? "unknown";
      const toolInput = input.tool_input;
      let currentView = view;
      let evaluation =
        replay?.evaluation ??
        evaluatePreToolUse(
          evaluationRequestFor(
            currentView,
            toolName,
            toolInput,
            record,
            deps,
            input,
          ),
        );
      if (evaluation.decision === "defer" && deps.refreshBundle) {
        await deps.refreshBundle();
        currentView = deps.policy();
        evaluation = evaluatePreToolUse(
          evaluationRequestFor(
            currentView,
            toolName,
            toolInput,
            record,
            deps,
            input,
          ),
        );
      }
      if (evaluation.decision === "defer") {
        // No way to refresh: the stale bundle fails closed on non-read-only tools.
        evaluation = {
          ...evaluation,
          decision: currentView.bundle.mode === "observe" ? "allow" : "deny",
          reason_code: "bundle_stale",
        };
      }
      // The pause refused the agent a call, so a resume owes it a
      // continuation (`SessionControl.pauseEffect`). A replay was decided
      // by `tacho-hook` from the cached bundle, which holds no session state.
      if (
        replay === undefined &&
        evaluation.decision === "deny" &&
        evaluation.reason_code === "session_paused" &&
        record.control.pauseEffect === undefined
      )
        record.control.pauseEffect = "refused";
      // An `interrupt` steer lands here: the call the agent is about to make
      // is refused with the steer as the reason, which the agent reads as
      // the tool's result, so the steer changes what it does next rather
      // than what it does after this step. The proxy cut the model call that
      // produced this one as retryable (`daemon.ts`), so the turn goes on.
      // Only a call the policy would allow is taken; a denied one already
      // stops the step, and its steer waits for the PostToolUse or Stop.
      if (
        evaluation.decision !== "deny" &&
        record.control.messages.some(
          (message) => message.deliveryMode === "interrupt",
        )
      ) {
        // The space is part of the lead, so the room held back counts it.
        const lead = "Your Oxagen operator interrupted this step. ";
        const texts = drainMidTurn(
          input,
          record,
          deps,
          events,
          replay,
          lead.length,
        );
        if (texts.length > 0) {
          const reason = `${lead}${texts.join(CONTEXT_JOINER)}`;
          evaluation = {
            ...evaluation,
            decision: "deny",
            evaluated: "deny",
            source: "human",
            reason_code: "steer_interrupt",
            reason,
          };
        }
      }
      const facts = policyFacts(evaluation, currentView);
      const attrs = policyAttrs(evaluation, replay);
      const toolDrafts = normalizeHook(payload, env, {
        sessionUuid: record.recorder.sessionUuid,
      });
      const toolDraft = toolDrafts.find(
        (draft) => draft.kind === "tool_requested",
      );
      const toolBody = toolDraft?.body ?? {};
      const spawnToolUseId = toolBody["tool_use_id"];
      // Sealed on the chain the tool request lands on: a subagent's call
      // is recorded on the subagent chain, and so is its decision.
      events.push(
        ...record.recorder.sealCollectorEventOn(
          toolDraft?.subagent,
          typeof spawnToolUseId === "string" ? spawnToolUseId : undefined,
          "policy_decision",
          { ...toolBody, ...facts },
          { hook_event_name: "PreToolUse", attrs },
        ),
      );
      const denied = evaluation.decision === "deny";
      events.push(
        ...record.recorder.ingestHook(payload, env, at, (draft) =>
          draft.kind === "tool_requested"
            ? {
                ...withReplay(draft),
                kind: denied ? "token_denied" : "tool_requested",
                body: { ...draft.body, ...facts },
                attrs: { ...draft.attrs, ...attrs },
              }
            : withReplay(draft),
        ),
      );
      const response =
        evaluation.decision === "allow"
          ? evaluation.evaluated === "allow" && evaluation.rule !== undefined
            ? {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                  permissionDecisionReason: evaluation.reason,
                },
              }
            : {}
          : evaluation.decision === "deny"
            ? {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: evaluation.reason,
                },
              }
            : evaluation.rule !== undefined
              ? {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "ask",
                    permissionDecisionReason: evaluation.reason,
                  },
                }
              : {};
      return { events, response, record, evaluation };
    }

    case "SubagentStart": {
      // Cursor answers subagentStart with permission allow|deny. An empty
      // response becomes allow, so evaluate before answering: operator blocks
      // and Task rules apply the way they do for PreToolUse.
      const toolInput =
        input.agent_type !== undefined || input.agent_id !== undefined
          ? {
              ...(input.agent_type !== undefined
                ? { subagent_type: input.agent_type }
                : {}),
              ...(input.agent_id !== undefined
                ? { subagent_id: input.agent_id }
                : {}),
            }
          : undefined;
      let currentView = view;
      let evaluation =
        replay?.evaluation ??
        evaluatePreToolUse(
          evaluationRequestFor(
            currentView,
            "Task",
            toolInput,
            record,
            deps,
            input,
          ),
        );
      if (evaluation.decision === "defer" && deps.refreshBundle) {
        await deps.refreshBundle();
        currentView = deps.policy();
        evaluation = evaluatePreToolUse(
          evaluationRequestFor(
            currentView,
            "Task",
            toolInput,
            record,
            deps,
            input,
          ),
        );
      }
      if (evaluation.decision === "defer") {
        evaluation = {
          ...evaluation,
          decision: currentView.bundle.mode === "observe" ? "allow" : "deny",
          reason_code: "bundle_stale",
        };
      }
      const facts = policyFacts(evaluation, currentView);
      const attrs = policyAttrs(evaluation, replay);
      events.push(
        record.recorder.sealCollectorEvent(
          "policy_decision",
          {
            tool_name: "Task",
            ...facts,
          },
          { hook_event_name: "SubagentStart", attrs },
        ),
      );
      events.push(
        ...record.recorder.ingestHook(payload, env, at, (draft) =>
          withReplay({
            ...draft,
            attrs: { ...draft.attrs, ...attrs },
          }),
        ),
      );
      const response =
        evaluation.decision === "allow"
          ? evaluation.evaluated === "allow" && evaluation.rule !== undefined
            ? {
                hookSpecificOutput: {
                  hookEventName: "SubagentStart",
                  permissionDecision: "allow",
                  permissionDecisionReason: evaluation.reason,
                },
              }
            : {}
          : evaluation.decision === "deny"
            ? {
                hookSpecificOutput: {
                  hookEventName: "SubagentStart",
                  permissionDecision: "deny",
                  permissionDecisionReason: evaluation.reason,
                },
              }
            : evaluation.rule !== undefined
              ? {
                  hookSpecificOutput: {
                    hookEventName: "SubagentStart",
                    permissionDecision: "ask",
                    permissionDecisionReason: evaluation.reason,
                  },
                }
              : {};
      return { events, response, record, evaluation };
    }

    case "PermissionRequest": {
      const block = operatorBlock(view, record);
      events.push(
        ...record.recorder.ingestHook(payload, env, at, (draft) =>
          withReplay({
            ...draft,
            body: {
              ...draft.body,
              ...(block !== undefined
                ? {
                    policy_decision: "deny",
                    policy_source: block.source,
                    policy_reason_code: block.code,
                    policy_reason_digest: digestText(block.reason),
                  }
                : {
                    policy_decision: "defer",
                    policy_source: "harness",
                    policy_reason_code: "elevation_v2",
                  }),
              bundle_version: view.bundle.version,
              bundle_mode: view.bundle.mode,
            },
          }),
        ),
      );
      if (block !== undefined) {
        return {
          events,
          response: {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "deny", message: block.reason },
            },
          },
          record,
        };
      }
      // Elevation through the control plane lands in plan PR 6; until then
      // the request falls through to Claude Code's own permission prompt.
      return { events, response: {}, record };
    }

    case "PostToolUse":
    case "PostToolUseFailure": {
      events.push(...record.recorder.ingestHook(payload, env, at, withReplay));
      if (operatorBlock(view, record) !== undefined)
        return { events, response: {}, record };
      const texts = drainMidTurn(input, record, deps, events, replay);
      return {
        events,
        response:
          texts.length > 0
            ? {
                hookSpecificOutput: {
                  hookEventName: input.hook_event_name,
                  additionalContext: texts.join(CONTEXT_JOINER),
                },
              }
            : {},
        record,
      };
    }

    case "Stop":
    case "StopFailure": {
      events.push(...record.recorder.ingestHook(payload, env, at, withReplay));
      const block = operatorBlock(view, record);
      if (block !== undefined) {
        // A paused agent ending its turn is let go: blocking this Stop would
        // send the model back against tools the pause denies, until Claude
        // Code's cap of eight blocks. Resume reads this to report the agent
        // idle rather than owe it a continuation it cannot receive.
        if (block.code === "session_paused" && replay === undefined)
          record.control.pauseEffect = "stopped";
        return { events, response: {}, record };
      }
      // Claude Code ignores a StopFailure answer, so only Stop drains.
      if (input.hook_event_name === "StopFailure")
        return { events, response: {}, record };
      // A queued steer, or a resume's continuation, keeps the turn going:
      // `decision: "block"` hands the reason to the model as what to do next.
      const texts = drainMidTurn(input, record, deps, events, replay);
      return {
        events,
        response:
          texts.length > 0
            ? { decision: "block", reason: texts.join(CONTEXT_JOINER) }
            : {},
        record,
      };
    }

    case "SessionEnd": {
      events.push(...record.recorder.ingestHook(payload, env, at, withReplay));
      deps.registry.seal(record);
      return { events, response: {}, record };
    }

    default: {
      events.push(...record.recorder.ingestHook(payload, env, at, withReplay));
      return { events, response: {}, record };
    }
  }
}

/** The tools that write a file named by an absolute path in their input. */
const FILE_WRITING_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * The directory of the file a write tool call names, when it names one by
 * absolute path. The daemon reads git from here, because the file an agent
 * writes shows which checkout it is working in, and its `cwd` may not.
 */
export function writtenDir(input: {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}): string | undefined {
  if (
    input.hook_event_name !== "PreToolUse" &&
    input.hook_event_name !== "PostToolUse"
  )
    return undefined;
  if (!FILE_WRITING_TOOLS.has(input.tool_name ?? "")) return undefined;
  const path =
    input.tool_input?.["file_path"] ?? input.tool_input?.["notebook_path"];
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  return dirname(path);
}
