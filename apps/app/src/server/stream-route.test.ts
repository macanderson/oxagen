import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notBacked } from "@/data/not-backed";
import type { StreamFeeds } from "./stream-feeds";
import { fleetSinceNotBacked, streamFeeds } from "./stream-feeds";
import {
  STREAM_PAGE_SIZE,
  handleStreamRequest,
  reportStreamError,
  type StreamRouteDeps,
} from "./stream-route";
import type { Viewer, ViewerResolution } from "./viewer-resolution";

const { captureErrorMock } = vi.hoisted(() => ({ captureErrorMock: vi.fn() }));
vi.mock("@oxagen/telemetry", () => ({ captureError: captureErrorMock }));

const viewer: Viewer = {
  userId: "u1",
  user: { id: "u1", email: "m@acme.example", name: null, image: null },
  orgRole: "member",
  scope: {
    orgId: "6f1d2c3a-5b4e-4d10-8a01-00000000ac01",
    workspaceId: "6f1d2c3a-5b4e-4d10-8a01-00000000c001",
  },
  org: {
    id: "6f1d2c3a-5b4e-4d10-8a01-00000000ac01",
    slug: "acme",
    name: "Acme",
  },
  ws: {
    id: "6f1d2c3a-5b4e-4d10-8a01-00000000c001",
    slug: "core-platform",
    name: "Core platform",
  },
};
const params = { org: "acme", ws: "core-platform" };
const base = "http://localhost:3000/api/mc/acme/core-platform/stream";

function deps(
  resolution: ViewerResolution = { kind: "ok", viewer },
  feeds: Partial<StreamFeeds> = {},
): StreamRouteDeps & {
  framesSince: ReturnType<typeof vi.fn>;
  fleetSince: ReturnType<typeof vi.fn>;
} {
  const framesSince = vi.fn(
    feeds.framesSince ??
      ((_s, _r, after: string) =>
        Promise.resolve(
          after === "0"
            ? { ok: true as const, value: [{ seq: "1" }, { seq: "2" }] }
            : notBacked("M1", "G6"),
        )),
  );
  const fleetSince = vi.fn(
    feeds.fleetSince ?? (() => Promise.resolve(notBacked("M2", "G3"))),
  );
  return {
    resolveViewer: vi.fn(() => Promise.resolve(resolution)),
    feeds: () => Promise.resolve({ framesSince, fleetSince }),
    timings: { pollMs: 0 },
    framesSince,
    fleetSince,
  };
}

const get = (url: string, headers?: HeadersInit) =>
  new Request(url, { headers });

describe("handleStreamRequest: the membership gate", () => {
  it("answers 401 without a session, before reading anything", async () => {
    const d = deps({ kind: "unauthenticated" });
    const res = await handleStreamRequest(get(`${base}?run=arun_1`), params, d);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: "unauthenticated" });
    expect(d.framesSince).not.toHaveBeenCalled();
  });

  it("answers 404 for a stranger, exactly like an unknown organization", async () => {
    const d = deps({ kind: "not_found" });
    const res = await handleStreamRequest(get(`${base}?run=arun_1`), params, d);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ code: "not_found" });
    expect(d.framesSince).not.toHaveBeenCalled();
  });

  it("answers 403 when MFA enrollment is overdue", async () => {
    const res = await handleStreamRequest(
      get(base),
      params,
      deps({ kind: "mfa_enroll" }),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      code: "mfa_enrollment_required",
    });
  });

  it("308s a renamed slug to the canonical stream URL, keeping the query", async () => {
    const res = await handleStreamRequest(
      get(
        "http://localhost:3000/api/mc/acme-robotics/platform/stream?run=arun_1&after=4",
      ),
      { org: "acme-robotics", ws: "platform" },
      deps({ kind: "redirect", org: "acme", ws: "core-platform" }),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "/api/mc/acme/core-platform/stream?run=arun_1&after=4",
    );
  });
});

describe("handleStreamRequest: input", () => {
  it("refuses a malformed run id", async () => {
    const d = deps();
    const res = await handleStreamRequest(
      get(`${base}?run=${encodeURIComponent("../../etc")}`),
      params,
      d,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ code: "invalid_run_id" });
    expect(d.framesSince).not.toHaveBeenCalled();
  });

  it("refuses a malformed cursor in Last-Event-ID or ?after", async () => {
    for (const request of [
      get(`${base}?run=arun_1`, { "last-event-id": "abc" }),
      get(`${base}?run=arun_1&after=-1`),
    ]) {
      const res = await handleStreamRequest(request, params, deps());
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        code: "invalid_stream_cursor",
      });
    }
  });
});

