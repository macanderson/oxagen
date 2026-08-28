// error-reporting.test.ts
//
// Unit tests for the vendor-neutral error capture pipeline. The ClickHouse
// insert is mocked (no live CH in the unit suite) and global fetch is stubbed
// so the webhook branch is exercised without network I/O.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the ClickHouse insert boundary so captureError never touches a live
// client. The factory returns a spy we assert against.
const insertErrorEvents = vi.fn((_rows: unknown[]) => Promise.resolve());
vi.mock("./clickhouse", () => ({
  insertErrorEvents: (rows: unknown[]) => insertErrorEvents(rows),
}));

import {
  captureError,
  errorFingerprint,
  buildAlertPayload,
} from "./error-reporting";

const flush = () => new Promise((r) => setImmediate(r));

/** Extract the single row from the most recent insertErrorEvents call. */
function lastRow(): Record<string, unknown> {
  const call = insertErrorEvents.mock.calls.at(-1);
  if (!call) throw new Error("insertErrorEvents was not called");
  const rows = call[0] as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error("insertErrorEvents called with no rows");
  return row;
}

describe("errorFingerprint", () => {
  it("is a 32-char hex string", () => {
    expect(errorFingerprint("TypeError", "boom")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic for the same class + message", () => {
    expect(errorFingerprint("Error", "x")).toBe(errorFingerprint("Error", "x"));
  });

  it("groups messages that differ only by interpolated ids/numbers", () => {
    const a = errorFingerprint("Error", "user 12345 not found");
    const b = errorFingerprint("Error", "user 98765 not found");
    expect(a).toBe(b);
  });

  it("groups messages that differ only by a uuid", () => {
    const a = errorFingerprint(
      "Error",
      "node 913d6df1-0000-4000-8000-000000000001 missing",
    );
    const b = errorFingerprint(
      "Error",
      "node 00000000-1111-4222-8333-444444444444 missing",
    );
    expect(a).toBe(b);
  });

  it("distinguishes different error classes", () => {
    expect(errorFingerprint("TypeError", "x")).not.toBe(
      errorFingerprint("RangeError", "x"),
    );
  });
});

describe("buildAlertPayload", () => {
  it("produces a Slack-compatible text + blocks payload", () => {
    const payload = buildAlertPayload({
      severity: "error",
      source: "api",
      errorClass: "TypeError",
      message: "cannot read x",
      capability: "run_workflow",
      requestId: "req_1",
      fingerprint: "abc",
    });
    expect(payload.text).toContain("[api]");
    expect(payload.text).toContain("TypeError");
    expect(Array.isArray(payload.blocks)).toBe(true);
    // capability + request + fingerprint fields present when provided.
    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).toContain("run_workflow");
    expect(serialized).toContain("req_1");
    expect(serialized).toContain("abc");
  });

  it("uses a fatal icon for fatal severity", () => {
    const payload = buildAlertPayload({
      severity: "fatal",
      source: "app",
      errorClass: "Error",
      message: "down",
      capability: null,
      requestId: null,
      fingerprint: "f",
    });
    expect(payload.text.startsWith("🛑")).toBe(true);
  });

  it("uses a warn icon for warn severity", () => {
    const payload = buildAlertPayload({
      severity: "warn",
      source: "app",
      errorClass: "Error",
      message: "degraded",
      capability: null,
      requestId: null,
      fingerprint: "f",
    });
    expect(payload.text.startsWith("⚠️")).toBe(true);
  });
});

