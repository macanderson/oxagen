import { describe, expect, it, vi } from "vitest";
import { attrsOf, normalizeOtlp } from "./otel";
import { SessionRecorder } from "./recorder";

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
    // Claude Code's own permission check is the harness's decision, not
    // Oxagen's, so it never lands as a `policy_decision`.
    expect(
      normalizeOtlp(
        log("tool_decision", {
          tool_name: "Bash",
          tool_use_id: "t",
          decision: "accept",
          source: "config",
        }),
      ).drafts[0]?.kind,
    ).toBe("harness_permission");
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
      "harness_permission",
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

  // -------------------------------------------------------------------------
  // The reserved namespace is not a place a submitter may write
  // -------------------------------------------------------------------------
  //
  // discussion_r4036718127 (P1). Verbatim passthrough is what makes `attrs`
  // worth having — a new upstream attribute is captured the day it appears —
  // and it was also the mechanism: anything that can submit OTLP for an
  // enrolled host could set `oxagen.enforcement_tier=gateway` on an ordinary
  // record, the daemon sealed it onto a chain that verifies, and the control
  // plane read the tier off it.
  //
  // `enforcement_tier` was the instance. The namespace is the class, so the
  // rule is about the namespace: `oxagen.*` is how a sealed record says what
  // the COLLECTOR did, and nothing arriving over OTLP writes into it.
  it("re-keys a submitted oxagen.* attribute as the claim it is", () => {
    const { drafts } = normalizeOtlp(
      log("api_request", {
        model: "m",
        duration_ms: 1,
        "oxagen.enforcement_tier": "gateway",
        "oxagen.connected_app": "not-an-app",
        custom_attr: "keep",
      }),
    );
    // Renamed, not dropped: an operator wants to see that something tried, and
    // a key that begins `client_claimed.` cannot be mistaken downstream for a
    // value the platform derived.
    expect(drafts[0]?.attrs).toEqual({
      "client_claimed.oxagen.enforcement_tier": "gateway",
      "client_claimed.oxagen.connected_app": "not-an-app",
      custom_attr: "keep",
    });
    expect(drafts[0]?.attrs).not.toHaveProperty("oxagen.enforcement_tier");
  });

  it("leaves every other attribute exactly where it was", () => {
    // The quarantine must not cost the passthrough the `attrs` bag is for.
    const { drafts } = normalizeOtlp(
      log("api_request", {
        model: "m",
        duration_ms: 1,
        "oxagenic.sounds_close": "kept",
        "vendor.oxagen.enforcement_tier": "kept",
        brand_new_upstream_attr: "kept",
      }),
    );
    expect(drafts[0]?.attrs).toEqual({
      "oxagenic.sounds_close": "kept",
      "vendor.oxagen.enforcement_tier": "kept",
      brand_new_upstream_attr: "kept",
    });
  });
});

