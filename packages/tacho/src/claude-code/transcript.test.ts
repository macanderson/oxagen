import { describe, expect, it } from "vitest";
import { normalizeTranscriptLine } from "./transcript";

const AT = "2026-09-08T10:00:00.000Z";
const line = (record: Record<string, unknown>) =>
  normalizeTranscriptLine(JSON.stringify(record), AT);

describe("transcript normalization", () => {
  it("ignores blank, malformed, and non-object lines", () => {
    expect(normalizeTranscriptLine("", AT)).toEqual({ drafts: [], totals: {} });
    expect(normalizeTranscriptLine("not json", AT)).toEqual({
      drafts: [],
      totals: {},
    });
    expect(normalizeTranscriptLine("[1]", AT)).toEqual({
      drafts: [],
      totals: {},
    });
    expect(line({ type: "unknown-record" })).toEqual({
      drafts: [],
      totals: {},
    });
  });

  it("extracts the usage facts only the transcript carries", () => {
    const { drafts } = line({
      type: "assistant",
      uuid: "u1",
      requestId: "req_1",
      timestamp: "2026-09-08T10:06:05.031Z",
      cwd: "/p",
      gitBranch: "main",
      entrypoint: "cli",
      sessionKind: "interactive",
      version: "2.1.263",
      effort: "high",
      apiBlockIndex: 3,
      truncatedAfterOutput: false,
      attributionSkill: "review",
      attributionMcpServer: "gh",
      attributionMcpTool: "list",
      message: {
        model: "m",
        id: "msg_1",
        stop_reason: "tool_use",
        stop_details: { kind: "x" },
        context_management: { applied: true },
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "toolu_9" },
          { type: "thinking" },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
          cache_creation: {
            ephemeral_5m_input_tokens: 1,
            ephemeral_1h_input_tokens: 3,
          },
          output_tokens_details: { thinking_tokens: 5 },
          server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
          service_tier: "standard",
          speed: "fast",
          inference_geo: "us",
          iterations: [{}, {}],
        },
      },
    });
    expect(drafts[0]).toMatchObject({
      kind: "llm_call",
      ts: "2026-09-08T10:06:05.031Z",
      body: {
        model: "m",
        message_id: "msg_1",
        request_id: "req_1",
        cache_creation_5m_tokens: 1,
        cache_creation_1h_tokens: 3,
        thinking_tokens: 5,
        web_search_requests: 1,
        iterations: 2,
        api_block_index: 3,
        skill_name: "review",
        mcp_server_name: "gh",
        speed: "fast",
      },
      attrs: {
        "transcript.content_block_types": '["text","tool_use","thinking"]',
        "transcript.tool_use_ids": '["toolu_9"]',
      },
      context: {
        cwd: "/p",
        git_branch: "main",
        entrypoint: "cli",
        session_kind: "interactive",
        app_version: "2.1.263",
        effort: "high",
      },
    });
    const errored = line({
      type: "assistant",
      isApiErrorMessage: true,
      error: "billing_error",
      message: { content: [] },
    });
    expect(errored.drafts[0]).toMatchObject({
      kind: "error",
      body: { api_error_class: "billing_error" },
    });
  });

  it("extracts user prompts, tool results, and permission modes", () => {
    const prompt = line({
      type: "user",
      uuid: "u",
      promptId: "p1",
      permissionMode: "acceptEdits",
      promptSource: "user",
      origin: { kind: "cli" },
      isMeta: false,
      isSidechain: false,
      message: { role: "user", content: "hello" },
    });
    expect(prompt.drafts[0]).toMatchObject({
      kind: "oxagen:message",
      body: {
        prompt_length: 5,
        prompt_source: "user",
        is_meta: false,
        message_uuid: "u",
      },
      turn: { prompt_id: "p1" },
      is_sidechain: false,
    });
    expect(prompt.totals).toEqual({ permission_mode: "acceptEdits" });

    const result = line({
      type: "user",
      toolUseResult: { stdout: "x" },
      toolDenialKind: "user",
      sourceToolUseID: "toolu_parent",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", is_error: true },
          { type: "text" },
        ],
      },
    });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.body).toMatchObject({
      tool_use_id: "toolu_1",
      tool_status: "error",
      tool_denial_kind: "user",
      parent_tool_use_id: "toolu_parent",
    });
    expect(result.drafts[0]?.body).toHaveProperty("tool_output_digest");
  });

  it("extracts system records, mode changes, worktrees, queues, cost state, and titles", () => {
    expect(
      line({
        type: "system",
        subtype: "turn_duration",
        durationMs: 100,
        messageCount: 4,
      }).drafts[0]?.body,
    ).toEqual({ turn_duration_ms: 100, turn_message_count: 4 });
    expect(
      line({
        type: "system",
        subtype: "stop_hook_summary",
        hookCount: 1,
        preventedContinuation: true,
      }).drafts[0]?.body,
    ).toEqual({
      hook_name: "Stop",
      hook_count: 1,
      hook_prevented_continuation: true,
    });
    expect(
      line({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 500,
        no_response: true,
        error_status: 529,
      }).drafts[0],
    ).toMatchObject({
      kind: "oxagen:api_retry",
      body: {
        api_retry_attempt: 2,
        api_retry_max: 5,
        api_retry_delay_ms: 500,
        api_retry_no_response: true,
        api_status_code: 529,
      },
    });
    expect(line({ type: "system", subtype: "other" }).drafts).toEqual([]);
    expect(
      line({ type: "permission-mode", permissionMode: "plan" }),
    ).toMatchObject({
      drafts: [
        {
          kind: "oxagen:permission_mode_change",
          body: { permission_mode_to: "plan" },
        },
      ],
      totals: { permission_mode: "plan" },
    });
    expect(
      line({
        type: "worktree-state",
        worktreeSession: { worktreePath: "/wt", worktreeBranch: "feat" },
      }).drafts[0],
    ).toMatchObject({
      kind: "oxagen:worktree",
      context: { worktree_path: "/wt", worktree_branch: "feat" },
    });
    expect(
      line({ type: "relocated", relocatedCwd: "/new" }).drafts[0]?.body,
    ).toEqual({ cwd_new: "/new" });
    expect(
      line({ type: "queue-operation", operation: "enqueue", content: "task" })
        .drafts[0]?.body,
    ).toMatchObject({ queue_operation: "enqueue", prompt_length: 4 });
    expect(
      line({
        type: "cost-state",
        totalCostUSD: 1.5,
        totalAPIDuration: 10,
        totalAPIDurationWithoutRetries: 9,
        totalToolDuration: 3,
        totalDuration: 20,
        totalLinesAdded: 1,
        totalLinesRemoved: 2,
        hasUnknownModelCost: false,
        modelUsage: { m: {} },
      }).totals,
    ).toEqual({
      total_cost_usd_micros: 1_500_000,
      api_duration_ms: 10,
      api_duration_without_retries_ms: 9,
      tool_duration_ms_total: 3,
      duration_ms: 20,
      lines_added: 1,
      lines_removed: 2,
      has_unknown_model_cost: false,
      models_used: { m: {} },
    });
    expect(line({ type: "ai-title", aiTitle: "Probe" }).totals).toEqual({
      session_title: "Probe",
    });
    expect(line({ type: "ai-title", timestamp: "garbage" }).drafts).toEqual([]);
  });
});
