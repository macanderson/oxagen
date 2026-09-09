/**
 * The `claude -p --output-format json` stream: the `system.init` record is
 * the session inventory (tools, MCP servers, agents, skills, plugins,
 * capabilities, output style, api key source), and the `result` record is
 * the authoritative totals for a headless run. Pure.
 */
import type { BodyOf } from "../envelope";

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
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

/** The genesis body plus the three facts that live outside it. */
export type InitInventory = Partial<BodyOf<"agent_start">> & {
  model?: string;
  permission_mode?: string;
  session_id?: string;
};

/** Inventory facts from a `system` / `init` record. */
export function inventoryFromInit(record: unknown): InitInventory {
  const init = rec(record);
  if (!init || s(init["type"]) !== "system" || s(init["subtype"]) !== "init") {
    return {};
  }
  const out: InitInventory = {};
  const set = <K extends keyof typeof out>(
    key: K,
    value: (typeof out)[K] | undefined,
  ) => {
    if (value !== undefined) out[key] = value;
  };
  set("tools_available", strings(init["tools"]));
  set("mcp_servers", init["mcp_servers"]);
  set("agents_available", strings(init["agents"]));
  set("skills_available", strings(init["skills"]));
  set("slash_commands", strings(init["slash_commands"]));
  set("plugins", init["plugins"]);
  set("plugin_errors", init["plugin_errors"]);
  set("mcp_server_errors", init["mcp_server_errors"]);
  set("harness_capabilities", strings(init["capabilities"]));
  set("memory_paths", init["memory_paths"]);
  set("analytics_disabled", b(init["analytics_disabled"]));
  set("product_feedback_disabled", b(init["product_feedback_disabled"]));
  set("fast_mode_state", s(init["fast_mode_state"]));
  set("fast_mode_disabled_reason", s(init["fast_mode_disabled_reason"]));
  set("model", s(init["model"]));
  set("permission_mode", s(init["permissionMode"]));
  set("session_id", s(init["session_id"]));
  return out;
}

export interface ResultTotals extends Partial<BodyOf<"agent_stop">> {
  session_id?: string;
  /** A prompt-group fact the result carries; the recorder records it as an attribute. */
  queued_turn_count?: number;
  models: Array<{
    model: string;
    canonical_model?: string;
    provider?: string;
    cost_basis?: string;
    context_window?: number;
    max_output_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    thinking_tokens?: number;
    web_search_requests?: number;
    cost_usd_micros?: number;
  }>;
}

/** Totals from a `result` record. Empty when the record is not a result. */
export function totalsFromResult(record: unknown): ResultTotals {
  const result = rec(record);
  const models: ResultTotals["models"] = [];
  if (!result || s(result["type"]) !== "result") {
    return { models };
  }
  const usage = rec(result["usage"]);
  const cacheCreation = rec(usage?.["cache_creation"]);
  const outputDetails = rec(usage?.["output_tokens_details"]);
  const serverTools = rec(usage?.["server_tool_use"]);
  const out: ResultTotals = { models };
  const set = <K extends keyof ResultTotals>(
    key: K,
    value: ResultTotals[K] | undefined,
  ) => {
    if (value !== undefined) out[key] = value;
  };
  set("session_id", s(result["session_id"]));
  const cost = result["total_cost_usd"];
  set(
    "total_cost_usd_micros",
    typeof cost === "number" ? Math.round(cost * 1_000_000) : undefined,
  );
  set("duration_ms", n(result["duration_ms"]));
  set("api_duration_without_retries_ms", undefined);
  set("num_turns", n(result["num_turns"]));
  set("total_input_tokens", n(usage?.["input_tokens"]));
  set("total_output_tokens", n(usage?.["output_tokens"]));
  set("total_cache_read_tokens", n(usage?.["cache_read_input_tokens"]));
  set("total_cache_creation_tokens", n(usage?.["cache_creation_input_tokens"]));
  set(
    "total_cache_creation_5m_tokens",
    n(cacheCreation?.["ephemeral_5m_input_tokens"]),
  );
  set(
    "total_cache_creation_1h_tokens",
    n(cacheCreation?.["ephemeral_1h_input_tokens"]),
  );
  set("total_thinking_tokens", n(outputDetails?.["thinking_tokens"]));
  set("total_web_search_requests", n(serverTools?.["web_search_requests"]));
  set("total_web_fetch_requests", n(serverTools?.["web_fetch_requests"]));
  set("is_error", b(result["is_error"]));
  set("api_error_status", n(result["api_error_status"]));
  set("terminal_reason", s(result["terminal_reason"]));
  set("fast_mode_state", s(result["fast_mode_state"]));
  set("ttft_first_ms", n(result["ttft_ms"]));
  set("queued_turn_count", n(result["queued_turn_count"]));
  set("subagent_stats", result["subagent_stats"]);
  set("permission_denials", result["permission_denials"]);
  set("models_used", result["modelUsage"]);
  set(
    "session_outcome",
    b(result["is_error"]) === true ? "aborted" : "completed",
  );
  const modelUsage = rec(result["modelUsage"]);
  for (const [model, raw] of Object.entries(modelUsage ?? {})) {
    const usageRecord = rec(raw);
    if (!usageRecord) continue;
    const modelCost = usageRecord["costUSD"];
    models.push({
      model,
      ...(s(usageRecord["canonicalModel"]) !== undefined
        ? { canonical_model: s(usageRecord["canonicalModel"]) }
        : {}),
      ...(s(usageRecord["provider"]) !== undefined
        ? { provider: s(usageRecord["provider"]) }
        : {}),
      ...(s(usageRecord["costBasis"]) !== undefined
        ? { cost_basis: s(usageRecord["costBasis"]) }
        : {}),
      ...(n(usageRecord["contextWindow"]) !== undefined
        ? { context_window: n(usageRecord["contextWindow"]) }
        : {}),
      ...(n(usageRecord["maxOutputTokens"]) !== undefined
        ? { max_output_tokens: n(usageRecord["maxOutputTokens"]) }
        : {}),
      ...(n(usageRecord["inputTokens"]) !== undefined
        ? { input_tokens: n(usageRecord["inputTokens"]) }
        : {}),
      ...(n(usageRecord["outputTokens"]) !== undefined
        ? { output_tokens: n(usageRecord["outputTokens"]) }
        : {}),
      ...(n(usageRecord["cacheReadInputTokens"]) !== undefined
        ? { cache_read_tokens: n(usageRecord["cacheReadInputTokens"]) }
        : {}),
      ...(n(usageRecord["cacheCreationInputTokens"]) !== undefined
        ? { cache_creation_tokens: n(usageRecord["cacheCreationInputTokens"]) }
        : {}),
      ...(n(usageRecord["thinkingTokens"]) !== undefined
        ? { thinking_tokens: n(usageRecord["thinkingTokens"]) }
        : {}),
      ...(n(usageRecord["webSearchRequests"]) !== undefined
        ? { web_search_requests: n(usageRecord["webSearchRequests"]) }
        : {}),
      ...(typeof modelCost === "number"
        ? { cost_usd_micros: Math.round(modelCost * 1_000_000) }
        : {}),
    });
  }
  return out;
}
