/**
 * Claude Code's OpenTelemetry export (OTLP/HTTP JSON) to Tacho events.
 * Logs carry the model-call, decision, prompt, and health events; spans add
 * time-to-first-token, stop reasons, and the trace identity; metrics carry
 * session-level counters that the recorder folds into totals.
 *
 * Every attribute is either promoted to a typed member or kept verbatim in
 * `attrs`, so a new upstream attribute is captured the day it appears.
 */
import { digestJcs, type JsonValue } from "../digest";
import type { TachoKind } from "../envelope";
import { fromUnixNano } from "../timestamp";
import { digestText } from "./context";

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
}
interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}
interface OtlpLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityText?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
}
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpKeyValue[];
  status?: { code?: number; message?: string };
}
interface OtlpDataPoint {
  attributes?: OtlpKeyValue[];
  asInt?: string | number;
  asDouble?: number;
  timeUnixNano?: string;
}
interface OtlpMetric {
  name: string;
  unit?: string;
  sum?: { dataPoints?: OtlpDataPoint[] };
  gauge?: { dataPoints?: OtlpDataPoint[] };
  histogram?: { dataPoints?: OtlpDataPoint[] };
}
interface OtlpResource {
  attributes?: OtlpKeyValue[];
}
export interface OtlpPayload {
  resourceLogs?: Array<{
    resource?: OtlpResource;
    scopeLogs?: Array<{
      scope?: { name?: string; version?: string };
      logRecords?: OtlpLogRecord[];
    }>;
  }>;
  resourceSpans?: Array<{
    resource?: OtlpResource;
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
  resourceMetrics?: Array<{
    resource?: OtlpResource;
    scopeMetrics?: Array<{ metrics?: OtlpMetric[] }>;
  }>;
}

type Attrs = Record<
  string,
  string | number | boolean | unknown[] | Record<string, unknown>
>;

function anyValue(
  value: OtlpAnyValue | undefined,
): string | number | boolean | unknown[] | Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined)
    return typeof value.intValue === "string"
      ? Number(value.intValue)
      : value.intValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue !== undefined)
    return (value.arrayValue.values ?? []).map((v) => anyValue(v));
  if (value.kvlistValue !== undefined) return attrsOf(value.kvlistValue.values);
  return undefined;
}

export function attrsOf(list: OtlpKeyValue[] | undefined): Attrs {
  const out: Attrs = {};
  for (const item of list ?? []) {
    const value = anyValue(item.value);
    if (value !== undefined) {
      out[item.key] = value;
    }
  }
  return out;
}

