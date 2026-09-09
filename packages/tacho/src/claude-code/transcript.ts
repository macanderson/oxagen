/**
 * Claude Code session transcript records (one JSON object per line) to the
 * facts only the transcript carries: cache tiers, thinking tokens, server
 * tool use, per-turn durations, permission-mode changes, worktree state,
 * cost state, and the session title. Pure.
 */
import { digestJcs, type JsonValue } from "../digest";
import type { TachoKind } from "../envelope";
import { digestText } from "./context";

export interface TranscriptDraft {
  kind: TachoKind;
  ts: string;
  body: Record<string, unknown>;
  attrs: Record<string, string>;
  context: Record<string, unknown>;
  turn?: { prompt_id?: string };
  is_sidechain?: boolean;
  raw_source_digest: `sha256:${string}`;
}

export interface TranscriptTotals {
  total_cost_usd_micros?: number;
  api_duration_ms?: number;
  api_duration_without_retries_ms?: number;
  tool_duration_ms_total?: number;
  duration_ms?: number;
  lines_added?: number;
  lines_removed?: number;
  has_unknown_model_cost?: boolean;
  models_used?: Record<string, unknown>;
  session_title?: string;
  permission_mode?: string;
}

export interface TranscriptNormalized {
  drafts: TranscriptDraft[];
  totals: Partial<TranscriptTotals>;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}
function s(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function n(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
function b(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function contextOf(record: Rec): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) context[key] = value;
  };
  set("cwd", s(record["cwd"]));
  set("git_branch", s(record["gitBranch"]));
  set("entrypoint", s(record["entrypoint"]));
  set("session_kind", s(record["sessionKind"]));
  set("permission_mode", s(record["permissionMode"]));
  set("app_version", s(record["version"]));
  set("effort", s(record["effort"]));
  return context;
}