describe("sealing an OTLP export", () => {
  function recorder() {
    return new SessionRecorder({
      context: {
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_test",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
          host_enrollment_id: "tch_test",
        },
        now: () => Date.parse("2026-09-08T10:07:00.000Z"),
      },
      harnessSessionId: "sess-otel",
      scope: "tch_test",
    });
  }

  /** One OTLP export carrying several log records, as Claude Code batches them. */
  function exportOf(...records: Array<[string, Record<string, unknown>]>) {
    return {
      resourceLogs: records.flatMap(
        ([name, attrs]) => log(name, attrs).resourceLogs,
      ),
    };
  }

  /** One OTLP metrics export carrying a single data point. */
  function metricExportOf(name: string, attrs: Record<string, unknown>) {
    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              kv("os.type", "linux"),
              kv("service.version", "2.1.263"),
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: `claude_code.${name}`,
                  sum: {
                    dataPoints: [
                      {
                        timeUnixNano: TS,
                        asInt: "1",
                        attributes: Object.entries(attrs).map(([k, v]) =>
                          kv(k, v),
                        ),
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it("seals a plugin MCP connection and keeps the model call exported with it", () => {
    // Claude Code 2.1.277 sends plugin attribution on its MCP connection
    // records. The strict body refused them, and the throw took the whole
    // export down, including the api_request that carried the tokens.
    const events = recorder().ingestOtlp(
      exportOf(
        [
          "mcp_server_connection",
          {
            server_name: "gh",
            status: "connected",
            is_plugin: true,
            plugin_id_hash: "abc",
            "plugin.name": "github",
          },
        ],
        [
          "api_request",
          {
            model: "claude-opus-5",
            input_tokens: 100,
            output_tokens: 50,
            request_id: "req_1",
          },
        ],
      ) as never,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "oxagen:mcp_connection",
      "llm_call",
    ]);
    expect(events[0]?.body).toMatchObject({
      plugin_name: "github",
      plugin_id_hash: "abc",
    });
    expect(events[1]?.body).toMatchObject({ input_tokens: 100 });
  });

  it("forgets a model call whose OTel row was refused, so its next sighting is counted", () => {
    const r = recorder();
    const apiRequest = exportOf([
      "api_request",
      {
        model: "claude-opus-5",
        input_tokens: 100,
        output_tokens: 50,
        request_id: "req_refused",
      },
    ]) as never;
    // The envelope refuses the first attempt at the row.
    const target = r as unknown as { seal: (...args: unknown[]) => unknown };
    const seal = vi.spyOn(target, "seal").mockImplementationOnce(() => {
      throw new Error("refused");
    });
    expect(r.ingestOtlp(apiRequest)).toEqual([]);
    expect(r.takeOtelRefusals()).toEqual(["llm_call: refused"]);
    seal.mockRestore();
    // Had the refused row registered the call, this would be dropped as a
    // repeat, or stamped a duplicate of a row the chain does not hold, and
    // the call's tokens would never count.
    const events = r.ingestOtlp(apiRequest);
    expect(events.map((e) => e.kind)).toEqual(["llm_call"]);
    expect(events[0]?.attrs["oxagen.llm_call_duplicate_of"]).toBeUndefined();
    expect(events[0]?.body).toMatchObject({ input_tokens: 100 });
  });

  it("rolls back a sticky standard field when the record that carried it is refused", () => {
    const r = recorder();
    // Past the envelope's 512-character limit, so the row is refused.
    const refused = exportOf([
      "api_request",
      {
        model: "claude-opus-5",
        input_tokens: 1,
        output_tokens: 1,
        request_id: "req_long_account",
        "user.account_uuid": "a".repeat(600),
      },
    ]) as never;
    expect(r.ingestOtlp(refused)).toEqual([]);
    expect(r.takeOtelRefusals()).toHaveLength(1);
    // A later record that omits the attribute must not inherit the refused
    // value, or it would be refused too.
    const events = r.ingestOtlp(
      exportOf([
        "api_request",
        {
          model: "claude-opus-5",
          input_tokens: 100,
          output_tokens: 50,
          request_id: "req_after",
        },
      ]) as never,
    );
    expect(r.takeOtelRefusals()).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["llm_call"]);
    expect(events[0]?.anthropic?.account_uuid).toBeUndefined();
  });

  it("keeps a body member its kind does not declare as an attribute instead of refusing the event", () => {
    const r = recorder();
    const event = r.sealCollectorEvent("oxagen:mcp_connection", {
      mcp_server_name: "gh",
      brand_new_member: "x",
    });
    expect(event.body).toEqual({ mcp_server_name: "gh" });
    expect(event.attrs["body.brand_new_member"]).toBe("x");
    // The chain stays dense: the next seal follows directly.
    const next = r.sealCollectorEvent("oxagen:hook_health", {});
    expect(next.seq).toBe(event.seq + 1);
  });

  describe("a refused record does not poison the recorder's sticky fields", () => {
    // Regression coverage for #3438: `sealOtelDraft` used to merge a record's
    // standard fields onto the recorder BEFORE `seal()` validated them, so a
    // refused `user.account_uuid` (over the envelope's 512-char limit) stuck
    // around and refused every later record that omitted it too.
    const overLongAccountUuid = "a".repeat(513);

    it("refuses only the one record in the same export, and seals the one after it", () => {
      const r = recorder();
      const events = r.ingestOtlp(
        exportOf(
          [
            "api_request",
            {
              model: "claude-opus-5",
              input_tokens: 100,
              output_tokens: 50,
              request_id: "req_bad",
              "user.account_uuid": overLongAccountUuid,
            },
          ],
          [
            "api_request",
            {
              model: "claude-opus-5",
              input_tokens: 200,
              output_tokens: 75,
              request_id: "req_good",
            },
          ],
        ) as never,
      );
      expect(r.takeOtelRefusals()).toEqual([
        expect.stringContaining("llm_call:"),
      ]);
      expect(events.map((e) => e.kind)).toEqual(["llm_call"]);
      expect(events[0]?.body).toMatchObject({ input_tokens: 200 });
      expect(events[0]?.anthropic?.account_uuid).toBeUndefined();
    });

    it("seals cleanly in a later, separate export after a refusal", () => {
      const r = recorder();
      const refusedExport = exportOf([
        "api_request",
        {
          model: "claude-opus-5",
          input_tokens: 100,
          output_tokens: 50,
          request_id: "req_bad",
          "user.account_uuid": overLongAccountUuid,
        },
      ]) as never;
      expect(r.ingestOtlp(refusedExport)).toEqual([]);
      expect(r.takeOtelRefusals()).toEqual([
        expect.stringContaining("llm_call:"),
      ]);

      const laterExport = exportOf([
        "api_request",
        {
          model: "claude-opus-5",
          input_tokens: 300,
          output_tokens: 90,
          request_id: "req_good",
        },
      ]) as never;
      const events = r.ingestOtlp(laterExport);
      expect(events.map((e) => e.kind)).toEqual(["llm_call"]);
      expect(events[0]?.body).toMatchObject({ input_tokens: 300 });
      expect(events[0]?.anthropic?.account_uuid).toBeUndefined();
      expect(r.takeOtelRefusals()).toEqual([]);
    });

    it("does not poison sticky state on a subagent child recorder either", () => {
      const r = recorder();
      const events = r.ingestOtlp(
        exportOf(
          [
            "api_request",
            {
              model: "claude-opus-5",
              input_tokens: 10,
              output_tokens: 5,
              request_id: "req_child_bad",
              agent_id: "sub-1",
              "user.account_uuid": overLongAccountUuid,
            },
          ],
          [
            "api_request",
            {
              model: "claude-opus-5",
              input_tokens: 20,
              output_tokens: 8,
              request_id: "req_child_good",
              agent_id: "sub-1",
            },
          ],
        ) as never,
      );
      const child = r.openChildren.get("sub-1");
      expect(child).toBeDefined();
      // `ingestOtlp`'s catch records the refusal on the recorder the export
      // was fed to, not the child chain the draft routed to.
      expect(r.takeOtelRefusals()).toEqual([
        expect.stringContaining("llm_call:"),
      ]);
      const llmEvent = events.find((e) => e.kind === "llm_call");
      expect(llmEvent?.body).toMatchObject({ input_tokens: 20 });
      expect(llmEvent?.anthropic?.account_uuid).toBeUndefined();
    });

    it("refuses, and does not push, a metric whose standard fields the envelope would refuse", () => {
      const r = recorder();
      r.ingestOtlp(
        metricExportOf("token.usage", {
          "user.account_uuid": overLongAccountUuid,
        }) as never,
      );
      expect(r.takeOtelRefusals()).toEqual([
        expect.stringContaining("metric:"),
      ]);
      expect(r.metrics).toEqual([]);

      // The next log record must seal cleanly, unpoisoned by the metric's
      // refused standard fields.
      const events = r.ingestOtlp(
        exportOf([
          "api_request",
          {
            model: "claude-opus-5",
            input_tokens: 42,
            output_tokens: 7,
            request_id: "req_after_metric",
          },
        ]) as never,
      );
      expect(events.map((e) => e.kind)).toEqual(["llm_call"]);
      expect(events[0]?.anthropic?.account_uuid).toBeUndefined();
    });

    it("refuses, and does not commit, a metric whose harness_version the envelope would refuse", () => {
      // A metric's `service.version` becomes the sticky `harnessVersion`.
      // `refusedStandardReason` originally checked only anthropic/context/
      // host, so an over-long version committed here and refused every
      // later log record that omitted its own `service.version`.
      const overLongVersion = "v".repeat(513);
      const r = recorder();
      r.ingestOtlp({
        resourceMetrics: [
          {
            resource: {
              attributes: [
                kv("os.type", "linux"),
                kv("service.version", overLongVersion),
              ],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "claude_code.token.usage",
                    sum: {
                      dataPoints: [
                        { timeUnixNano: TS, asInt: "1", attributes: [] },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      } as never);
      expect(r.takeOtelRefusals()).toEqual([
        expect.stringContaining("metric:"),
      ]);
      expect(r.metrics).toEqual([]);

      // A later log record whose resource carries no `service.version` at
      // all must not inherit the refused harness version.
      const events = r.ingestOtlp({
        resourceLogs: [
          {
            resource: { attributes: [kv("os.type", "linux")] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: TS,
                    body: { stringValue: "claude_code.api_request" },
                    attributes: [
                      kv("model", "claude-opus-5"),
                      kv("input_tokens", 42),
                      kv("output_tokens", 7),
                      kv("request_id", "req_after_bad_harness_version"),
                    ],
                    traceId: "t1",
                    spanId: "s1",
                  },
                ],
              },
            ],
          },
        ],
      } as never);
      expect(events.map((e) => e.kind)).toEqual(["llm_call"]);
      expect(events[0]?.agent.harness_version).not.toBe(overLongVersion);
    });

    it("does not poison sticky state when a same-source repeat carries an invalid standard field", () => {
      // The dedupe-drop branch (a repeat of an already-sealed call, same
      // source) has no `seal()` call guarding it either, so it must run its
      // computed standard update through the same validation before commit.
      const r = recorder();
      const first = r.ingestOtlp(
        exportOf([
          "api_request",
          {
            model: "claude-opus-5",
            input_tokens: 100,
            output_tokens: 50,
            request_id: "req_repeat",
          },
        ]) as never,
      );
      expect(first.map((e) => e.kind)).toEqual(["llm_call"]);

      const repeatWithBadField = exportOf([
        "api_request",
        {
          model: "claude-opus-5",
          input_tokens: 100,
          output_tokens: 50,
          request_id: "req_repeat",
          "user.account_uuid": overLongAccountUuid,
        },
      ]) as never;
      expect(r.ingestOtlp(repeatWithBadField)).toEqual([]);
      expect(r.takeOtelRefusals()).toEqual([
        expect.stringContaining("llm_call:"),
      ]);

      const events = r.ingestOtlp(
        exportOf([
          "api_request",
          {
            model: "claude-opus-5",
            input_tokens: 300,
            output_tokens: 90,
            request_id: "req_after_bad_repeat",
          },
        ]) as never,
      );
      expect(events.map((e) => e.kind)).toEqual(["llm_call"]);
      expect(events[0]?.anthropic?.account_uuid).toBeUndefined();
    });
  });
});