function s(attrs: Attrs, key: string): string | undefined {
  const value = attrs[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === "string"
    ? value.length > 0
      ? value
      : undefined
    : String(value);
}

function n(attrs: Attrs, key: string): number | undefined {
  const value = attrs[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.round(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return parsed >= 0 ? Math.round(parsed) : undefined;
  }
  return undefined;
}

function b(attrs: Attrs, key: string): boolean | undefined {
  const value = attrs[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function stringify(attrs: Attrs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

/** Standard attributes every Claude Code record carries (data-model 2.2, 2.5). */
export interface OtelStandard {
  session_id?: string;
  prompt_id?: string;
  harness_event_sequence?: number;
  anthropic: {
    user_id_hash?: string;
    user_email?: string;
    account_uuid?: string;
    account_id?: string;
    org_uuid?: string;
  };
  context: {
    app_version?: string;
    terminal_type?: string;
    entrypoint?: string;
    query_source?: string;
    effort?: string;
    model?: string;
  };
  resource: {
    os_type?: string;
    os_version?: string;
    host_arch?: string;
    harness_version?: string;
  };
  agent_name?: string;
  agent_id?: string;
}

function standard(attrs: Attrs, resource: Attrs): OtelStandard {
  const std: OtelStandard = {
    anthropic: {},
    context: {},
    resource: {},
  };
  const setIf = (
    target: Record<string, unknown>,
    key: string,
    value: unknown,
  ) => {
    if (value !== undefined) target[key] = value;
  };
  std.session_id = s(attrs, "session.id");
  std.prompt_id = s(attrs, "prompt.id");
  std.harness_event_sequence = n(attrs, "event.sequence");
  setIf(std.anthropic, "user_id_hash", s(attrs, "user.id"));
  setIf(std.anthropic, "user_email", s(attrs, "user.email"));
  setIf(std.anthropic, "account_uuid", s(attrs, "user.account_uuid"));
  setIf(std.anthropic, "account_id", s(attrs, "user.account_id"));
  setIf(std.anthropic, "org_uuid", s(attrs, "organization.id"));
  setIf(std.context, "app_version", s(attrs, "app.version"));
  setIf(std.context, "terminal_type", s(attrs, "terminal.type"));
  setIf(std.context, "entrypoint", s(attrs, "app.entrypoint"));
  setIf(std.context, "query_source", s(attrs, "query_source"));
  setIf(std.context, "effort", s(attrs, "effort"));
  setIf(std.context, "model", s(attrs, "model"));
  setIf(std.resource, "os_type", s(resource, "os.type"));
  setIf(std.resource, "os_version", s(resource, "os.version"));
  setIf(std.resource, "host_arch", s(resource, "host.arch"));
  setIf(std.resource, "harness_version", s(resource, "service.version"));
  std.agent_name = s(attrs, "agent.name");
  std.agent_id = s(attrs, "agent_id");
  return std;
}

export interface OtelDraft {
  kind: TachoKind;
  source: "otel_log" | "otel_span";
  otel_event_name: string;
  ts: string;
  body: Record<string, unknown>;
  attrs: Record<string, string>;
  standard: OtelStandard;
  span?: { trace_id?: string; span_id?: string; parent_span_id?: string };
  content_digest?: `sha256:${string}`;
  raw_source_digest: `sha256:${string}`;
}

export interface OtelMetricPoint {
  name: string;
  unit?: string;
  value: number;
  ts?: string;
  attrs: Attrs;
  standard: OtelStandard;
}

const LOG_PROMOTED = new Set([
  "session.id",
  "prompt.id",
  "event.sequence",
  "event.name",
  "event.timestamp",
  "user.id",
  "user.email",
  "user.account_uuid",
  "user.account_id",
  "organization.id",
  "app.version",
  "app.entrypoint",
  "terminal.type",
  "query_source",
  "effort",
  "model",
  "agent.name",
  "agent_id",
]);

function attribution(attrs: Attrs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Array<[string, string]> = [
    ["skill.name", "skill_name"],
    ["plugin.name", "plugin_name"],
    ["marketplace.name", "marketplace_name"],
    ["mcp_server.name", "mcp_server_name"],
    ["mcp_tool.name", "mcp_tool_name"],
    ["plugin_id_hash", "plugin_id_hash"],
    ["workflow.run_id", "workflow_run_id"],
    ["workflow.name", "workflow_name"],
    ["request_id", "request_id"],
    ["client_request_id", "client_request_id"],
    ["message.uuid", "message_uuid"],
  ];
  for (const [from, to] of map) {
    const value = s(attrs, from);
    if (value !== undefined) out[to] = value;
  }
  const paths = attrs["workspace.host_paths"];
  if (Array.isArray(paths))
    out["workspace_host_paths"] = paths.map((p) => String(p));
  return out;
}

function modelBody(attrs: Attrs): Record<string, unknown> {
  const body: Record<string, unknown> = { ...attribution(attrs) };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) body[key] = value;
  };
  set("model", s(attrs, "model"));
  set("input_tokens", n(attrs, "input_tokens"));
  set("output_tokens", n(attrs, "output_tokens"));
  set("cache_read_tokens", n(attrs, "cache_read_tokens"));
  set("cache_creation_tokens", n(attrs, "cache_creation_tokens"));
  set(
    "cost_usd_micros",
    n(attrs, "cost_usd_micros") ??
      (attrs["cost_usd"] !== undefined
        ? Math.round(Number(attrs["cost_usd"]) * 1_000_000)
        : undefined),
  );
  set("api_duration_ms", n(attrs, "duration_ms"));
  set("speed", s(attrs, "speed"));
  set("attempt", n(attrs, "attempt"));
  set("api_status_code", n(attrs, "status_code"));
  set("ttft_ms", n(attrs, "ttft_ms"));
  set("stop_reason", s(attrs, "stop_reason"));
  set("llm_request_context", s(attrs, "llm_request.context"));
  const error = s(attrs, "error");
  if (error !== undefined) {
    set("api_error_class", error.split(/[:\n]/, 1)[0]?.slice(0, 128));
    set("api_error_message_digest", digestText(error));
  }
  return body;
}

function promotedKeysFor(
  body: Record<string, unknown>,
  attrs: Attrs,
  extra: string[],
): Record<string, string> {
  const promoted = new Set([...LOG_PROMOTED, ...extra]);
  const rest: Attrs = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!promoted.has(key)) rest[key] = value;
  }
  void body;
  return stringify(rest);
}

const MODEL_ATTR_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cost_usd",
  "cost_usd_micros",
  "duration_ms",
  "speed",
  "attempt",
  "status_code",
  "ttft_ms",
  "stop_reason",
  "llm_request.context",
  "error",
  "skill.name",
  "plugin.name",
  "marketplace.name",
  "mcp_server.name",
  "mcp_tool.name",
  "plugin_id_hash",
  "workflow.run_id",
  "workflow.name",
  "request_id",
  "client_request_id",
  "message.uuid",
  "workspace.host_paths",
];

