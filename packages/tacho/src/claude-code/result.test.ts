import { describe, expect, it } from "vitest";
import { inventoryFromInit, totalsFromResult } from "./result";

describe("headless result stream", () => {
  it("reads the inventory from the init record and nothing from other records", () => {
    expect(inventoryFromInit({ type: "result" })).toEqual({});
    expect(inventoryFromInit("nope")).toEqual({});
    const inventory = inventoryFromInit({
      type: "system",
      subtype: "init",
      session_id: "s",
      tools: ["Read", 3],
      mcp_servers: [{ name: "gh", status: "connected" }],
      agents: ["Explore"],
      skills: ["review"],
      slash_commands: ["doctor"],
      plugins: [],
      plugin_errors: [{ name: "x" }],
      mcp_server_errors: [],
      capabilities: ["msg_lifecycle_v1"],
      memory_paths: { auto: "/m" },
      analytics_disabled: false,
      product_feedback_disabled: true,
      fast_mode_state: "off",
      fast_mode_disabled_reason: "sdk_opt_in_required",
      model: "m",
      permissionMode: "bypassPermissions",
    });
    expect(inventory).toMatchObject({
      tools_available: ["Read"],
      agents_available: ["Explore"],
      plugin_errors: [{ name: "x" }],
      product_feedback_disabled: true,
      model: "m",
      permission_mode: "bypassPermissions",
      session_id: "s",
    });
  });

  it("reads totals and the per-model breakdown from the result record", () => {
    expect(totalsFromResult({ type: "system" })).toEqual({ models: [] });
    expect(totalsFromResult(null)).toEqual({ models: [] });
    const totals = totalsFromResult({
      type: "result",
      session_id: "s",
      total_cost_usd: 0.1,
      duration_ms: 500,
      num_turns: 2,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 4,
        },
        output_tokens_details: { thinking_tokens: 9 },
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
      },
      is_error: true,
      api_error_status: 400,
      terminal_reason: "api_error",
      fast_mode_state: "off",
      ttft_ms: 50,
      queued_turn_count: 1,
      subagent_stats: { spawned: 0 },
      permission_denials: [],
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          canonicalModel: "claude-haiku-4-5",
          provider: "firstParty",
          costBasis: "list",
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
          thinkingTokens: 9,
          webSearchRequests: 1,
          costUSD: 0.1,
        },
        bogus: null,
      },
    });
    expect(totals).toMatchObject({
      total_cost_usd_micros: 100_000,
      duration_ms: 500,
      num_turns: 2,
      total_thinking_tokens: 9,
      total_web_fetch_requests: 2,
      is_error: true,
      api_error_status: 400,
      terminal_reason: "api_error",
      session_outcome: "aborted",
      ttft_first_ms: 50,
      queued_turn_count: 1,
    });
    expect(totals.models).toEqual([
      {
        model: "claude-haiku-4-5-20251001",
        canonical_model: "claude-haiku-4-5",
        provider: "firstParty",
        cost_basis: "list",
        context_window: 200_000,
        max_output_tokens: 32_000,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 4,
        thinking_tokens: 9,
        web_search_requests: 1,
        cost_usd_micros: 100_000,
      },
    ]);
    expect(
      totalsFromResult({ type: "result", is_error: false }).session_outcome,
    ).toBe("completed");
  });
});