function tsOf(record: Rec, fallback: string): string {
  const value = s(record["timestamp"]) ?? s(record["ts"]);
  if (value !== undefined && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

/** Normalize one transcript line. Returns nothing for lines that carry no fact. */
export function normalizeTranscriptLine(
  line: string,
  fallbackTs: string,
): TranscriptNormalized {
  const trimmed = line.trim();
  if (trimmed === "") return { drafts: [], totals: {} };
  let record: Rec;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const asRecord = rec(parsed);
    if (!asRecord) return { drafts: [], totals: {} };
    record = asRecord;
  } catch {
    return { drafts: [], totals: {} };
  }
  const type = s(record["type"]);
  const ts = tsOf(record, fallbackTs);
  const raw = digestJcs(record as JsonValue);
  const draft = (
    kind: TachoKind,
    body: Record<string, unknown>,
    attrs: Record<string, string> = {},
  ): TranscriptDraft => ({
    kind,
    ts,
    body,
    attrs,
    context: contextOf(record),
    ...(s(record["promptId"]) !== undefined
      ? { turn: { prompt_id: s(record["promptId"]) } }
      : {}),
    ...(b(record["isSidechain"]) !== undefined
      ? { is_sidechain: b(record["isSidechain"]) }
      : {}),
    raw_source_digest: raw,
  });

  switch (type) {
    case "assistant": {
      const message = rec(record["message"]);
      const usage = rec(message?.["usage"]);
      const cacheCreation = rec(usage?.["cache_creation"]);
      const outputDetails = rec(usage?.["output_tokens_details"]);
      const serverTools = rec(usage?.["server_tool_use"]);
      const body: Record<string, unknown> = {};
      const set = (key: string, value: unknown) => {
        if (value !== undefined) body[key] = value;
      };
      set("model", s(message?.["model"]));
      set("message_id", s(message?.["id"]));
      set("message_uuid", s(record["uuid"]));
      set("request_id", s(record["requestId"]));
      set("stop_reason", s(message?.["stop_reason"]));
      set("stop_sequence", s(message?.["stop_sequence"]));
      set("stop_details", message?.["stop_details"] ?? undefined);
      set("context_management", message?.["context_management"] ?? undefined);
      set("input_tokens", n(usage?.["input_tokens"]));
      set("output_tokens", n(usage?.["output_tokens"]));
      set("cache_read_tokens", n(usage?.["cache_read_input_tokens"]));
      set("cache_creation_tokens", n(usage?.["cache_creation_input_tokens"]));
      set(
        "cache_creation_5m_tokens",
        n(cacheCreation?.["ephemeral_5m_input_tokens"]),
      );
      set(
        "cache_creation_1h_tokens",
        n(cacheCreation?.["ephemeral_1h_input_tokens"]),
      );
      set("thinking_tokens", n(outputDetails?.["thinking_tokens"]));
      set("web_search_requests", n(serverTools?.["web_search_requests"]));
      set("web_fetch_requests", n(serverTools?.["web_fetch_requests"]));
      set("service_tier", s(usage?.["service_tier"]));
      set("speed", s(usage?.["speed"]));
      set("inference_geo", s(usage?.["inference_geo"]));
      set(
        "iterations",
        Array.isArray(usage?.["iterations"])
          ? usage?.["iterations"].length
          : undefined,
      );
      set("api_block_index", n(record["apiBlockIndex"]));
      set("truncated_after_output", b(record["truncatedAfterOutput"]));
      set("skill_name", s(record["attributionSkill"]));
      set("mcp_server_name", s(record["attributionMcpServer"]));
      set("mcp_tool_name", s(record["attributionMcpTool"]));
      if (b(record["isApiErrorMessage"]) === true) {
        set("api_error_class", s(record["error"]) ?? "api_error");
      }
      const attrs: Record<string, string> = {};
      const content = message?.["content"];
      if (Array.isArray(content)) {
        const kinds = content.map(
          (block) => s(rec(block)?.["type"]) ?? "unknown",
        );
        attrs["transcript.content_block_types"] = JSON.stringify(kinds);
        const toolUses = content
          .filter((block) => s(rec(block)?.["type"]) === "tool_use")
          .map((block) => s(rec(block)?.["id"]) ?? "");
        if (toolUses.length > 0)
          attrs["transcript.tool_use_ids"] = JSON.stringify(toolUses);
      }
      return {
        drafts: [
          draft(
            b(record["isApiErrorMessage"]) === true ? "error" : "llm_call",
            body,
            attrs,
          ),
        ],
        totals: {},
      };
    }
    case "user": {
      const message = rec(record["message"]);
      const content = message?.["content"];
      const drafts: TranscriptDraft[] = [];
      if (typeof content === "string") {
        drafts.push(
          draft("oxagen:message", {
            prompt_digest: digestText(content),
            prompt_length: content.length,
            ...(s(record["promptSource"]) !== undefined
              ? { prompt_source: s(record["promptSource"]) }
              : {}),
            ...(record["origin"] !== undefined
              ? { prompt_origin: record["origin"] }
              : {}),
            ...(b(record["isMeta"]) !== undefined
              ? { is_meta: b(record["isMeta"]) }
              : {}),
            ...(b(record["isSidechain"]) !== undefined
              ? { is_sidechain: b(record["isSidechain"]) }
              : {}),
            ...(s(record["interruptedMessageId"]) !== undefined
              ? { interrupted_message_id: s(record["interruptedMessageId"]) }
              : {}),
            message_uuid: s(record["uuid"]),
          }),
        );
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const item = rec(block);
          if (s(item?.["type"]) !== "tool_result") continue;
          const toolUseResult = record["toolUseResult"];
          drafts.push(
            draft("tool_call", {
              ...(s(item?.["tool_use_id"]) !== undefined
                ? { tool_use_id: s(item?.["tool_use_id"]) }
                : {}),
              tool_status: b(item?.["is_error"]) === true ? "error" : "ok",
              ...(toolUseResult !== undefined
                ? { tool_output_digest: digestJcs(toolUseResult as JsonValue) }
                : {}),
              ...(s(record["toolDenialKind"]) !== undefined
                ? { tool_denial_kind: s(record["toolDenialKind"]) }
                : {}),
              ...(s(record["sourceToolUseID"]) !== undefined
                ? { parent_tool_use_id: s(record["sourceToolUseID"]) }
                : {}),
            }),
          );
        }
      }
      const totals: Partial<TranscriptTotals> = {};
      if (s(record["permissionMode"]) !== undefined)
        totals.permission_mode = s(record["permissionMode"]);
      return { drafts, totals };
    }
    case "system": {
      const subtype = s(record["subtype"]);
      if (subtype === "turn_duration") {
        return {
          drafts: [
            draft(
              "oxagen:message",
              {
                ...(n(record["durationMs"]) !== undefined
                  ? { turn_duration_ms: n(record["durationMs"]) }
                  : {}),
                ...(n(record["messageCount"]) !== undefined
                  ? { turn_message_count: n(record["messageCount"]) }
                  : {}),
              },
              { "transcript.subtype": subtype },
            ),
          ],
          totals: {},
        };
      }
      if (subtype === "stop_hook_summary") {
        return {
          drafts: [
            draft(
              "oxagen:hook_health",
              {
                hook_name: "Stop",
                ...(n(record["hookCount"]) !== undefined
                  ? { hook_count: n(record["hookCount"]) }
                  : {}),
                ...(b(record["preventedContinuation"]) !== undefined
                  ? {
                      hook_prevented_continuation: b(
                        record["preventedContinuation"],
                      ),
                    }
                  : {}),
              },
              { "transcript.subtype": subtype },
            ),
          ],
          totals: {},
        };
      }
      if (subtype === "api_retry") {
        return {
          drafts: [
            draft("oxagen:api_retry", {
              ...(n(record["attempt"]) !== undefined
                ? { api_retry_attempt: n(record["attempt"]) }
                : {}),
              ...(n(record["max_retries"]) !== undefined
                ? { api_retry_max: n(record["max_retries"]) }
                : {}),
              ...(n(record["retry_delay_ms"]) !== undefined
                ? { api_retry_delay_ms: n(record["retry_delay_ms"]) }
                : {}),
              ...(b(record["no_response"]) !== undefined
                ? { api_retry_no_response: b(record["no_response"]) }
                : {}),
              ...(n(record["error_status"]) !== undefined
                ? { api_status_code: n(record["error_status"]) }
                : {}),
            }),
          ],
          totals: {},
        };
      }
      return { drafts: [], totals: {} };
    }
    case "permission-mode":
      return {
        drafts: [
          draft("oxagen:permission_mode_change", {
            ...(s(record["permissionMode"]) !== undefined
              ? { permission_mode_to: s(record["permissionMode"]) }
              : {}),
          }),
        ],
        totals: {
          ...(s(record["permissionMode"]) !== undefined
            ? { permission_mode: s(record["permissionMode"]) }
            : {}),
        },
      };
    case "worktree-state": {
      const wt = rec(record["worktreeSession"]);
      return {
        drafts: [
          {
            ...draft("oxagen:worktree", { worktree_reason: "worktree-state" }),
            context: {
              ...(s(wt?.["worktreePath"]) !== undefined
                ? { worktree_path: s(wt?.["worktreePath"]) }
                : {}),
              ...(s(wt?.["worktreeBranch"]) !== undefined
                ? { worktree_branch: s(wt?.["worktreeBranch"]) }
                : {}),
            },
          },
        ],
        totals: {},
      };
    }
    case "relocated":
      return {
        drafts: [
          draft("oxagen:cwd_change", {
            ...(s(record["relocatedCwd"]) !== undefined
              ? { cwd_new: s(record["relocatedCwd"]) }
              : {}),
          }),
        ],
        totals: {},
      };
    case "queue-operation":
      return {
        drafts: [
          draft("oxagen:queue", {
            ...(s(record["operation"]) !== undefined
              ? { queue_operation: s(record["operation"]) }
              : {}),
            ...(s(record["content"]) !== undefined
              ? {
                  prompt_digest: digestText(s(record["content"]) ?? ""),
                  prompt_length: (s(record["content"]) ?? "").length,
                }
              : {}),
          }),
        ],
        totals: {},
      };
    case "cost-state": {
      const totals: Partial<TranscriptTotals> = {};
      const cost = record["totalCostUSD"];
      if (typeof cost === "number")
        totals.total_cost_usd_micros = Math.round(cost * 1_000_000);
      if (n(record["totalAPIDuration"]) !== undefined)
        totals.api_duration_ms = n(record["totalAPIDuration"]);
      if (n(record["totalAPIDurationWithoutRetries"]) !== undefined)
        totals.api_duration_without_retries_ms = n(
          record["totalAPIDurationWithoutRetries"],
        );
      if (n(record["totalToolDuration"]) !== undefined)
        totals.tool_duration_ms_total = n(record["totalToolDuration"]);
      if (n(record["totalDuration"]) !== undefined)
        totals.duration_ms = n(record["totalDuration"]);
      if (n(record["totalLinesAdded"]) !== undefined)
        totals.lines_added = n(record["totalLinesAdded"]);
      if (n(record["totalLinesRemoved"]) !== undefined)
        totals.lines_removed = n(record["totalLinesRemoved"]);
      if (b(record["hasUnknownModelCost"]) !== undefined)
        totals.has_unknown_model_cost = b(record["hasUnknownModelCost"]);
      if (rec(record["modelUsage"]) !== undefined)
        totals.models_used = rec(record["modelUsage"]);
      return { drafts: [], totals };
    }
    case "ai-title":
      return {
        drafts: [],
        totals: {
          ...(s(record["aiTitle"]) !== undefined
            ? { session_title: s(record["aiTitle"]) }
            : {}),
        },
      };
    default:
      return { drafts: [], totals: {} };
  }
}
