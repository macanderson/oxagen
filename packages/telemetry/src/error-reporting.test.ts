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
      capability: "workflow.run",
      requestId: "req_1",
      fingerprint: "abc",
    });
    expect(payload.text).toContain("[api]");
    expect(payload.text).toContain("TypeError");
    expect(Array.isArray(payload.blocks)).toBe(true);
    // capability + request + fingerprint fields present when provided.
    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).toContain("workflow.run");
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
      capability: "ontology.neighbors",
      requestId: "req-9",
      severity: "fatal",
    });
    const row = lastRow();
    expect(row.org_id).toBe("org-1");
    expect(row.workspace_id).toBe("ws-1");
    expect(row.capability).toBe("ontology.neighbors");
    expect(row.request_id).toBe("req-9");
    expect(row.severity).toBe("fatal");
  });

  it("prefixes the message with context when supplied", () => {
    captureError({ error: new Error("failed"), source: "inngest", context: "fn x" });
    const row = lastRow();
    expect(row.message).toBe("fn x: failed");
  });

  it("coerces non-Error thrown values", () => {
    captureError({ error: "string failure", source: "api" });
    const row = lastRow();
    expect(row.error_class).toBe("UnknownError");
    expect(row.message).toBe("string failure");
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
    insertErrorEvents.mockImplementationOnce(() => Promise.reject(new Error("ch down")));
    expect(() => captureError({ error: new Error("z"), source: "api" })).not.toThrow();
    await flush();
  });

  it("never throws even when the webhook fetch rejects", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/abc";
    fetchSpy.mockImplementationOnce(() => Promise.reject(new Error("net")));
    expect(() => captureError({ error: new Error("z"), source: "api" })).not.toThrow();
    await flush();
  });
});
