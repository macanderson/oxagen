/**
 * Unit tests for POST /v1/telemetry/usage (telemetry.usage route).
 *
 * Tests the route directly (no full app import) — it is public and has no
 * auth dependency, mirroring auth.cli.token.test.ts's approach.
 *
 * Mocked boundaries:
 *   - @oxagen/telemetry's `insertUsageEvents` (the only I/O this route does).
 *     `parseUsageEventPayload` is the REAL implementation (imported via its
 *     lightweight subpath), so these tests exercise real end-to-end
 *     validation, not a re-statement of usage-events.test.ts's assertions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertUsageEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/telemetry", async () => {
  const real = await vi.importActual<
    typeof import("@oxagen/telemetry/usage-events")
  >("@oxagen/telemetry/usage-events");
  return {
    parseUsageEventPayload: real.parseUsageEventPayload,
    insertUsageEvents: mocks.insertUsageEvents,
  };
});

// ── Import AFTER mocks are declared ─────────────────────────────────────────

import { telemetryUsageRoute } from "./telemetry.usage";

const VALID_PAYLOAD = {
  install_id: "123e4567-e89b-12d3-a456-426614174000",
  session_id: "223e4567-e89b-12d3-a456-426614174000",
  oxagen_version: "2.4.10",
  os: "darwin",
  arch: "arm64",
  command: "solve",
  model_tier: "balanced",
  best_of_n: 3,
  graph_used: 1,
  pipeline_used: 1,
  tui: 0,
  headless: 0,
  byok: 0,
  tool_calls_json: '{"code_graph":3,"grep":1}',
  step_count: 12,
  duration_ms: 45_230,
  error_type: "",
  exit_status: "success",
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/usage", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Give each test (except the dedicated rate-limit ones) its own IP so the
 * module-level rate-limit bucket map never accidentally cross-contaminates. */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

beforeEach(() => {
  mocks.insertUsageEvents.mockClear();
  mocks.insertUsageEvents.mockResolvedValue(undefined);
});

describe("POST /usage — happy path", () => {
  it("returns 200 { ok: true } for a valid payload", async () => {
    const res = await telemetryUsageRoute.fetch(
      makeRequest(VALID_PAYLOAD, { "x-forwarded-for": freshIp() }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("inserts exactly one row, stamped with a server-side timestamp", async () => {
    const before = Date.now();
    await telemetryUsageRoute.fetch(
      makeRequest(VALID_PAYLOAD, { "x-forwarded-for": freshIp() }),
    );
    const after = Date.now();

    expect(mocks.insertUsageEvents).toHaveBeenCalledOnce();
    const rows = mocks.insertUsageEvents.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.command).toBe("solve");
    expect(row.install_id).toBe(VALID_PAYLOAD.install_id);

    // Server-stamped timestamp: present, ISO-8601, and within this test's wall-clock window —
    // proving it was NOT taken from (an absent) client-supplied field.
    expect(typeof row.timestamp).toBe("string");
    const stamped = new Date(row.timestamp as string).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("never forwards a client-supplied timestamp field, even if one is sent", async () => {
    const spoofed = { ...VALID_PAYLOAD, timestamp: "1999-01-01T00:00:00.000Z" };
    const res = await telemetryUsageRoute.fetch(
      makeRequest(spoofed, { "x-forwarded-for": freshIp() }),
    );
    // `timestamp` is not in the allowlist — .strict() rejects the whole payload.
    expect(res.status).toBe(400);
    expect(mocks.insertUsageEvents).not.toHaveBeenCalled();
  });
});

describe("POST /usage — validation rejects malformed input", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await telemetryUsageRoute.fetch(
      new Request("http://localhost/usage", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": freshIp(),
        },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.insertUsageEvents).not.toHaveBeenCalled();
  });

  it("returns 400 and does not insert when the payload carries an unlisted key", async () => {
    const res = await telemetryUsageRoute.fetch(
      makeRequest(
        { ...VALID_PAYLOAD, prompt: "fix the login bug" },
        { "x-forwarded-for": freshIp() },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    // The error message never echoes the rejected content back to the caller.
    expect(body.message).not.toContain("fix the login bug");
    expect(mocks.insertUsageEvents).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing required field", async () => {
    const { command: _command, ...withoutCommand } = VALID_PAYLOAD;
    const res = await telemetryUsageRoute.fetch(
      makeRequest(withoutCommand, { "x-forwarded-for": freshIp() }),
    );
    expect(res.status).toBe(400);
    expect(mocks.insertUsageEvents).not.toHaveBeenCalled();
  });

  it("returns 400 for an out-of-range field (best_of_n > UInt8)", async () => {
    const res = await telemetryUsageRoute.fetch(
      makeRequest(
        { ...VALID_PAYLOAD, best_of_n: 999 },
        { "x-forwarded-for": freshIp() },
      ),
    );
    expect(res.status).toBe(400);
    expect(mocks.insertUsageEvents).not.toHaveBeenCalled();
  });
});

describe("POST /usage — insert failure", () => {
  it("returns 500 when the ClickHouse insert throws, without leaking the error detail", async () => {
    mocks.insertUsageEvents.mockRejectedValueOnce(
      new Error("connection refused at 10.0.0.1"),
    );
    const res = await telemetryUsageRoute.fetch(
      makeRequest(VALID_PAYLOAD, { "x-forwarded-for": freshIp() }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).not.toContain("10.0.0.1");
  });
});

describe("POST /usage — rate limiting", () => {
  it("rejects the 61st request/minute from the same IP with 429", async () => {
    const ip = "198.51.100.250"; // dedicated IP, not shared with other tests
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const res = await telemetryUsageRoute.fetch(
        makeRequest(VALID_PAYLOAD, { "x-forwarded-for": ip }),
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    // Exactly 60 successful inserts — the 61st never reached the handler.
    expect(mocks.insertUsageEvents).toHaveBeenCalledTimes(60);
  });

  it("tracks a different IP independently of the one above", async () => {
    const res = await telemetryUsageRoute.fetch(
      makeRequest(VALID_PAYLOAD, { "x-forwarded-for": "198.51.100.251" }),
    );
    expect(res.status).toBe(200);
  });
});