describe("captureError", () => {
  const originalWebhook = process.env.ALERT_WEBHOOK_URL;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    insertErrorEvents.mockClear();
    fetchSpy = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.ALERT_WEBHOOK_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = originalWebhook;
  });

  it("records an error row to ClickHouse", async () => {
    captureError({ error: new TypeError("boom"), source: "api" });
    expect(insertErrorEvents).toHaveBeenCalledTimes(1);
    const row = lastRow();
    expect(row.error_class).toBe("TypeError");
    expect(row.message).toBe("boom");
    expect(row.source).toBe("api");
    expect(row.severity).toBe("error");
    expect(row.error_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    await flush();
  });

  it("coerces null tenant scope to nil UUID sentinel via the row (null passed through)", async () => {
    captureError({ error: new Error("x"), source: "app" });
    const row = lastRow();
    // captureError passes null; insertErrorEvents (mocked) is where nil-UUID
    // coalescing lives — assert the null contract is honored here.
    expect(row.org_id).toBeNull();
    expect(row.workspace_id).toBeNull();
  });

  it("passes through tenant scope + capability + requestId when provided", () => {
    captureError({
      error: new Error("scoped"),
      source: "mcp",
      orgId: "org-1",
      workspaceId: "ws-1",
      capability: "get_ontology_neighbors",
      requestId: "req-9",
      severity: "fatal",
    });
    const row = lastRow();
    expect(row.org_id).toBe("org-1");
    expect(row.workspace_id).toBe("ws-1");
    expect(row.capability).toBe("get_ontology_neighbors");
    expect(row.request_id).toBe("req-9");
    expect(row.severity).toBe("fatal");
  });

  it("prefixes the message with context when supplied", () => {
    captureError({
      error: new Error("failed"),
      source: "inngest",
      context: "fn x",
    });
    const row = lastRow();
    expect(row.message).toBe("fn x: failed");
  });

  it("coerces non-Error thrown values", () => {
    captureError({ error: "string failure", source: "api" });
    const row = lastRow();
    expect(row.error_class).toBe("UnknownError");
    expect(row.message).toBe("string failure");
  });

  it("falls back to defaults for an Error with empty name/message and no stack", () => {
    // Exercises the falsy arm of each `||`/`??` in normalizeError's Error
    // branch: `error.name || "Error"`, `error.message || ""`, `error.stack ?? ""`.
    const bare = new Error("");
    bare.name = "";
    bare.stack = undefined;
    captureError({ error: bare, source: "api" });
    const row = lastRow();
    expect(row.error_class).toBe("Error");
    expect(row.message).toBe("");
    expect(row.stack).toBe("");
  });

  it("reads name/message/stack off a duck-typed error object", () => {
    const duckTyped = {
      name: "CustomLibError",
      message: "third-party failure",
      stack: "at thirdPartyLib.js:1",
    };
    captureError({ error: duckTyped, source: "api" });
    const row = lastRow();
    expect(row.error_class).toBe("CustomLibError");
    expect(row.message).toBe("third-party failure");
    expect(row.stack).toBe("at thirdPartyLib.js:1");
  });

  it("falls back to UnknownError/safeStringify/empty-stack for an object with no error-shaped fields", () => {
    const shapeless = { code: 500, detail: "unexpected" };
    captureError({ error: shapeless, source: "api" });
    const row = lastRow();
    expect(row.error_class).toBe("UnknownError");
    expect(row.message).toBe(JSON.stringify(shapeless));
    expect(row.stack).toBe("");
  });

  it("truncates very long messages", () => {
    captureError({ error: new Error("y".repeat(5000)), source: "api" });
    const row = lastRow();
    expect((row.message as string).length).toBeLessThan(5000);
    expect(row.message).toContain("[truncated]");
  });

  it("does NOT POST a webhook when ALERT_WEBHOOK_URL is unset", () => {
    captureError({ error: new Error("no-hook"), source: "api" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs a Slack-compatible webhook when ALERT_WEBHOOK_URL is set", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/abc";
    captureError({ error: new Error("alert-me"), source: "api" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/abc");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.text).toContain("alert-me");
    expect(body.blocks).toBeDefined();
    await flush();
  });

  it("never throws even when the ClickHouse insert rejects", async () => {
    insertErrorEvents.mockImplementationOnce(() =>
      Promise.reject(new Error("ch down")),
    );
    expect(() =>
      captureError({ error: new Error("z"), source: "api" }),
    ).not.toThrow();
    await flush();
  });

  it("never throws even when the webhook fetch rejects", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/abc";
    fetchSpy.mockImplementationOnce(() => Promise.reject(new Error("net")));
    expect(() =>
      captureError({ error: new Error("z"), source: "api" }),
    ).not.toThrow();
    await flush();
  });

  it("falls back to String(value) when the thrown value is undefined", () => {
    // normalizeError()'s final branch calls safeStringify(undefined);
    // JSON.stringify(undefined) returns `undefined` (not a JSON string),
    // exercising the `?? String(value)` fallback arm.
    captureError({ error: undefined, source: "api" });
    const row = lastRow();
    expect(row.error_class).toBe("UnknownError");
    expect(row.message).toBe("undefined");
  });

  it("logs a non-Error sink failure via String(err)", async () => {
    // logCaptureFailure's `err instanceof Error ? err.message : String(err)` —
    // reject the ClickHouse insert with a plain string, not an Error.
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    insertErrorEvents.mockImplementationOnce(() =>
      Promise.reject("ch-string-failure"),
    );
    captureError({ error: new Error("z"), source: "api" });
    await flush();
    const line = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("capture sink failed"));
    expect(line).toBeDefined();
    const parsed = JSON.parse((line ?? "").trim()) as { err: string };
    expect(parsed.err).toBe("ch-string-failure");
    writeSpy.mockRestore();
  });

  it("falls back to String(value) when a non-Error error object can't be JSON.stringify'd", () => {
    // A circular reference with no string `.message`/`.name` forces
    // normalizeError() into safeStringify(), which must swallow the
    // JSON.stringify throw and fall back to String(value).
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    captureError({ error: circular, source: "api" });
    const row = lastRow();
    expect(row.error_class).toBe("UnknownError");
    expect(row.message).toBe(String(circular));
  });

  it("never throws even when reading a property off the thrown value itself throws", () => {
    // A duck-typed error whose `.name` getter throws — exercises captureError's
    // own outer try/catch (the guard around normalizeError et al.), not just
    // the inner sink .catch()s.
    const poisoned: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "name") throw new Error("getter exploded");
          return undefined;
        },
      },
    );
    expect(() =>
      captureError({ error: poisoned, source: "api" }),
    ).not.toThrow();
    // The ClickHouse insert never happens — capture failed before building the row.
    expect(insertErrorEvents).not.toHaveBeenCalled();
  });

  it("swallows a failure in the last-resort logger itself", async () => {
    // logCaptureFailure's own JSON.stringify+stderr.write is wrapped in a
    // try/catch that does nothing on failure — simulate stderr.write throwing
    // when the ClickHouse insert sink already failed.
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => {
        throw new Error("stderr broken");
      });
    insertErrorEvents.mockImplementationOnce(() =>
      Promise.reject(new Error("ch down")),
    );
    expect(() =>
      captureError({ error: new Error("z"), source: "api" }),
    ).not.toThrow();
    await flush();
    writeSpy.mockRestore();
  });
});

describe("captureError execution correlation", () => {
  it("stamps executionId/stepId onto the row (coalesced at the insert boundary)", async () => {
    captureError({
      error: new Error("step blew up"),
      source: "runner",
      executionId: "22222222-2222-2222-2222-222222222222",
      stepId: "33333333-3333-3333-3333-333333333333",
    });
    await flush();
    const row = lastRow();
    expect(row.execution_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(row.step_id).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("passes null execution/step when the caller has no execution scope", async () => {
    captureError({ error: new Error("boot crash"), source: "api" });
    await flush();
    const row = lastRow();
    expect(row.execution_id).toBeNull();
    expect(row.step_id).toBeNull();
  });
});
