// tracer.test.ts
//
// Unit tests for @oxagen/telemetry tracer module.
//
// These tests verify:
// 1. No-op behaviour when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
// 2. PII attribute allowlist enforcement (setSpanAttrs / filteredAttrs).
// 3. currentTraceIds() returns empty strings when no span is active.
// 4. withSpan() runs the callback and returns its value.
// 5. withSpan() correctly marks spans ERROR on rejection.
// 6. trace_id/span_id propagation via currentTraceIds() inside active spans.
//
// Strategy: we set up a real in-memory OTEL provider using the lower-level
// BasicTracerProvider (from @opentelemetry/sdk-trace-base, a direct dep) and
// AsyncLocalStorageContextManager so span context propagates across awaits.
// The NodeSDK / NodeTracerProvider are NOT used in tests to avoid the heavy
// Node.js dependency chain that doesn't resolve cleanly in Vite's ESM transform.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter as InMemorySpanExporterForInit } from "@opentelemetry/sdk-trace-base";
import {
  currentTraceIds,
  withSpan,
  setSpanAttrs,
  getTracer,
  ALLOWED_SPAN_ATTRIBUTES,
  initTracer,
  shutdownTracer,
  parseOtlpHeaders,
  __resetTracerForTesting,
} from "./tracer";

// ── In-memory provider setup ──────────────────────────────────────────────────

let _provider: BasicTracerProvider | null = null;
let _exporter: InMemorySpanExporter | null = null;

function setupProvider(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  // OTEL SDK 2.x API: pass spanProcessors in constructor options.
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  // OTEL SDK 2.x: register globally via the API (no provider.register() method).
  trace.setGlobalTracerProvider(provider);

  // Set AsyncLocalStorage context manager so context propagates across async/await.
  const ctxMgr = new AsyncLocalStorageContextManager();
  ctxMgr.enable();
  context.setGlobalContextManager(ctxMgr);

  _provider = provider;
  _exporter = exporter;
  return exporter;
}

function teardownProvider(): void {
  _exporter?.reset();
  // Restore global noop provider
  trace.disable();
  context.disable();
  _provider = null;
  _exporter = null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("parseOtlpHeaders", () => {
  it("returns an empty object when unset", () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("")).toEqual({});
  });

  it("parses a single key=value pair", () => {
    expect(parseOtlpHeaders("authorization=Bearer abc")).toEqual({
      authorization: "Bearer abc",
    });
  });

  it("parses multiple comma-separated pairs and trims whitespace", () => {
    expect(parseOtlpHeaders("a=1, b=2 , c=3")).toEqual({
      a: "1",
      b: "2",
      c: "3",
    });
  });

  it("keeps '=' inside a value (only the first '=' splits)", () => {
    expect(parseOtlpHeaders("token=a=b=c")).toEqual({ token: "a=b=c" });
  });

  it("skips malformed pairs (no '=' or empty key)", () => {
    expect(parseOtlpHeaders("novalue,=orphan,ok=1")).toEqual({ ok: "1" });
  });
});

describe("initTracer", () => {
  beforeEach(() => {
    __resetTracerForTesting();
  });

  afterEach(async () => {
    __resetTracerForTesting();
  });

  it("is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      expect(() => initTracer()).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    }
  });

  it("is idempotent — calling twice has no side effect", () => {
    // No endpoint set → both calls are no-ops
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      expect(() => {
        initTracer();
        initTracer(); // second call must be a no-op (no throw)
      }).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    }
  });

  it("builds a real NodeSDK with an injected exporter when an endpoint is set", async () => {
    // Exercises the `overrideExporter ?? new OTLPTraceExporter(...)` branch
    // (line 119-126) by supplying a test exporter so the real OTLP HTTP
    // exporter is never constructed, while still driving initTracer() down
    // its "endpoint configured" path (NodeSDK + BatchSpanProcessor wiring).
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      "http://collector.example.com:4318";
    const testExporter = new InMemorySpanExporterForInit();
    try {
      expect(() => initTracer(testExporter)).not.toThrow();
      // Second call with an endpoint present must still be a no-op (idempotent).
      expect(() => initTracer(testExporter)).not.toThrow();
    } finally {
      await shutdownTracer();
      if (saved !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
      else delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    }
  });

  it("constructs a real OTLPTraceExporter when no override is supplied", async () => {
    // Exercises the `new OTLPTraceExporter(...)` arm of the ternary (line
    // 119-126) — no test exporter is passed, so initTracer must build the real
    // HTTP exporter itself. `.start()` only registers processors; it does not
    // make a network call, so this is safe to run without a live collector.
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      "http://collector.example.com:4318";
    try {
      expect(() => initTracer()).not.toThrow();
    } finally {
      await shutdownTracer();
      if (saved !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
      else delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    }
  });

  it("shutdownTracer() is a no-op when the SDK was never initialised", async () => {
    // _sdk is null after __resetTracerForTesting() in beforeEach — exercises
    // the `if (_sdk)` false branch (guards line 171-175) without throwing.
    await expect(shutdownTracer()).resolves.toBeUndefined();
  });
});

