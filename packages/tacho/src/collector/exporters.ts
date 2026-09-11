/**
 * Session exports (spec section 6.4): the native `tacho/1.0` NDJSON, the
 * `contextgraph-trace` journal, and OTLP JSON that renders as one trace per
 * session in a stock OpenTelemetry collector with GenAI semantic conventions.
 */
import { createHash } from "node:crypto";
import type { TachoEvent } from "../envelope";
import { journalToNdjson } from "../trace/journal";
import { projectToTrace } from "../trace/project";

export type ExportFormat = "tacho" | "trace" | "otlp";

export function exportTachoNdjson(events: readonly TachoEvent[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function exportTraceNdjson(events: readonly TachoEvent[]): string {
  return journalToNdjson(projectToTrace(events));
}

interface OtlpAttr {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { boolValue: boolean }
    | { doubleValue: number };
}

function attr(key: string, value: unknown): OtlpAttr | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "string") return { key, value: { stringValue: value } };
  return { key, value: { stringValue: JSON.stringify(value) } };
}

function attrs(record: Record<string, unknown>, prefix = ""): OtlpAttr[] {
  const out: OtlpAttr[] = [];
  for (const [key, value] of Object.entries(record)) {
    const built = attr(`${prefix}${key}`, value);
    if (built) out.push(built);
  }
  return out;
}

function traceIdFor(sessionUuid: string): string {
  return sessionUuid.replace(/-/g, "").slice(0, 32);
}

function spanIdFor(sessionUuid: string, seq: number): string {
  return createHash("sha256")
    .update(`${sessionUuid}/${seq}`)
    .digest("hex")
    .slice(0, 16);
}

function nanos(ts: string): string {
  return `${Date.parse(ts)}000000`;
}

const SPAN_KINDS = new Set([
  "tool_call",
  "llm_call",
  "command",
  "network",
  "file_io",
]);

function spanName(event: TachoEvent): string {
  const body = event.body as Record<string, unknown>;
  if (event.kind === "llm_call")
    return `chat ${String(body["model"] ?? "model")}`;
  if (typeof body["tool_name"] === "string")
    return `execute_tool ${body["tool_name"]}`;
  return event.kind;
}

/** GenAI-flavoured attributes for a span, from the typed body. */
function genAiAttrs(event: TachoEvent): OtlpAttr[] {
  const body = event.body as Record<string, unknown>;
  const out: OtlpAttr[] = [];
  const push = (key: string, value: unknown) => {
    const built = attr(key, value);
    if (built) out.push(built);
  };
  if (event.kind === "llm_call") {
    push("gen_ai.operation.name", "chat");
    push("gen_ai.system", "anthropic");
    push("gen_ai.request.model", body["model"]);
    push("gen_ai.response.model", body["canonical_model"] ?? body["model"]);
    push("gen_ai.usage.input_tokens", body["input_tokens"]);
    push("gen_ai.usage.output_tokens", body["output_tokens"]);
    push("gen_ai.usage.cache_read_input_tokens", body["cache_read_tokens"]);
    push(
      "gen_ai.usage.cache_creation_input_tokens",
      body["cache_creation_tokens"],
    );
    push("gen_ai.response.finish_reasons", body["stop_reason"]);
  } else {
    push("gen_ai.operation.name", "execute_tool");
    push("gen_ai.tool.name", body["tool_name"]);
    push("gen_ai.tool.call.id", body["tool_use_id"]);
    push("gen_ai.tool.type", body["tool_source"]);
  }
  return out;
}

/** One `resourceSpans` + `resourceLogs` document: spans for calls, logs for everything. */
export function exportOtlpJson(events: readonly TachoEvent[]): string {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const first = ordered[0];
  const resource = {
    attributes: [
      ...attrs({
        "service.name": "tacho",
        "service.version": first?.agent.wrapper_version,
        "tacho.session_uuid": first?.session_uuid,
        "tacho.agent_key": first?.agent.agent_key,
        "tacho.harness": first?.agent.harness,
        "tacho.harness_version": first?.agent.harness_version,
        "tacho.host_enrollment_id": first?.agent.host_enrollment_id,
      }),
    ],
  };
  const scope = { name: "sh.oxagen.tacho", version: "1.0" };
  const spans: Array<Record<string, unknown>> = [];
  const logRecords: Array<Record<string, unknown>> = [];
  for (const event of ordered) {
    const traceId = traceIdFor(event.root_session_uuid);
    const spanId = spanIdFor(event.session_uuid, event.seq);
    const body = event.body as Record<string, unknown>;
    const common = [
      ...attrs({
        "tacho.kind": event.kind,
        "tacho.seq": event.seq,
        "tacho.hash": event.hash,
        "tacho.source": event.source,
        "tacho.fidelity": event.fidelity,
        "session.id": event.session_id,
        "tacho.turn_seq": event.turn?.turn_seq,
        "tacho.prompt_id": event.turn?.prompt_id,
      }),
    ];
    if (SPAN_KINDS.has(event.kind)) {
      const duration =
        typeof body["duration_ms"] === "number" ? body["duration_ms"] : 0;
      const end = Date.parse(event.ts);
      spans.push({
        traceId,
        spanId,
        parentSpanId: spanIdFor(event.session_uuid, 0),
        name: spanName(event),
        kind: event.kind === "llm_call" ? 3 : 1,
        startTimeUnixNano: `${end - duration}000000`,
        endTimeUnixNano: nanos(event.ts),
        attributes: [
          ...common,
          ...genAiAttrs(event),
          ...attrs(body, "tacho.body."),
        ],
        status: { code: body["tool_status"] === "error" ? 2 : 1 },
      });
    }
    logRecords.push({
      timeUnixNano: nanos(event.ts),
      severityNumber:
        event.kind.startsWith("oxagen:") || event.kind === "error" ? 13 : 9,
      severityText:
        event.kind.startsWith("oxagen:") || event.kind === "error"
          ? "WARN"
          : "INFO",
      body: { stringValue: event.kind },
      attributes: [
        ...common,
        ...attrs(body, "tacho.body."),
        ...attrs(event.attrs ?? {}),
      ],
      traceId,
      spanId,
    });
  }
  if (first !== undefined) {
    const last = ordered[ordered.length - 1] as TachoEvent;
    spans.unshift({
      traceId: traceIdFor(first.root_session_uuid),
      spanId: spanIdFor(first.session_uuid, 0),
      name: `session ${first.agent.harness}`,
      kind: 1,
      startTimeUnixNano: nanos(first.ts),
      endTimeUnixNano: nanos(last.ts),
      attributes: [
        ...attrs({
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": first.agent.agent_key,
          "gen_ai.conversation.id": first.session_id,
        }),
      ],
      status: { code: 1 },
    });
  }
  return `${JSON.stringify(
    {
      resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }],
      resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords }] }],
    },
    null,
    2,
  )}\n`;
}

export function exportSession(
  events: readonly TachoEvent[],
  format: ExportFormat,
): string {
  switch (format) {
    case "tacho":
      return exportTachoNdjson(events);
    case "trace":
      return exportTraceNdjson(events);
    case "otlp":
      return exportOtlpJson(events);
    default:
      throw new Error(`unknown export format ${String(format)}`);
  }
}