function logDraft(
  record: OtlpLogRecord,
  resource: Attrs,
): OtelDraft | undefined {
  const attrs = attrsOf(record.attributes);
  const name = (
    record.body?.stringValue ??
    s(attrs, "event.name") ??
    ""
  ).replace(/^claude_code\./, "");
  if (name === "") return undefined;
  const ts =
    record.timeUnixNano !== undefined
      ? fromUnixNano(record.timeUnixNano)
      : (s(attrs, "event.timestamp") ?? new Date(0).toISOString());
  const std = standard(attrs, resource);
  const raw = digestJcs({
    body: record.body ?? null,
    attributes: attrs as JsonValue,
  } as JsonValue);
  const base = (
    kind: TachoKind,
    body: Record<string, unknown>,
    promoted: string[],
    contentDigest?: `sha256:${string}`,
  ): OtelDraft => ({
    kind,
    source: "otel_log",
    otel_event_name: name,
    ts,
    body,
    attrs: promotedKeysFor(body, attrs, promoted),
    standard: std,
    ...(record.traceId !== undefined || record.spanId !== undefined
      ? {
          span: {
            ...(record.traceId !== undefined
              ? { trace_id: record.traceId }
              : {}),
            ...(record.spanId !== undefined ? { span_id: record.spanId } : {}),
          },
        }
      : {}),
    ...(contentDigest !== undefined ? { content_digest: contentDigest } : {}),
    raw_source_digest: raw,
  });

  switch (name) {
    case "api_request":
      return base("llm_call", modelBody(attrs), MODEL_ATTR_KEYS);
    case "api_error":
      return base("error", modelBody(attrs), MODEL_ATTR_KEYS);
    case "api_refusal": {
      const body = modelBody(attrs);
      const set = (key: string, value: unknown) => {
        if (value !== undefined) body[key] = value;
      };
      set("refusal_category", s(attrs, "category"));
      set("refusal_has_category", b(attrs, "has_category"));
      set("refusal_has_explanation", b(attrs, "has_explanation"));
      set("server_fallback_hop", b(attrs, "server_fallback_hop"));
      return base("oxagen:api_refusal", body, [
        ...MODEL_ATTR_KEYS,
        "category",
        "has_category",
        "has_explanation",
        "server_fallback_hop",
      ]);
    }
    case "api_request_body":
    case "api_response_body": {
      const body: Record<string, unknown> = { ...attribution(attrs) };
      const text = s(attrs, "body");
      if (text !== undefined) body["api_error_message_digest"] = undefined;
      return base(
        "oxagen:message",
        {
          ...attribution(attrs),
          ...(s(attrs, "model") !== undefined
            ? { model: s(attrs, "model") }
            : {}),
        },
        [
          "body",
          "body_ref",
          "body_length",
          "body_truncated",
          ...MODEL_ATTR_KEYS,
        ],
        text !== undefined ? digestText(text) : undefined,
      );
    }
    case "user_prompt": {
      const prompt = s(attrs, "prompt");
      const body: Record<string, unknown> = { ...attribution(attrs) };
      const set = (key: string, value: unknown) => {
        if (value !== undefined) body[key] = value;
      };
      set("prompt_length", n(attrs, "prompt_length"));
      set("command_name", s(attrs, "command_name"));
      set("command_source", s(attrs, "command_source"));
      if (prompt !== undefined) set("prompt_digest", digestText(prompt));
      return base(
        "oxagen:message",
        body,
        [
          "prompt",
          "prompt_length",
          "command_name",
          "command_source",
          ...MODEL_ATTR_KEYS,
        ],
        prompt !== undefined ? digestText(prompt) : undefined,
      );
    }
    case "assistant_response": {
      const response = s(attrs, "response");
      const body: Record<string, unknown> = {
        ...attribution(attrs),
        ...(s(attrs, "model") !== undefined
          ? { model: s(attrs, "model") }
          : {}),
      };
      if (n(attrs, "response_length") !== undefined)
        body["response_length"] = n(attrs, "response_length");
      if (response !== undefined)
        body["response_digest"] = digestText(response);
      return base(
        "oxagen:message",
        body,
        ["response", "response_length", ...MODEL_ATTR_KEYS],
        response !== undefined ? digestText(response) : undefined,
      );
    }
    case "tool_decision": {
      const decision = s(attrs, "decision");
      const body: Record<string, unknown> = {
        ...(s(attrs, "tool_name") !== undefined
          ? { tool_name: s(attrs, "tool_name") }
          : {}),
        ...(s(attrs, "tool_use_id") !== undefined
          ? { tool_use_id: s(attrs, "tool_use_id") }
          : {}),
        ...(s(attrs, "tool_source") !== undefined
          ? { tool_source: s(attrs, "tool_source") }
          : {}),
        ...(decision === "accept" || decision === "reject"
          ? { tool_decision: decision }
          : {}),
        ...(s(attrs, "source") !== undefined
          ? { tool_decision_source: s(attrs, "source") }
          : {}),
        policy_decision: decision === "reject" ? "deny" : "allow",
        policy_source: "harness",
      };
      return base("policy_decision", body, [
        "tool_name",
        "tool_use_id",
        "tool_source",
        "decision",
        "source",
        "tool_parameters",
      ]);
    }
    case "tool_result": {
      const body: Record<string, unknown> = {
        ...(s(attrs, "tool_name") !== undefined
          ? { tool_name: s(attrs, "tool_name") }
          : {}),
        ...(s(attrs, "tool_use_id") !== undefined
          ? { tool_use_id: s(attrs, "tool_use_id") }
          : {}),
        tool_status: b(attrs, "success") === false ? "error" : "ok",
        ...(n(attrs, "duration_ms") !== undefined
          ? { tool_duration_ms: n(attrs, "duration_ms") }
          : {}),
        ...(n(attrs, "tool_input_size_bytes") !== undefined
          ? { tool_input_bytes: n(attrs, "tool_input_size_bytes") }
          : {}),
        ...(n(attrs, "tool_result_size_bytes") !== undefined
          ? { tool_output_bytes: n(attrs, "tool_result_size_bytes") }
          : {}),
        ...(s(attrs, "decision_source") !== undefined
          ? { tool_decision_source: s(attrs, "decision_source") }
          : {}),
        ...(s(attrs, "error_type") !== undefined
          ? { tool_error_class: s(attrs, "error_type") }
          : {}),
        ...(s(attrs, "error") !== undefined
          ? { tool_error_message_digest: digestText(s(attrs, "error") ?? "") }
          : {}),
      };
      return base("tool_call", body, [
        "tool_name",
        "tool_use_id",
        "success",
        "duration_ms",
        "tool_input_size_bytes",
        "tool_result_size_bytes",
        "decision_source",
        "error_type",
        "error",
        "tool_input",
        "tool_parameters",
        "mcp_server_scope",
      ]);
    }
    case "subagent_completed": {
      const body: Record<string, unknown> = {};
      const set = (key: string, value: unknown) => {
        if (value !== undefined) body[key] = value;
      };
      set("subagent_source", s(attrs, "agent.source"));
      set("subagent_is_async", b(attrs, "is_async"));
      set("subagent_total_tokens", n(attrs, "total_tokens"));
      set("subagent_tool_uses", n(attrs, "total_tool_uses"));
      set("subagent_duration_ms", n(attrs, "duration_ms"));
      set("subagent_model", s(attrs, "model"));
      set("subagent_final_model", s(attrs, "final_model"));
      set("subagent_model_swapped", b(attrs, "model_swapped"));
      set("tool_status", "ok");
      return base("subagent_stop", body, [
        "agent.source",
        "is_async",
        "is_built_in",
        "total_tokens",
        "total_tool_uses",
        "duration_ms",
        "final_model",
        "model_swapped",
        "agent_type",
      ]);
    }
    case "hook_registered":
    case "hook_execution_start":
    case "hook_execution_complete": {
      const body: Record<string, unknown> = {};
      const set = (key: string, value: unknown) => {
        if (value !== undefined) body[key] = value;
      };
      set("hook_name", s(attrs, "hook_name") ?? s(attrs, "hook_event"));
      set("hook_type", s(attrs, "hook_type"));
      set("hook_matcher", s(attrs, "hook_matcher"));
      set("hook_source", s(attrs, "hook_source"));
      set("hook_count", n(attrs, "num_hooks"));
      set("hook_success", n(attrs, "num_success"));
      set("hook_blocking", n(attrs, "num_blocking"));
      set("hook_nonblocking_error", n(attrs, "num_non_blocking_error"));
      set("hook_cancelled", n(attrs, "num_cancelled"));
      set("hook_total_duration_ms", n(attrs, "total_duration_ms"));
      set("hook_managed_only", b(attrs, "managed_only"));
      set("hook_safe_mode", b(attrs, "safe_mode"));
      return base("oxagen:hook_health", body, [
        "hook_name",
        "hook_event",
        "hook_type",
        "hook_matcher",
        "hook_source",
        "num_hooks",
        "num_success",
        "num_blocking",
        "num_non_blocking_error",
        "num_cancelled",
        "total_duration_ms",
        "managed_only",
        "safe_mode",
      ]);
    }
    case "mcp_server_connection": {
      const body: Record<string, unknown> = {};
      const set = (key: string, value: unknown) => {
        if (value !== undefined) body[key] = value;
      };
      set("mcp_server_name", s(attrs, "server_name"));
      set("mcp_server_scope", s(attrs, "server_scope"));
      set("mcp_transport", s(attrs, "transport_type"));
      set("mcp_status", s(attrs, "status"));
      set("mcp_error_code", s(attrs, "error_code"));
      set("mcp_is_plugin", b(attrs, "is_plugin"));
      set("mcp_connect_ms", n(attrs, "duration_ms"));
      set("plugin_id_hash", s(attrs, "plugin_id_hash"));
      set("plugin_name", s(attrs, "plugin.name"));
      return base("oxagen:mcp_connection", body, [
        "server_name",
        "server_scope",
        "transport_type",
        "status",
        "error_code",
        "is_plugin",
        "duration_ms",
        "error",
        "plugin_id_hash",
        "plugin.name",
      ]);
    }
    case "permission_mode_changed": {
      const body: Record<string, unknown> = {};
      const set = (key: string, value: unknown) => {
        if (value !== undefined) body[key] = value;
      };
      set("permission_mode_from", s(attrs, "from_mode"));
      set("permission_mode_to", s(attrs, "to_mode"));
      set("permission_mode_trigger", s(attrs, "trigger"));
      return base("oxagen:permission_mode_change", body, [
        "from_mode",
        "to_mode",
        "trigger",
      ]);
    }
    case "auth": {
      const body: Record<string, unknown> = {};
      const set = (key: string, value: unknown) => {
        if (value !== undefined) body[key] = value;
      };
      set("auth_action", s(attrs, "action"));
      set("auth_success", b(attrs, "success"));
      set("auth_method", s(attrs, "auth_method"));
      set("auth_error_category", s(attrs, "error_category"));
      set("auth_status_code", n(attrs, "status_code"));
      return base("oxagen:auth", body, [
        "action",
        "success",
        "auth_method",
        "error_category",
        "status_code",
      ]);
    }
    case "internal_error":
      return base(
        "error",
        {
          ...(s(attrs, "error_name") !== undefined
            ? { internal_error_name: s(attrs, "error_name") }
            : {}),
        },
        ["error_name"],
      );
    default:
      // Unknown upstream event: recorded with every attribute in attrs.
      return base(
        "oxagen:notification",
        { notification_type: `otel:${name}` },
        [],
      );
  }
}

