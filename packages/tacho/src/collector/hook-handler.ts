/**
 * `handleHookEvent`: one Claude Code-shaped hook payload in, the chained Tacho
 * events and the hook's JSON answer out (spec section 5.4). Pure over its
 * dependencies: the registry, the current policy view, a clock, and an
 * optional bundle refresh for the `defer` path. The daemon, the spool
 * replay, and (in PR 5) the Claude Agent SDK adapter all call this.
 */
import {
  hookInputSchema,
  normalizeHook,
  type HookDraft,
  type HookInput,
} from "../claude-code/hooks";
import { digestText } from "../claude-code/context";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { toProtocolTimestamp } from "../timestamp";
import {
  customAgentNameProblem,
  type CommandAcknowledgement,
  type DenyGeneration,
  type PolicyBundle,
  type TachoHarness,
} from "../wire";
import {
  type Evaluation,
  type EvaluationInput,
  evaluatePreToolUse,
  type MatchContext,
} from "../host/bundle";
import type { SessionRecord, SessionRegistry } from "./registry";

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
}

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
  match?: MatchContext;
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
): { code: string; reason: string } | undefined {
  if (view.hostStatus === "suspended" || view.hostStatus === "revoked") {
    return {
      code: `host_${view.hostStatus}`,
      reason: `This host is ${view.hostStatus} by its Oxagen operator.`,
    };
  }
  if (view.hostStatus === "paused") {
    return {
      code: "host_paused",
      reason: "This host is paused by its Oxagen operator.",
    };
  }
  if (record.control.cancelled !== null) {
    return {
      code: "session_cancelled",
      reason: `This session was cancelled by its Oxagen operator: ${record.control.cancelled}`,
    };
  }
  if (record.control.paused !== null) {
    return {
      code: "session_paused",
      reason: `This session is paused by its Oxagen operator: ${record.control.paused}`,
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
 * Claude Code takes `additionalContext` at SessionStart and at
 * UserPromptSubmit; Stella reads only SessionStart stdout as prompt text and
 * answers every other event with a decision document that has nowhere to put
 * prose (`stellaAnswer`). Cursor is the same shape for a different reason:
 * `additional_context` is a field of its sessionStart answer alone, and its
 * beforeSubmitPrompt answer carries only `continue` and a `user_message`
 * shown to the person, not to the agent. Draining at either harness's
 * UserPromptSubmit would seal `message_delivered` and tell the fleet the
 * command applied while the agent never saw a word, so the message stays
 * queued for a boundary that carries it.
 */
function deliversMessages(
  harness: TachoHarness | undefined,
  hookEventName: string,
): boolean {
  if (harness !== "stella" && harness !== "cursor") return true;
  return hookEventName === "SessionStart";
}

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
 */
function drainMessages(
  record: SessionRecord,
  deps: HookHandlerDeps,
  events: TachoEvent[],
): string[] {
  const texts: string[] = [];
  const now = deps.now();
  for (const message of record.control.messages.splice(0)) {
    if (message.expiresAt !== null && Date.parse(message.expiresAt) < now) {
      deps.acknowledge?.({
        command_id: message.id,
        status: "expired",
        session_uuid: record.recorder.sessionUuid,
        detail: "expired before a boundary",
      });
      continue;
    }
    texts.push(message.text);
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
  return texts;
}

/**
 * Map one hook payload to its events and its answer. `agent` names a custom
 * agent (`tacho hook --agent <name>`): its payload is Claude Code's shape and
 * its session is labelled `runtime: "custom"`, `harness: <name>`.
 */
export async function handleHookEvent(
  raw: unknown,
  env: Record<string, string | undefined>,
  deps: HookHandlerDeps,
  replay?: HookReplay,
  harness?: TachoHarness,
  agent?: string,
): Promise<HookOutcome> {
  const outcome = await routeHook(raw, env, deps, replay, harness, agent);
  // Drained after the route, whichever branch returned: every event the
  // route sealed is in `events` by now, so every body is pending on the
  // recorder, and taking them here is what keeps the two lists paired.
  return { ...outcome, bodies: outcome.record?.recorder.takeBodies() ?? [] };
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
): EvaluationInput {
  return {
    bundle: view.bundle,
    bundleVerified: view.verified,
    toolName,
    ...(toolInput !== undefined ? { toolInput } : {}),
    hostStatus: view.hostStatus,
    session: record.control,
    latestDenyGeneration: view.denyGeneration,
    controlReachable: view.controlReachable,
    ...(view.mandateConfirmedAt !== undefined
      ? { mandateConfirmedAt: view.mandateConfirmedAt }
      : {}),
    now: deps.now(),
    context: {
      ...deps.match,
      ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    },
  };
}

async function routeHook(
  raw: unknown,
  env: Record<string, string | undefined>,
  deps: HookHandlerDeps,
  replay?: HookReplay,
  harness?: TachoHarness,
  agent?: string,
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
  const { record } = deps.registry.ensure(input.session_id, {
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
  // Stella's tool-use ids are derived from the call, so the daemon numbers
  // each invocation before anything reads the payload.
  const payload = invocationToolUseId(raw, input, record);
  const view = deps.policy();
  const events: TachoEvent[] = [];
  const replayed = replayAttrs(replay);
  const withReplay = (draft: HookDraft): HookDraft => ({
    ...draft,
    ...(inferredCwd && record.cwd !== undefined
      ? { context: { ...draft.context, cwd: record.cwd } }
      : {}),
    attrs: { ...draft.attrs, ...replayed },
  });

  switch (input.hook_event_name) {
    case "SessionStart": {
      const block = operatorBlock(view, record);
      const context = view.bundle.context.system;
      // A blocked start answers with `continue: false` and carries no
      // context, so a message drained here would be sealed as delivered and
      // dropped. It waits for a start that is not blocked.
      const messages =
        block === undefined ? drainMessages(record, deps, events) : [];
      events.push(
        ...record.recorder.ingestHook(payload, env, at, (draft) =>
          withReplay({
            ...draft,
            attrs: {
              ...draft.attrs,
              ...(context !== null
                ? { "oxagen.context_digest": digestText(context) }
                : {}),
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
              policy_source: "human",
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
      const additional = [context ?? "", ...messages].filter(
        (s) => s.length > 0,
      );
      return {
        events,
        response:
          additional.length > 0
            ? {
                hookSpecificOutput: {
                  hookEventName: "SessionStart",
                  additionalContext: additional.join("\n\n"),
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
        deliversMessages(record.harness, input.hook_event_name)
          ? drainMessages(record, deps, events)
          : [];
      events.push(
        ...record.recorder.ingestHook(payload, env, at, (draft) =>
          withReplay({
            ...draft,
            body: {
              ...draft.body,
              policy_decision: block === undefined ? "allow" : "deny",
              policy_source: block === undefined ? "bundle" : "human",
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
                  additionalContext: messages.join("\n\n"),
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
          evaluationRequestFor(currentView, toolName, toolInput, record, deps),
        );
      if (evaluation.decision === "defer" && deps.refreshBundle) {
        await deps.refreshBundle();
        currentView = deps.policy();
        evaluation = evaluatePreToolUse(
          evaluationRequestFor(currentView, toolName, toolInput, record, deps),
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
      const facts = policyFacts(evaluation, currentView);
      const attrs = policyAttrs(evaluation, replay);
      const toolDrafts = normalizeHook(payload, env, {
        sessionUuid: record.recorder.sessionUuid,
      });
      const toolBody =
        toolDrafts.find((draft) => draft.kind === "tool_requested")?.body ?? {};
      events.push(
        record.recorder.sealCollectorEvent(
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
          evaluationRequestFor(currentView, "Task", toolInput, record, deps),
        );
      if (evaluation.decision === "defer" && deps.refreshBundle) {
        await deps.refreshBundle();
        currentView = deps.policy();
        evaluation = evaluatePreToolUse(
          evaluationRequestFor(currentView, "Task", toolInput, record, deps),
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
                    policy_source: "human",
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