describe("handleStreamRequest: streaming", () => {
  it("streams a run's frames in the viewer's scope as event: frame with SSE headers", async () => {
    const d = deps();
    const res = await handleStreamRequest(get(`${base}?run=arun_1`), params, d);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    const text = await res.text();
    expect(text).toContain('id: 1\nevent: frame\ndata: {"seq":"1"}');
    expect(text).toContain('id: 2\nevent: frame\ndata: {"seq":"2"}');
    expect(text).toContain("event: state");
    expect(d.framesSince).toHaveBeenCalledWith(
      viewer.scope,
      "arun_1",
      "0",
      STREAM_PAGE_SIZE,
    );
    expect(d.framesSince).toHaveBeenLastCalledWith(
      viewer.scope,
      "arun_1",
      "2",
      STREAM_PAGE_SIZE,
    );
    expect(d.fleetSince).not.toHaveBeenCalled();
  });

  it("resumes from Last-Event-ID over ?after", async () => {
    const d = deps();
    await (
      await handleStreamRequest(
        get(`${base}?run=arun_1&after=1`, { "last-event-id": "9" }),
        params,
        d,
      )
    ).text();
    expect(d.framesSince).toHaveBeenCalledWith(
      viewer.scope,
      "arun_1",
      "9",
      STREAM_PAGE_SIZE,
    );
  });

  it("streams fleet patches when no run is named", async () => {
    const d = deps(undefined, {
      fleetSince: (_s, after) =>
        Promise.resolve(
          after === "0"
            ? { ok: true as const, value: [{ seq: "5" }] }
            : notBacked("M2", "G3"),
        ),
    });
    const text = await (await handleStreamRequest(get(base), params, d)).text();
    expect(text).toContain('id: 5\nevent: patch\ndata: {"seq":"5"}');
    expect(d.framesSince).not.toHaveBeenCalled();
  });

  it("hands a thrown read to the error reporter", async () => {
    const onError = vi.fn();
    const boom = new Error("x");
    const d = {
      ...deps(undefined, { framesSince: () => Promise.reject(boom) }),
      onError,
    };
    const text = await (
      await handleStreamRequest(get(`${base}?run=arun_1`), params, d)
    ).text();
    expect(text).toContain("stream_read_failed");
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(boom);
    });
  });

  it("reads every poll in the request's async context, though the body is pulled after the handler returns", async () => {
    // Stands in for Next's request store, which `cookies()` reads.
    const request = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const d = deps(undefined, {
      framesSince: (_s, _r, after: string) => {
        seen.push(request.getStore());
        return Promise.resolve(
          after === "0"
            ? { ok: true as const, value: [{ seq: "1" }] }
            : notBacked("M1", "G6"),
        );
      },
    });
    const res = await request.run("req-1", () =>
      handleStreamRequest(get(`${base}?run=arun_1`), params, d),
    );
    expect(request.getStore()).toBeUndefined();
    await res.text();
    expect(seen).toEqual(["req-1", "req-1"]);
  });

  it("rethrows an unexpected failure while resolving the cursor", async () => {
    const req = get(`${base}?run=arun_1`);
    vi.spyOn(req.headers, "get").mockImplementation(() => {
      throw new TypeError("headers gone");
    });
    await expect(handleStreamRequest(req, params, deps())).rejects.toThrow(
      "headers gone",
    );
  });
});

describe("stream feeds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stream a seeded run's frames from the fixture source, oldest first after the cursor", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MC_DATA", "fixture");
    const feeds = await streamFeeds();
    const first = await feeds.framesSince(
      viewer.scope,
      "run_01K5RS7M2E8FJ3QW",
      "0",
      3,
    );
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(first.value).toHaveLength(3);
    const seqs = first.value.map((f) => BigInt(f.seq));
    expect(seqs.every((q, i) => i === 0 || q > (seqs[i - 1] ?? 0n))).toBe(true);
    expect(seqs.every((q) => q > 0n)).toBe(true);
    const last = first.value.at(-1)?.seq ?? "0";
    const next = await feeds.framesSince(
      viewer.scope,
      "run_01K5RS7M2E8FJ3QW",
      last,
      1,
    );
    if (!next.ok) throw new Error(JSON.stringify(next));
    expect(next.value).toHaveLength(1);
    expect(BigInt(next.value[0]?.seq ?? "0")).toBeGreaterThan(BigInt(last));
  });

  it("answer an unknown run as not found, never an empty stream (negative)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MC_DATA", "fixture");
    const feeds = await streamFeeds();
    await expect(
      feeds.framesSince(viewer.scope, "arun_01", "0", 10),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "run_not_found",
      status: 404,
    });
  });

  it("delegate frames to the live source's run port outside fixture mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    const { liveSource } = await import("@/data/adapters/live");
    const answer = notBacked("M1", "G6");
    const spy = vi
      .spyOn(liveSource.runs, "framesSince")
      .mockResolvedValue(answer);
    const feeds = await streamFeeds();
    await expect(
      feeds.framesSince(viewer.scope, "arun_1", "0", 10),
    ).resolves.toEqual(answer);
    expect(spy).toHaveBeenCalledWith(viewer.scope, "arun_1", "0", 10);
  });

  it("answer the fleet feed's honest gap (G3) until a port reads patches by cursor", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MC_DATA", "fixture");
    const feeds = await streamFeeds();
    expect(feeds.fleetSince).toBe(fleetSinceNotBacked);
    await expect(feeds.fleetSince(viewer.scope, "0", 10)).resolves.toEqual(
      notBacked("M2", "G3"),
    );
  });
});

describe("reportStreamError", () => {
  beforeEach(() => {
    captureErrorMock.mockReset();
  });

  it("captures to telemetry on the live source", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const err = new Error("x");
    await reportStreamError(err);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: err, source: "app" }),
    );
  });

  it("never throws when capture itself fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    captureErrorMock.mockImplementation(() => {
      throw new Error("clickhouse down");
    });
    await expect(reportStreamError(new Error("x"))).resolves.toBeUndefined();
  });

  it("logs locally in fixture mode without loading telemetry", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await reportStreamError(new Error("x"));
    expect(log).toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
