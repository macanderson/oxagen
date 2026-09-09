import { describe, expect, it } from "vitest";
import { attrsOf, normalizeOtlp } from "./otel";

const TS = "1788861970750000000";

function kv(key: string, value: unknown) {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (Number.isInteger(value))
    return { key, value: { intValue: String(value) } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  if (Array.isArray(value))
    return {
      key,
      value: {
        arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) },
      },
    };
  return {
    key,
    value: {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>).map(
          ([k, v]) => ({ key: k, value: { stringValue: String(v) } }),
        ),
      },
    },
  };
}

function log(name: string, attrs: Record<string, unknown>) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            kv("os.type", "linux"),
            kv("service.version", "2.1.263"),
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: TS,
                body: { stringValue: `claude_code.${name}` },
                attributes: Object.entries(attrs).map(([k, v]) => kv(k, v)),
                traceId: "t1",
                spanId: "s1",
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("OpenTelemetry normalization", () => {
  it("decodes every OTLP value shape", () => {
    expect(
      attrsOf([
        kv("s", "x"),
        kv("i", 3),
        kv("d", 1.5),
        kv("b", true),
        kv("a", ["p", "q"]),
        kv("m", { k: "v" }),
      ]),
    ).toEqual({
      s: "x",
      i: 3,
      d: 1.5,
      b: true,
      a: ["p", "q"],
      m: { k: "v" },
    });
    expect(attrsOf(undefined)).toEqual({});
  });

  it("maps the model-call family, keeping unpromoted attributes", () => {
    const { drafts } = normalizeOtlp(
      log("api_error", {
        model: "m",
        error: "overloaded: retry",
        status_code: 529,
        attempt: 2,
        duration_ms: 10,
        "skill.name": "review",
        "workspace.host_paths": ["/a"],
        custom_attr: "keep",
      }),
    );
    expect(drafts[0]).toMatchObject({
      kind: "error",
      source: "otel_log",
      body: {
        api_error_class: "overloaded",
        api_status_code: 529,
        attempt: 2,
        skill_name: "review",
        workspace_host_paths: ["/a"],
      },
      attrs: { custom_attr: "keep" },
      span: { trace_id: "t1", span_id: "s1" },
    });
    expect(drafts[0]?.standard.resource).toEqual({
      os_type: "linux",
      harness_version: "2.1.263",
    });

    const refusal = normalizeOtlp(
      log("api_refusal", {
        model: "m",
        category: "cyber",
        has_category: true,
        has_explanation: false,
        server_fallback_hop: "true",
      }),
    ).drafts[0];
    expect(refusal).toMatchObject({
      kind: "oxagen:api_refusal",
      body: {
        refusal_category: "cyber",
        refusal_has_category: true,
        refusal_has_explanation: false,
        server_fallback_hop: true,
      },
    });

    const cost = normalizeOtlp(
      log("api_request", { model: "m", cost_usd: 0.5, input_tokens: "12" }),
    ).drafts[0];
    expect(cost?.body).toMatchObject({
      cost_usd_micros: 500_000,
      input_tokens: 12,
    });

    const body = normalizeOtlp(
      log("api_request_body", { model: "m", body: "{}", body_length: 2 }),
    ).drafts[0];
    expect(body).toMatchObject({
      kind: "oxagen:message",
      content_digest: expect.stringMatching(/^sha256:/),
    });
  });

  it("maps prompts, responses, decisions, results, and health events", () => {
    expect(
      normalizeOtlp(
        log("user_prompt", {
          prompt: "hi",
          prompt_length: 2,
          command_name: "review",
          command_source: "custom",
        }),
      ).drafts[0]?.body,
    ).toMatchObject({
      prompt_length: 2,
      command_name: "review",
      command_source: "custom",
    });
    expect(
      normalizeOtlp(
        log("assistant_response", {
          response: "ok",
          response_length: 2,
          model: "m",
        }),
      ).drafts[0]?.body,
    ).toMatchObject({ response_length: 2, model: "m" });
    expect(
      normalizeOtlp(
        log("tool_decision", {
          tool_name: "Bash",
          tool_use_id: "t",
          decision: "reject",
          source: "user_reject",
          tool_source: "builtin",
        }),
      ).drafts[0]?.body,
    ).toMatchObject({
      policy_decision: "deny",
      tool_decision: "reject",
      tool_decision_source: "user_reject",
    });
    expect(
      normalizeOtlp(
        log("tool_result", {
          tool_name: "Bash",
          tool_use_id: "t",
          success: "false",
          error_type: "ShellError",
          error: "boom",
          decision_source: "config",
        }),
      ).drafts[0]?.body,
    ).toMatchObject({
      tool_status: "error",
      tool_error_class: "ShellError",
      tool_decision_source: "config",
    });
    expect(
      normalizeOtlp(
        log("permission_mode_changed", {
          from_mode: "default",
          to_mode: "plan",
          trigger: "shift_tab",
        }),
      ).drafts[0]?.body,
    ).toEqual({
      permission_mode_from: "default",
      permission_mode_to: "plan",
      permission_mode_trigger: "shift_tab",
    });
    expect(
      normalizeOtlp(
        log("auth", { action: "login", success: "true", auth_method: "oauth" }),
      ).drafts[0]?.body,
    ).toEqual({
      auth_action: "login",
      auth_success: true,
      auth_method: "oauth",
    });
    expect(
      normalizeOtlp(log("internal_error", { error_name: "TypeError" }))
        .drafts[0],
    ).toMatchObject({
      kind: "error",
      body: { internal_error_name: "TypeError" },
    });
    expect(
      normalizeOtlp(
        log("mcp_server_connection", {
          server_name: "gh",
          status: "connected",
          transport_type: "http",
          is_plugin: true,
          plugin_id_hash: "abc",
        }),
      ).drafts[0]?.body,
    ).toMatchObject({
      mcp_server_name: "gh",
      mcp_is_plugin: true,
      plugin_id_hash: "abc",
    });
    expect(
      normalizeOtlp(
        log("hook_registered", {
          hook_event: "PreToolUse",
          hook_type: "command",
          hook_matcher: "Bash",
          hook_source: "userSettings",
        }),
      ).drafts[0]?.body,
    ).toMatchObject({ hook_name: "PreToolUse", hook_matcher: "Bash" });
    expect(
      normalizeOtlp(
        log("subagent_completed", {
          agent_type: "Explore",
          "agent.source": "built-in",
          is_async: true,
          total_tokens: 5,
          model_swapped: false,
        }),
      ).drafts[0]?.body,
    ).toMatchObject({
      subagent_source: "built-in",
      subagent_is_async: true,
      subagent_total_tokens: 5,
    });
    expect(
      normalizeOtlp(log("brand_new_event", { anything: "x" })).drafts[0],
    ).toMatchObject({
      kind: "oxagen:notification",
      body: { notification_type: "otel:brand_new_event" },
      attrs: { anything: "x" },
    });
    expect(
      normalizeOtlp({
        resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [] }] }] }],
      }).drafts,
    ).toEqual([]);
  });

  it("maps spans and folds metrics into points", () => {
    const spans = normalizeOtlp({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  name: "claude_code.llm_request",
                  traceId: "t",
                  spanId: "a",
                  startTimeUnixNano: TS,
                  endTimeUnixNano: TS,
                  attributes: [
                    kv("model", "m"),
                    kv("ttft_ms", 7),
                    kv("stop_reason", "end_turn"),
                    kv("success", true),
                  ],
                },
                {
                  name: "claude_code.tool",
                  traceId: "t",
                  spanId: "b",
                  parentSpanId: "a",
                  endTimeUnixNano: TS,
                  attributes: [
                    kv("tool_name", "Bash"),
                    kv("tool_use_id", "u"),
                    kv("full_command", "ls"),
                    kv("result_tokens", 3),
                    kv("skill_name", "sk"),
                  ],
                },
                {
                  name: "claude_code.tool.execution",
                  startTimeUnixNano: TS,
                  attributes: [
                    kv("tool_use_id", "u"),
                    kv("success", false),
                    kv("duration_ms", 2),
                  ],
                },
                {
                  name: "claude_code.tool.blocked_on_user",
                  attributes: [
                    kv("duration_ms", 9),
                    kv("decision", "reject"),
                    kv("source", "user_reject"),
                  ],
                },
                {
                  name: "claude_code.interaction",
                  attributes: [
                    kv("user_prompt", "p"),
                    kv("user_prompt_length", 1),
                    kv("interaction.sequence", 1),
                    kv("interaction.duration_ms", 4),
                  ],
                },
                {
                  name: "claude_code.hook",
                  attributes: [kv("hook_name", "Stop"), kv("duration_ms", 1)],
                },
                { name: "claude_code.mystery", attributes: [] },
              ],
            },
          ],
        },
      ],
    });
    expect(spans.drafts.map((d) => d.kind)).toEqual([
      "llm_call",
      "tool_call",
      "tool_call",
      "policy_decision",
      "oxagen:message",
      "oxagen:hook_health",
      "oxagen:notification",
    ]);
    expect(spans.drafts[0]?.body).toMatchObject({
      ttft_ms: 7,
      stop_reason: "end_turn",
    });
    expect(spans.drafts[1]?.body).toMatchObject({
      tool_target: "ls",
      tool_result_tokens: 3,
      attribution_skill: "sk",
    });
    expect(spans.drafts[1]?.span).toEqual({
      trace_id: "t",
      span_id: "b",
      parent_span_id: "a",
    });
    expect(spans.drafts[2]?.body).toMatchObject({ tool_status: "error" });
    expect(spans.drafts[3]?.body).toMatchObject({
      policy_decision: "deny",
      tool_blocked_on_user_ms: 9,
    });
    expect(spans.drafts[4]?.body).toMatchObject({ interaction_sequence: 1 });

    const metrics = normalizeOtlp({
      resourceMetrics: [
        {
          resource: { attributes: [] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.cost.usage",
                  unit: "USD",
                  sum: {
                    dataPoints: [
                      {
                        asDouble: 0.25,
                        timeUnixNano: TS,
                        attributes: [kv("model", "m")],
                      },
                    ],
                  },
                },
                {
                  name: "claude_code.token.usage",
                  gauge: {
                    dataPoints: [
                      { asInt: "10", attributes: [kv("type", "input")] },
                    ],
                  },
                },
                {
                  name: "claude_code.active_time.total",
                  histogram: { dataPoints: [{ attributes: [] }] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(metrics.metrics).toHaveLength(2);
    expect(metrics.metrics[0]).toMatchObject({
      name: "cost.usage",
      unit: "USD",
      value: 0.25,
    });
    expect(metrics.metrics[1]).toMatchObject({
      name: "token.usage",
      value: 10,
      attrs: { type: "input" },
    });
  });
});