function spanDraft(span: OtlpSpan, resource: Attrs): OtelDraft | undefined {
  const attrs = attrsOf(span.attributes);
  const name = span.name.replace(/^claude_code\./, "");
  const ts =
    span.endTimeUnixNano !== undefined
      ? fromUnixNano(span.endTimeUnixNano)
      : span.startTimeUnixNano !== undefined
        ? fromUnixNano(span.startTimeUnixNano)
        : new Date(0).toISOString();
  const std = standard(attrs, resource);
  const spanRef = {
    ...(span.traceId !== undefined ? { trace_id: span.traceId } : {}),
    ...(span.spanId !== undefined ? { span_id: span.spanId } : {}),
    ...(span.parentSpanId !== undefined
      ? { parent_span_id: span.parentSpanId }
      : {}),
  };
  const raw = digestJcs({
    name: span.name,
    attributes: attrs as JsonValue,
  } as JsonValue);
  const base = (
    kind: TachoKind,
    body: Record<string, unknown>,
    promoted: string[],
  ): OtelDraft => ({
    kind,
    source: "otel_span",
    otel_event_name: `span:${name}`,
    ts,
    body,
    attrs: promotedKeysFor(body, attrs, ["span.type", ...promoted]),
    standard: std,
    span: spanRef,
    raw_source_digest: raw,
  });
  switch (name) {
    case "llm_request":
      return base("llm_call", modelBody(attrs), [
        ...MODEL_ATTR_KEYS,
        "gen_ai.system",
        "gen_ai.request.model",
        "gen_ai.response.id",
        "gen_ai.response.finish_reasons",
        "success",
      ]);
    case "tool": {
      const body: Record<string, unknown> = {
        ...(s(attrs, "tool_name") !== undefined
          ? { tool_name: s(attrs, "tool_name") }
          : {}),
        ...(s(attrs, "tool_use_id") !== undefined
          ? { tool_use_id: s(attrs, "tool_use_id") }
          : {}),
        ...(n(attrs, "duration_ms") !== undefined
          ? { tool_duration_ms: n(attrs, "duration_ms") }
          : {}),
        ...(n(attrs, "result_tokens") !== undefined
          ? { tool_result_tokens: n(attrs, "result_tokens") }
          : {}),
        ...(s(attrs, "file_path") !== undefined
          ? { tool_target: s(attrs, "file_path") }
          : {}),
        ...(s(attrs, "full_command") !== undefined
          ? { tool_target: (s(attrs, "full_command") ?? "").slice(0, 512) }
          : {}),
        ...(s(attrs, "skill_name") !== undefined
          ? { attribution_skill: s(attrs, "skill_name") }
          : {}),
        tool_status: "ok",
      };
      return base("tool_call", body, [
        "tool_name",
        "tool_use_id",
        "gen_ai.tool.call.id",
        "duration_ms",
        "result_tokens",
        "file_path",
        "full_command",
        "skill_name",
        "subagent_type",
      ]);
    }
    case "tool.execution":
      return base(
        "tool_call",
        {
          ...(s(attrs, "tool_use_id") !== undefined
            ? { tool_use_id: s(attrs, "tool_use_id") }
            : {}),
          tool_status: b(attrs, "success") === false ? "error" : "ok",
          ...(n(attrs, "duration_ms") !== undefined
            ? { tool_duration_ms: n(attrs, "duration_ms") }
            : {}),
        },
        [
          "tool_use_id",
          "gen_ai.tool.call.id",
          "duration_ms",
          "success",
          "error",
        ],
      );
    case "tool.blocked_on_user":
      return base(
        "policy_decision",
        {
          ...(n(attrs, "duration_ms") !== undefined
            ? { tool_blocked_on_user_ms: n(attrs, "duration_ms") }
            : {}),
          ...(s(attrs, "decision") === "accept" ||
          s(attrs, "decision") === "reject"
            ? { tool_decision: s(attrs, "decision") }
            : {}),
          ...(s(attrs, "source") !== undefined &&
          s(attrs, "source") !== "unknown"
            ? { tool_decision_source: s(attrs, "source") }
            : {}),
          policy_decision: s(attrs, "decision") === "reject" ? "deny" : "allow",
          policy_source: "harness",
        },
        ["duration_ms", "decision", "source"],
      );
    case "interaction": {
      const prompt = s(attrs, "user_prompt");
      return base(
        "oxagen:message",
        {
          ...(prompt !== undefined
            ? { prompt_digest: digestText(prompt) }
            : {}),
          ...(n(attrs, "user_prompt_length") !== undefined
            ? { prompt_length: n(attrs, "user_prompt_length") }
            : {}),
          ...(n(attrs, "interaction.sequence") !== undefined
            ? { interaction_sequence: n(attrs, "interaction.sequence") }
            : {}),
          ...(n(attrs, "interaction.duration_ms") !== undefined
            ? { interaction_duration_ms: n(attrs, "interaction.duration_ms") }
            : {}),
        },
        [
          "user_prompt",
          "user_prompt_length",
          "interaction.sequence",
          "interaction.duration_ms",
        ],
      );
    }
    case "hook":
      return base(
        "oxagen:hook_health",
        {
          ...(s(attrs, "hook_name") !== undefined
            ? { hook_name: s(attrs, "hook_name") }
            : {}),
          ...(n(attrs, "duration_ms") !== undefined
            ? { hook_total_duration_ms: n(attrs, "duration_ms") }
            : {}),
        },
        ["hook_name", "duration_ms"],
      );
    default:
      return base(
        "oxagen:notification",
        { notification_type: `otel-span:${name}` },
        [],
      );
  }
}

