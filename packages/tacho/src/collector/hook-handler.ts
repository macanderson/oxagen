/**
 * `handleHookEvent`: one Claude Code hook payload in, the chained Tacho
 * events and the hook's JSON answer out (spec section 5.4). Pure over its
 * dependencies: the registry, the current policy view, a clock, and an
 * optional bundle refresh for the `defer` path. The daemon, the spool
 * replay, and (in PR 5) the Claude Agent SDK adapter all call this.
 */
import {
  hookInputSchema,
  normalizeHook,
  type HookDraft,
} from "../claude-code/hooks";
import { digestText } from "../claude-code/context";
import type { TachoEvent } from "../envelope";
import { toProtocolTimestamp } from "../timestamp";
import type { DenyGeneration, PolicyBundle } from "../wire";
import {
  type Evaluation,
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
}

export interface HookHandlerDeps {
  registry: SessionRegistry;
  policy: () => PolicyView;
  /** Refresh the bundle synchronously for a stale-bundle `defer`; absent in `tacho-hook`. */
  refreshBundle?: () => Promise<void>;
  /** Called when a queued operator message is delivered at a boundary. */
  onMessageDelivered?: (
    commandId: string,
    sessionUuid: string,
    seq: number,
  ) => void;
  now: () => number;
  match?: MatchContext;
}

export interface HookReplay {
  /** The time `tacho-hook` recorded the event while the daemon was down. */
  receivedAt: string;
  /** The decision `tacho-hook` made from the cached bundle. */
  evaluation?: Evaluation;
}

export interface HookOutcome {
  events: TachoEvent[];
  /** The JSON document the hook prints on stdout (empty object = continue). */
  response: Record<string, unknown>;
  record?: SessionRecord;
  evaluation?: Evaluation;
}

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
    ...(replay !== undefined
      ? { "hook.replayed": "1", "hook.received_at": replay.receivedAt }
      : {}),
  };
}

function pidFromEnv(
  env: Record<string, string | undefined>,
): number | undefined {
  const pid = env["CLAUDE_PID"];
  return pid !== undefined && /^\d+$/.test(pid) ? Number(pid) : undefined;
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

function drainMessages(
  record: SessionRecord,
  deps: HookHandlerDeps,
  events: TachoEvent[],
): string[] {
  const texts: string[] = [];
  for (const message of record.control.messages.splice(0)) {
    texts.push(message.text);
    const event = record.recorder.sealCollectorEvent(
      "oxagen:command_applied",
      {
        policy_decision: "allow",
        policy_source: "human",
        policy_reason_code: "message_delivered",
        policy_reason_digest: digestText(message.text),
      },
      { attrs: { "command.id": message.id, "command.name": "message" } },
    );
    events.push(event);
    deps.onMessageDelivered?.(
      message.id,
      record.recorder.sessionUuid,
      event.seq,
    );
  }
  return texts;
}

/** Map one hook payload to its events and its answer. */
export async function handleHookEvent(
  raw: unknown,
  env: Record<string, string | undefined>,
  deps: HookHandlerDeps,
  replay?: HookReplay,
): Promise<HookOutcome> {
  const input = hookInputSchema.parse(raw);
  const at = replay?.receivedAt ?? toProtocolTimestamp(deps.now());
  const { record } = deps.registry.ensure(input.session_id, {
    ambient: false,
    ...(input.transcript_path !== undefined
      ? { transcriptPath: input.transcript_path }
      : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(pidFromEnv(env) !== undefined ? { pid: pidFromEnv(env) } : {}),
  });
  const view = deps.policy();
  const events: TachoEvent[] = [];
  const replayAttrs: Record<string, string> =
    replay !== undefined
      ? { "hook.replayed": "1", "hook.received_at": replay.receivedAt }
      : {};
  const withReplay = (draft: HookDraft): HookDraft => ({
    ...draft,
    attrs: { ...draft.attrs, ...replayAttrs },
  });

  switch (input.hook_event_name) {
    case "SessionStart": {
      const block = operatorBlock(view, record);
      const context = view.bundle.context.system;
      const messages = drainMessages(record, deps, events);
      events.push(
        ...record.recorder.ingestHook(raw, env, at, (draft) =>
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
            { hook_event_name: "SessionStart", attrs: replayAttrs },
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
        block === undefined ? drainMessages(record, deps, events) : [];
      events.push(
        ...record.recorder.ingestHook(raw, env, at, (draft) =>
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
        evaluatePreToolUse({
          bundle: currentView.bundle,
          bundleVerified: currentView.verified,
          toolName,
          ...(toolInput !== undefined ? { toolInput } : {}),
          hostStatus: currentView.hostStatus,
          session: record.control,
          latestDenyGeneration: currentView.denyGeneration,
          controlReachable: currentView.controlReachable,
          now: deps.now(),
          context: {
            ...deps.match,
            ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
          },
        });
      if (evaluation.decision === "defer" && deps.refreshBundle) {
        await deps.refreshBundle();
        currentView = deps.policy();
        evaluation = evaluatePreToolUse({
          bundle: currentView.bundle,
          bundleVerified: currentView.verified,
          toolName,
          ...(toolInput !== undefined ? { toolInput } : {}),
          hostStatus: currentView.hostStatus,
          session: record.control,
          latestDenyGeneration: currentView.denyGeneration,
          controlReachable: currentView.controlReachable,
          now: deps.now(),
          context: {
            ...deps.match,
            ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
          },
        });
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
      const toolDrafts = normalizeHook(raw, env, {
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
        ...record.recorder.ingestHook(raw, env, at, (draft) =>
          draft.kind === "tool_requested"
            ? {
                ...draft,
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

    case "PermissionRequest": {
      const block = operatorBlock(view, record);
      events.push(
        ...record.recorder.ingestHook(raw, env, at, (draft) =>
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
      events.push(...record.recorder.ingestHook(raw, env, at, withReplay));
      deps.registry.seal(input.session_id);
      return { events, response: {}, record };
    }

    default: {
      events.push(...record.recorder.ingestHook(raw, env, at, withReplay));
      return { events, response: {}, record };
    }
  }
}
