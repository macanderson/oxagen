# ADR-017 — OpenTelemetry Distributed Tracing

**Status:** Accepted  
**Date:** 2026-06-26  
**Ticket:** OXA-1544  
**Authors:** Mac Anderson

---

## Context

Oxagen orchestrates multiple async services (Next.js app, Hono REST API, xmcp MCP server,
Inngest workers) and makes LLM calls, tool invocations, and DB queries on every request.
Without distributed tracing:
- Latency attribution across hops is opaque (ClickHouse token_usage gives cost but no request lineage).
- AI errors and slow spans are hard to isolate to the capability → handler → model → tool chain.
- SOC 2 CC7 (incident response) needs a clear evidence trail per request.

## Decision

Adopt **OpenTelemetry** as the vendor-neutral tracing layer, implemented in `@oxagen/telemetry`.

### SDK choice

| Package | Role |
|---|---|
| `@opentelemetry/api@1.9.1` | Public API surface — imported everywhere spans are created |
| `@opentelemetry/sdk-node@0.218.0` | `NodeSDK` bootstrap (wraps all SDK sub-packages) |
| `@opentelemetry/exporter-trace-otlp-http@0.218.0` | HTTP OTLP exporter; vendor-neutral |
| `@opentelemetry/sdk-trace-base@2.7.1` | `BatchSpanProcessor`, `ReadableSpan` type |
| `@opentelemetry/resources@2.7.1` | `resourceFromAttributes` (note: `Resource` is type-only in v2.x) |
| `@opentelemetry/semantic-conventions@1.41.1` | `ATTR_SERVICE_NAME`, `ATTR_SERVICE_VERSION` |

The API package is separated from the SDK so that library packages (`@oxagen/ai`,
`@oxagen/agent`, `packages/oxagen`) can create spans with `@opentelemetry/api` alone — they
receive a no-op tracer by default, and the real SDK is registered only in the app entrypoints.

### Tracing model

```
apps/app:instrumentation.ts → initTracer()
apps/api:bootstrap.ts      → initTracer()
apps/mcp:middleware.ts     → initTracer()

  kernel.invoke()             [capability.name, capability.surface, tenant.org_id, ...]
    └─ streamAgentReply()     [ai.model, ai.provider, ai.input_tokens, ...]
         └─ tool execution    [tool.name, tool.risk_level, tool.latency_ms, ...]
              └─ ClickHouse inserts receive trace_id + span_id
```

Each chokepoint creates a child span via `tracer.startActiveSpan()`. Context propagates
through async/await via Node.js's `AsyncLocalStorageContextManager`.

### PII safety — attribute allowlist

`ALLOWED_SPAN_ATTRIBUTES` in `packages/telemetry/src/tracer.ts` is a `ReadonlySet<string>`
of the only span attribute keys that may be set. Any key not in the set is silently dropped
by `setSpanAttrs()`. This prevents prompt text, user email, API keys, or any PII from leaking
into the trace backend regardless of how call-site code builds the attribute object.

### ClickHouse trace correlation

`token_usage`, `tool_invocations`, and `events` tables receive two new append columns:

```sql
trace_id  String DEFAULT ''
span_id   String DEFAULT ''
```

`insertTokenUsage`, `insertToolInvocation`, and `insertEvents` in `packages/telemetry/src/clickhouse.ts`
auto-stamp these from `currentTraceIds()` at insert time. This lets Grafana (or any compatible
tool) join trace spans to ClickHouse rows by `trace_id`.

### No-op / rollback model

**If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the SDK does not start.** All `@opentelemetry/api`
calls return no-ops. Hot-path overhead is zero. Rolling back is setting the env var to empty.

### Exporter endpoint

| Env var | Description |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Full URL of the OTLP HTTP collector (e.g. `https://otel.example.com/v1/traces`). Unset = no-op. |
| `OTEL_SERVICE_NAME` | Override service name in span resources (default: `oxagen`). |

These env vars follow the [OTEL specification](https://opentelemetry.io/docs/concepts/sdk-configuration/otlp-exporter-configuration/)
and are compatible with Jaeger, Grafana Tempo, Honeycomb, Lightstep, and any OTLP-compatible collector.

## Consequences

**Good:**
- Vendor-neutral: switch from Grafana Tempo to Honeycomb by changing one env var, no code change.
- Zero overhead when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (all production envs that haven't
  configured a collector yet run at full speed).
- ClickHouse `trace_id` / `span_id` columns enable cross-signal correlation (cost + latency in
  the same query, by trace).
- PII attribute allowlist is auditable and enforced at a single choke point.

**Trade-offs:**
- `@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-http` add ~1.5 MB to the
  server bundle. Acceptable for server-only entrypoints; never imported in Edge or browser.
- Head-based sampling only for now. Tail-based (sample on error or slow spans) can be layered
  on top without breaking the schema.

## Alternatives considered

1. **Datadog APM (`dd-trace`)** — vendor lock-in, costs, and the agent-sidecar model is
   incompatible with Vercel serverless. Rejected.
2. **Sentry Performance** — already used for error tracking; Sentry's OTEL bridge means we get
   Sentry trace correlation for free later when we configure the exporter.
3. **No tracing** — insufficient for SOC 2 CC7 and production incident response as the
   orchestration complexity grows.

## Migration path

1. Set `OTEL_EXPORTER_OTLP_ENDPOINT` in Vercel to point at a Grafana Tempo or Honeycomb
   instance.
2. Run `pnpm db:migrate` to apply `0015_otel_trace_ids.sql` to ClickHouse production.
3. Traces and correlated ClickHouse events will appear immediately.