export interface OtlpNormalized {
  drafts: OtelDraft[];
  metrics: OtelMetricPoint[];
}

/** Normalize one OTLP/HTTP JSON payload (logs, spans, or metrics). */
export function normalizeOtlp(payload: OtlpPayload): OtlpNormalized {
  const drafts: OtelDraft[] = [];
  const metrics: OtelMetricPoint[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    const resource = attrsOf(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const record of sl.logRecords ?? []) {
        const draft = logDraft(record, resource);
        if (draft) drafts.push(draft);
      }
    }
  }
  for (const rs of payload.resourceSpans ?? []) {
    const resource = attrsOf(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const draft = spanDraft(span, resource);
        if (draft) drafts.push(draft);
      }
    }
  }
  for (const rm of payload.resourceMetrics ?? []) {
    const resource = attrsOf(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        const points =
          metric.sum?.dataPoints ??
          metric.gauge?.dataPoints ??
          metric.histogram?.dataPoints ??
          [];
        for (const point of points) {
          const attrs = attrsOf(point.attributes);
          const value =
            point.asInt !== undefined
              ? Number(point.asInt)
              : point.asDouble !== undefined
                ? point.asDouble
                : Number.NaN;
          if (Number.isNaN(value)) continue;
          metrics.push({
            name: metric.name.replace(/^claude_code\./, ""),
            ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
            value,
            ...(point.timeUnixNano !== undefined
              ? { ts: fromUnixNano(point.timeUnixNano) }
              : {}),
            attrs,
            standard: standard(attrs, resource),
          });
        }
      }
    }
  }
  return { drafts, metrics };
}