describe("currentTraceIds", () => {
  it("returns empty strings when no span is active (noop context)", () => {
    // Without a registered provider producing real spans, all active spans
    // are invalid noop spans and isSpanContextValid returns false.
    const { trace_id, span_id } = currentTraceIds();
    expect(trace_id).toBe("");
    expect(span_id).toBe("");
  });

  it("returns 32-char hex trace_id and 16-char hex span_id inside an active span", async () => {
    const exporter = setupProvider();
    try {
      const result = await getTracer("test").startActiveSpan(
        "test.ids",
        {},
        async (span) => {
          const ids = currentTraceIds();
          span.end();
          return ids;
        },
      );

      expect(result.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(result.span_id).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      teardownProvider();
    }
  });

  it("returns empty strings when called outside any span context", async () => {
    const exporter = setupProvider();
    try {
      // Start+end a span, then confirm no trace ids outside it
      await getTracer("test").startActiveSpan("finished", {}, async (span) => {
        span.end();
      });
      const { trace_id, span_id } = currentTraceIds();
      expect(trace_id).toBe("");
      expect(span_id).toBe("");
    } finally {
      teardownProvider();
    }
  });
});

describe("withSpan", () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = setupProvider();
  });

  afterEach(() => {
    teardownProvider();
  });

  it("executes the callback and returns its value", async () => {
    const result = await withSpan("test.value", {}, async () => 42);
    expect(result).toBe(42);
  });

  it("creates a finished span in the exporter", async () => {
    await withSpan(
      "my.operation",
      { "capability.name": "test.cap" },
      async () => {
        // work happens here
      },
    );
    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === "my.operation");
    expect(span).toBeDefined();
    // SpanStatusCode.OK === 1 in @opentelemetry/api
    expect(span?.status.code).toBe(1);
  });

  it("sets ERROR status and re-throws on rejection", async () => {
    await expect(
      withSpan("failing.op", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const spans = exporter.getFinishedSpans();
    const failedSpan = spans.find((s) => s.name === "failing.op");
    expect(failedSpan).toBeDefined();
    // SpanStatusCode.ERROR === 2 in @opentelemetry/api
    expect(failedSpan?.status.code).toBe(2);
    expect(failedSpan?.status.message).toBe("boom");
  });

  it("stringifies a non-Error rejection in the span status message", async () => {
    await expect(
      withSpan("failing.non-error", {}, async () => {
        // Intentionally a non-Error throw — exercises the `String(err)` fallback arm.
        throw "plain string failure";
      }),
    ).rejects.toBe("plain string failure");

    const spans = exporter.getFinishedSpans();
    const failedSpan = spans.find((s) => s.name === "failing.non-error");
    expect(failedSpan?.status.code).toBe(2);
    expect(failedSpan?.status.message).toBe("plain string failure");
  });

  it("filters out disallowed attributes from span (PII safety)", async () => {
    await withSpan(
      "pii.test",
      {
        "capability.name": "safe.cap", // IN allowlist → must appear
        "prompt.content": "secret user text", // NOT in allowlist → must NOT appear
        "user.email": "user@example.com", // NOT in allowlist → must NOT appear
      },
      async () => {},
    );

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === "pii.test");
    expect(span).toBeDefined();
    expect(span?.attributes["capability.name"]).toBe("safe.cap");
    expect(span?.attributes["prompt.content"]).toBeUndefined();
    expect(span?.attributes["user.email"]).toBeUndefined();
  });

  it("propagates the same trace_id to nested spans", async () => {
    const ids: string[] = [];

    await withSpan("outer", {}, async () => {
      ids.push(currentTraceIds().trace_id);
      await withSpan("inner", {}, async () => {
        ids.push(currentTraceIds().trace_id);
      });
    });

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe("");
    // Inner and outer share the same trace
    expect(ids[0]).toBe(ids[1]);
  });

  it("gives nested spans different span_ids", async () => {
    const spanIds: string[] = [];

    await withSpan("outer.span", {}, async () => {
      spanIds.push(currentTraceIds().span_id);
      await withSpan("inner.span", {}, async () => {
        spanIds.push(currentTraceIds().span_id);
      });
    });

    expect(spanIds).toHaveLength(2);
    expect(spanIds[0]).not.toBe("");
    expect(spanIds[1]).not.toBe("");
    // Each span has a unique span_id
    expect(spanIds[0]).not.toBe(spanIds[1]);
  });
});

