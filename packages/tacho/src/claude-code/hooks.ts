/**
 * Claude Code hook payloads (stdin JSON) to Tacho events. Pure functions:
 * they take the payload and the hook process environment and return the
 * drafts the recorder seals. Every member the harness sends is either
 * promoted to a typed body member or kept in `attrs`, so nothing is dropped.
 *
 * Field-name drift between the live binary and the reference is tolerated
 * here (data-model.md section 6, "Name drift the adapter tolerates").
 */
import { z } from "zod";
import { digestJcs, jsonByteLength, type JsonValue } from "../digest";
import { effectId } from "../ids";
import type { BodyOf, TachoKind } from "../envelope";
import { contextFactsFromEnv, digestText, hostFactsFromEnv } from "./context";
import { classifyTool } from "./tools";

/** Tolerant: passthrough so a new upstream member lands in `attrs`. */
export const hookInputSchema = z
  .object({
    session_id: z.string(),
    hook_event_name: z.string(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    prompt_id: z.string().optional(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.unknown()).optional(),
    tool_use_id: z.string().optional(),
    tool_response: z.unknown().optional(),
    duration_ms: z.number().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export type HookInput = z.infer<typeof hookInputSchema>;

export interface HookDraft {
  kind: TachoKind;
  body: Record<string, unknown>;
  hook_event_name: string;
  hook_source_kind?: string;
  /** Extra attributes not promoted to a body member. */
  attrs: Record<string, string>;
  /** Subagent identity when the hook fired inside one. */
  subagent?: { subagent_id: string; subagent_type?: string };
  turn?: { prompt_id?: string; turn_id?: string };
  context: Record<string, unknown>;
  host: Record<string, unknown>;
  content_digest?: `sha256:${string}`;
  raw_source_digest: `sha256:${string}`;
}

const PROMOTED = new Set([
  "session_id",
  "hook_event_name",
  "transcript_path",
  "cwd",
  "prompt_id",
  "permission_mode",
  "agent_id",
  "agent_type",
  "tool_name",
  "tool_input",
  "tool_use_id",
  "tool_response",
  "duration_ms",
  "error",
  "error_type",
  "prompt",
  "user_input",
  "source",
  "trigger",
  "reason",
  "end_reason",
  "model",
  "command_name",
  "command_input",
  "last_assistant_message",
  "stop_hook_active",
  "background_tasks",
  "session_crons",
  "agent_transcript_path",
  "tool_calls",
  "turn_id",
  "message_id",
  "index",
  "final",
  "delta",
  "file_path",
  "memory_type",
  "load_reason",
  "notification_type",
  "task_name",
  "task_id",
  "previous_cwd",
  "new_cwd",
  "directory",
  "add_method",
  "worktree_path",
  "from_model",
  "to_model",
  "server_name",
  "elicitation_prompt",
  "message_type",
  "user_response",
  "config_source",
  "custom_instructions",
  "teammate_name",
  "subagent_result",
]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function leftovers(input: HookInput): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (PROMOTED.has(key) || value === undefined) {
      continue;
    }
    attrs[`hook.${key}`] =
      typeof value === "string" ? value : JSON.stringify(value);
  }
  return attrs;
}

function toolFacts(
  input: HookInput,
  sessionUuid: string,
): Record<string, unknown> {
  const name = input.tool_name ?? "unknown";
  const cls = classifyTool(name, input.tool_input);
  const facts: Record<string, unknown> = {
    tool_name: name,
    tool_source: cls.tool_source,
    effect_kind: cls.effect_kind,
    tool_is_mutating: cls.tool_is_mutating,
  };
  if (cls.mcp_server_name !== undefined)
    facts["mcp_server_name"] = cls.mcp_server_name;
  if (cls.mcp_tool_name !== undefined)
    facts["mcp_tool_name"] = cls.mcp_tool_name;
  if (cls.tool_target !== undefined) facts["tool_target"] = cls.tool_target;
  if (cls.tool_targets !== undefined) facts["tool_targets"] = cls.tool_targets;
  if (input.tool_use_id !== undefined) facts["tool_use_id"] = input.tool_use_id;
  if (input.tool_input !== undefined) {
    facts["tool_input_digest"] = digestJcs(input.tool_input as JsonValue);
    facts["tool_input_bytes"] = jsonByteLength(input.tool_input);
  }
  if (
    input.tool_use_id !== undefined &&
    cls.effect_kind !== "other" &&
    cls.effect_kind !== "subagent"
  ) {
    facts["effect_id"] = effectId(
      sessionUuid,
      input.tool_use_id,
      cls.tool_target ?? name,
    );
  }
  return facts;
}

export interface NormalizeHookOptions {
  /** The Tacho session uuid of the chain this hook lands in (parent or child). */
  sessionUuid: string;
}

/** Map one hook payload to the Tacho drafts it justifies. */
export function normalizeHook(
  raw: unknown,
  env: Record<string, string | undefined>,
  options: NormalizeHookOptions,
): HookDraft[] {
  const input = hookInputSchema.parse(raw);
  const base = {
    hook_event_name: input.hook_event_name,
    attrs: leftovers(input),
    ...(input.agent_id !== undefined
      ? {
          subagent: {
            subagent_id: input.agent_id,
            ...(input.agent_type !== undefined
              ? { subagent_type: input.agent_type }
              : {}),
          },
        }
      : {}),
    turn: {
      ...(input.prompt_id !== undefined ? { prompt_id: input.prompt_id } : {}),
      ...(str(input["turn_id"]) !== undefined
        ? { turn_id: str(input["turn_id"]) }
        : {}),
    },
    context: {
      ...contextFactsFromEnv(env),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.permission_mode !== undefined
        ? { permission_mode: input.permission_mode }
        : {}),
      ...(str(input["model"]) !== undefined
        ? { model: str(input["model"]) }
        : {}),
    },
    host: hostFactsFromEnv(env),
    raw_source_digest: digestJcs(input as unknown as JsonValue),
  };
  const draft = (
    kind: TachoKind,
    body: Record<string, unknown>,
    extra: Partial<HookDraft> = {},
  ): HookDraft => ({
    kind,
    body,
    ...base,
    ...extra,
  });

  switch (input.hook_event_name) {
    case "SessionStart": {
      const source = str(input["source"]) ?? str(input["trigger"]) ?? "startup";
      const body: BodyOf<"agent_start"> = {
        session_start_source: source,
        ...(input.transcript_path !== undefined
          ? { transcript_path: input.transcript_path }
          : {}),
        ...(str(input["model"]) !== undefined
          ? { model: str(input["model"]) }
          : {}),
      };
      return [draft("agent_start", body, { hook_source_kind: source })];
    }
    case "Setup": {
      const trigger = str(input["trigger"]);
      return [
        draft(
          "oxagen:notification",
          { ...(trigger !== undefined ? { setup_trigger: trigger } : {}) },
          { hook_source_kind: trigger },
        ),
      ];
    }
    case "InstructionsLoaded": {
      const body: BodyOf<"oxagen:instructions_loaded"> = {
        ...(str(input["file_path"]) !== undefined
          ? { instructions_file_path: str(input["file_path"]) }
          : {}),
        ...(str(input["memory_type"]) !== undefined
          ? { instructions_memory_type: str(input["memory_type"]) }
          : {}),
        ...(str(input["load_reason"]) !== undefined
          ? { instructions_load_reason: str(input["load_reason"]) }
          : {}),
      };
      return [
        draft("oxagen:instructions_loaded", body, {
          hook_source_kind: str(input["load_reason"]),
        }),
      ];
    }
    case "UserPromptSubmit":
    case "UserPromptExpansion": {
      const prompt = str(input["prompt"]) ?? str(input["user_input"]);
      const body: BodyOf<"turn_start"> = {
        ...(prompt !== undefined
          ? { prompt_digest: digestText(prompt), prompt_length: prompt.length }
          : {}),
        ...(str(input["command_name"]) !== undefined
          ? { command_name: str(input["command_name"]) }
          : {}),
        ...(str(input["command_input"]) !== undefined
          ? {
              command_input_digest: digestText(
                str(input["command_input"]) ?? "",
              ),
            }
          : {}),
      };
      const kind: TachoKind =
        input.hook_event_name === "UserPromptSubmit"
          ? "turn_start"
          : "oxagen:message";
      return [
        draft(
          kind,
          body,
          prompt !== undefined ? { content_digest: digestText(prompt) } : {},
        ),
      ];
    }
    case "PreToolUse": {
      return [draft("tool_requested", toolFacts(input, options.sessionUuid))];
    }
    case "PermissionRequest": {
      return [
        draft("approval_request", {
          ...toolFacts(input, options.sessionUuid),
          policy_decision: "ask",
          policy_source: "harness",
        }),
      ];
    }
    case "PermissionDenied": {
      return [
        draft("policy_decision", {
          ...toolFacts(input, options.sessionUuid),
          policy_decision: "deny",
          policy_source: "harness",
          tool_decision: "reject",
        }),
      ];
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const failed = input.hook_event_name === "PostToolUseFailure";
      const facts = toolFacts(input, options.sessionUuid);
      const body: Record<string, unknown> = {
        ...facts,
        tool_status: failed ? "error" : "ok",
        ...(input.duration_ms !== undefined
          ? { tool_duration_ms: num(input.duration_ms) }
          : {}),
      };
      if (input.tool_response !== undefined) {
        body["tool_output_digest"] = digestJcs(
          input.tool_response as JsonValue,
        );
        body["tool_output_bytes"] = jsonByteLength(input.tool_response);
      }
      if (failed) {
        const error = input.error ?? input["error_type"];
        if (error !== undefined) {
          const text =
            typeof error === "string" ? error : JSON.stringify(error);
          body["tool_error_class"] =
            text.split(/[:\n]/, 1)[0]?.slice(0, 128) ?? "error";
          body["tool_error_message_digest"] = digestText(text);
        }
      }
      const drafts = [draft("tool_call", body)];
      const effectKind = facts["effect_kind"];
      if (
        !failed &&
        facts["effect_id"] !== undefined &&
        (effectKind === "file_write" ||
          effectKind === "file_edit" ||
          effectKind === "file_delete")
      ) {
        drafts.push(draft("file_io", { ...facts, tool_status: "ok" }));
      } else if (
        !failed &&
        facts["effect_id"] !== undefined &&
        effectKind === "command"
      ) {
        drafts.push(draft("command", { ...facts, tool_status: "ok" }));
      } else if (
        !failed &&
        facts["effect_id"] !== undefined &&
        effectKind === "network"
      ) {
        drafts.push(draft("network", { ...facts, tool_status: "ok" }));
      }
      return drafts;
    }
    case "PostToolBatch": {
      const calls = Array.isArray(input["tool_calls"])
        ? (input["tool_calls"] as unknown[])
        : [];
      return calls.map((call, index) => {
        const record = (call ?? {}) as Record<string, unknown>;
        const sub = hookInputSchema.parse({
          ...input,
          ...record,
          tool_calls: undefined,
        });
        return draft("policy_decision", {
          ...toolFacts(sub, options.sessionUuid),
          batch_size: calls.length,
          batch_index: index,
          policy_decision: "allow",
          policy_source: "harness",
          ...(bool(record["succeeded"]) !== undefined
            ? { tool_status: record["succeeded"] ? "ok" : "error" }
            : {}),
        });
      });
    }
    case "Stop":
    case "SubagentStop": {
      const last = str(input["last_assistant_message"]);
      const common: Record<string, unknown> = {
        ...(last !== undefined
          ? { last_assistant_message_digest: digestText(last) }
          : {}),
        ...(bool(input["stop_hook_active"]) !== undefined
          ? { stop_hook_active: bool(input["stop_hook_active"]) }
          : {}),
        ...(input["background_tasks"] !== undefined
          ? { background_tasks: input["background_tasks"] }
          : {}),
        ...(input["session_crons"] !== undefined
          ? { session_crons: input["session_crons"] }
          : {}),
      };
      if (input.hook_event_name === "Stop") {
        return [
          draft(
            "turn_end",
            common,
            last !== undefined ? { content_digest: digestText(last) } : {},
          ),
        ];
      }
      const body: BodyOf<"subagent_stop"> = {
        ...(last !== undefined
          ? { subagent_result_digest: digestText(last) }
          : {}),
        ...(str(input["agent_transcript_path"]) !== undefined
          ? { subagent_transcript_path: str(input["agent_transcript_path"]) }
          : {}),
        tool_status: "ok",
      };
      return [draft("subagent_stop", body)];
    }
    case "StopFailure": {
      const error = str(input["error_type"]) ?? str(input.error);
      const last = str(input["last_assistant_message"]);
      return [
        draft("error", {
          ...(error !== undefined
            ? { stop_failure_error_type: error, api_error_class: error }
            : {}),
          ...(last !== undefined
            ? { last_assistant_message_digest: digestText(last) }
            : {}),
        }),
      ];
    }
    case "SubagentStart": {
      const body: BodyOf<"subagent_start"> = {
        ...(input.tool_use_id !== undefined
          ? { tool_use_id: input.tool_use_id }
          : {}),
      };
      return [draft("subagent_start", body)];
    }
    case "MessageDisplay": {
      const delta = str(input["delta"]);
      return [
        draft("oxagen:message", {
          ...(delta !== undefined
            ? {
                response_digest: digestText(delta),
                response_length: delta.length,
              }
            : {}),
          ...(num(input["index"]) !== undefined
            ? { message_index: num(input["index"]) }
            : {}),
          ...(bool(input["final"]) !== undefined
            ? { message_final: bool(input["final"]) }
            : {}),
          ...(str(input["message_id"]) !== undefined
            ? { message_uuid: str(input["message_id"]) }
            : {}),
        }),
      ];
    }
    case "PreCompact":
    case "PostCompact": {
      const trigger = str(input["trigger"]);
      const custom = str(input["custom_instructions"]);
      return [
        draft(
          "oxagen:compaction",
          {
            ...(trigger !== undefined ? { compact_trigger: trigger } : {}),
            ...(custom !== undefined
              ? { compact_custom_instructions_digest: digestText(custom) }
              : {}),
          },
          {
            hook_source_kind: `${input.hook_event_name}:${trigger ?? "unknown"}`,
          },
        ),
      ];
    }
    case "PreModelSwitch":
    case "PostModelSwitch": {
      return [
        draft("oxagen:model_switch", {
          ...(str(input["from_model"]) !== undefined
            ? { model_from: str(input["from_model"]) }
            : {}),
          ...(str(input["to_model"]) !== undefined
            ? { model_to: str(input["to_model"]) }
            : {}),
          model_switch_reason: input.hook_event_name,
        }),
      ];
    }
    case "Notification": {
      const type = str(input["notification_type"]) ?? str(input["type"]);
      return [
        draft(
          "oxagen:notification",
          { ...(type !== undefined ? { notification_type: type } : {}) },
          { hook_source_kind: type },
        ),
      ];
    }
    case "TaskCreated":
    case "TaskCompleted": {
      return [
        draft(
          "oxagen:task",
          {
            ...(str(input["task_name"]) !== undefined
              ? { task_name: str(input["task_name"]) }
              : {}),
            ...(str(input["task_id"]) !== undefined
              ? { task_id: str(input["task_id"]) }
              : {}),
          },
          { hook_source_kind: input.hook_event_name },
        ),
      ];
    }
    case "ConfigChange": {
      return [
        draft("oxagen:config_change", {
          ...(str(input["file_path"]) !== undefined
            ? { config_file_path: str(input["file_path"]) }
            : {}),
          ...(str(input["config_source"]) !== undefined
            ? { config_source: str(input["config_source"]) }
            : {}),
          ...(str(input["source"]) !== undefined
            ? { config_source: str(input["source"]) }
            : {}),
        }),
      ];
    }
    case "CwdChanged": {
      return [
        draft("oxagen:cwd_change", {
          ...(str(input["previous_cwd"]) !== undefined
            ? { cwd_previous: str(input["previous_cwd"]) }
            : {}),
          ...(str(input["new_cwd"]) !== undefined
            ? { cwd_new: str(input["new_cwd"]) }
            : {}),
        }),
      ];
    }
    case "DirectoryAdded": {
      return [
        draft("oxagen:cwd_change", {
          ...(str(input["directory"]) !== undefined
            ? { directory_added: str(input["directory"]) }
            : {}),
          ...(str(input["add_method"]) !== undefined
            ? { directory_add_method: str(input["add_method"]) }
            : {}),
        }),
      ];
    }
    case "FileChanged": {
      return [
        draft("oxagen:file_changed", {
          ...(str(input["file_path"]) !== undefined
            ? { file_changed_path: str(input["file_path"]) }
            : {}),
        }),
      ];
    }
    case "WorktreeCreate":
    case "WorktreeRemove": {
      return [
        draft(
          "oxagen:worktree",
          {
            ...(str(input["reason"]) !== undefined
              ? { worktree_reason: str(input["reason"]) }
              : {}),
          },
          {
            hook_source_kind: input.hook_event_name,
            context: {
              ...base.context,
              ...(str(input["worktree_path"]) !== undefined
                ? { worktree_path: str(input["worktree_path"]) }
                : {}),
            },
          },
        ),
      ];
    }
    case "Elicitation":
    case "ElicitationResult": {
      const prompt = str(input["elicitation_prompt"]);
      const response = str(input["user_response"]);
      return [
        draft("oxagen:elicitation", {
          ...(str(input["server_name"]) !== undefined
            ? { elicitation_server: str(input["server_name"]) }
            : {}),
          ...(str(input["message_type"]) !== undefined
            ? { elicitation_message_type: str(input["message_type"]) }
            : {}),
          ...(prompt !== undefined
            ? { elicitation_prompt_digest: digestText(prompt) }
            : {}),
          ...(response !== undefined
            ? { elicitation_response_digest: digestText(response) }
            : {}),
        }),
      ];
    }
    case "TeammateIdle": {
      return [
        draft("oxagen:notification", {
          ...(str(input["teammate_name"]) !== undefined
            ? { teammate_name: str(input["teammate_name"]) }
            : {}),
        }),
      ];
    }
    case "SessionEnd": {
      const reason =
        str(input["reason"]) ?? str(input["end_reason"]) ?? "other";
      const body: BodyOf<"agent_stop"> = {
        session_end_reason: reason,
        session_outcome:
          reason === "prompt_input_exit" ||
          reason === "other" ||
          reason === "clear"
            ? "completed"
            : "aborted",
      };
      return [draft("agent_stop", body, { hook_source_kind: reason })];
    }
    default: {
      // An event this adapter does not know yet is still recorded, with its
      // whole payload in attrs, so a new upstream hook is never lost.
      return [
        draft("oxagen:notification", {
          notification_type: input.hook_event_name,
        }),
      ];
    }
  }
}