describe("setSpanAttrs", () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = setupProvider();
  });

  afterEach(() => {
    teardownProvider();
  });

  it("only sets attributes that are in the allowlist", () => {
    const span = getTracer("test").startSpan("attr.test");
    setSpanAttrs(span, {
      "capability.name": "allowed", // IN allowlist
      "tool.name": "also-allowed", // IN allowlist
      "secret.key": "should-not-appear", // NOT in allowlist
      "user.password": "p@ssw0rd", // NOT in allowlist
    });
    span.end();

    const spans = exporter.getFinishedSpans();
    const s = spans.find((sp) => sp.name === "attr.test");
    expect(s?.attributes["capability.name"]).toBe("allowed");
    expect(s?.attributes["tool.name"]).toBe("also-allowed");
    expect(s?.attributes["secret.key"]).toBeUndefined();
    expect(s?.attributes["user.password"]).toBeUndefined();
  });

  it("ignores null and undefined attribute values", () => {
    const span = getTracer("test").startSpan("null.test");
    setSpanAttrs(span, {
      "capability.name": undefined,
      "tool.name": null as unknown as string,
    });
    span.end();

    const spans = exporter.getFinishedSpans();
    const s = spans.find((sp) => sp.name === "null.test");
    expect(s?.attributes["capability.name"]).toBeUndefined();
    expect(s?.attributes["tool.name"]).toBeUndefined();
  });
});

describe("ALLOWED_SPAN_ATTRIBUTES", () => {
  it("includes expected PII-safe keys", () => {
    expect(ALLOWED_SPAN_ATTRIBUTES.has("capability.name")).toBe(true);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("ai.model")).toBe(true);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("tool.name")).toBe(true);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("tenant.org_id")).toBe(true);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("request.id")).toBe(true);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("error.class")).toBe(true);
  });

  it("does not include dangerous PII keys", () => {
    expect(ALLOWED_SPAN_ATTRIBUTES.has("prompt.content")).toBe(false);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("user.email")).toBe(false);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("api.key")).toBe(false);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("secret")).toBe(false);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("password")).toBe(false);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("user.input")).toBe(false);
    expect(ALLOWED_SPAN_ATTRIBUTES.has("message.content")).toBe(false);
  });
});

describe("getTracer", () => {
  it("returns a tracer without throwing", () => {
    expect(() => getTracer()).not.toThrow();
    expect(() => getTracer("custom.scope")).not.toThrow();
  });

  it("returns an object with startSpan and startActiveSpan methods", () => {
    const tracer = getTracer("test");
    expect(typeof tracer.startSpan).toBe("function");
    expect(typeof tracer.startActiveSpan).toBe("function");
  });
});

describe("trace_id/span_id in insert payloads", () => {
  // Verify that currentTraceIds() returns values suitable for stamping into
  // ClickHouse insertTokenUsage / insertToolInvocation rows.

  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = setupProvider();
  });

  afterEach(() => {
    teardownProvider();
  });

  it("returns non-empty ids inside withSpan() — matches what insertTokenUsage stamps", async () => {
    const ids = await withSpan(
      "kernel.invoke",
      { "capability.name": "agent.chat" },
      async () => currentTraceIds(),
    );

    expect(ids.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("trace_id is consistent across insert calls within the same span", async () => {
    const collected: string[] = [];

    await withSpan("kernel.invoke", {}, async () => {
      // Simulate two ClickHouse insert calls within the same span
      collected.push(currentTraceIds().trace_id);
      await Promise.resolve(); // await boundary (simulates async insert)
      collected.push(currentTraceIds().trace_id);
    });

    expect(collected).toHaveLength(2);
    expect(collected[0]).not.toBe("");
    // Both inserts see the same trace_id
    expect(collected[0]).toBe(collected[1]);
  });

  it("span_id differs between parent and child spans", async () => {
    const spanIds: string[] = [];

    await withSpan("parent.span", {}, async () => {
      spanIds.push(currentTraceIds().span_id);
      await withSpan("child.span", {}, async () => {
        spanIds.push(currentTraceIds().span_id);
      });
    });

    // Two different spans → different span_ids even within same trace
    expect(spanIds[0]).not.toBe(spanIds[1]);
    expect(spanIds[0]).not.toBe("");
    expect(spanIds[1]).not.toBe("");
  });
});
