/**
 * run.stream.test.ts
 *
 * One run's frames, live. The route is a loop over `get_run` turned into the
 * same SSE shape the chat stream uses, so what is tested here is the loop: it
 * invokes through the kernel on every read (so the gates run on each), writes
 * each frame with its own cursor as the SSE `id:`, resumes from
 * `Last-Event-ID`, closes with a reason, and answers a refusal before the
 * stream is open as a status rather than as a 200 whose first line is an error.
 *
 * The kernel is a fake here; `get_run`'s own tests are
 * packages/handlers/src/run.get.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hono as HonoType } from "hono";

const mocks = vi.hoisted(() => ({
  capabilityContext: vi.fn(),
  invoke: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));
vi.mock("../../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: mocks.logError, info: vi.fn() },
}));
vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: mocks.invoke };
});

const { Hono } = await import("hono");
const { HandlerError } = await import("@oxagen/oxagen");
const { CapabilityError } = await import("@oxagen/oxagen/kernel");
const { errorMiddleware } = await import("../../middleware/error");
const { runStreamRoute } = await import("./run.stream");

const app = new Hono();
app.onError(errorMiddleware as never);
app.route(
  "/v1/:org_slug/:workspace_slug/runs/:run_id/stream",
  runStreamRoute as unknown as HonoType,
);

const CTX = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: "33333333-3333-3333-3333-333333333333",
  apiKeyId: null,
  requestId: "44444444-4444-4444-4444-444444444444",
  surface: "api" as const,
  messageId: null,
  clientIp: null,
};

const RUN_ID = "arun_0123456789abcdefghjkmn";
const RUN = { id: RUN_ID, status: "live" };

const frame = (seq: string) => ({
  cursor: `cur_${seq}`,
  seq,
  type: "tool_call",
  stage: "tool",
  observedAt: "2026-09-18T10:00:00.000Z",
  digest: `sha256:${seq.padStart(64, "0")}`,
  summary: "Read ok",
  body: {
    digest: null,
    bytesRef: null,
    redactions: [],
    fidelity: "digest_only",
  },
  cost: null,
});

/** A `get_run` page: the frames it returns and the cursor it leaves. */
const page = (
  seqs: string[],
  cursor: string | null,
  status: "live" | "sealed" | "halted" = "live",
) => ({
  run: { ...RUN, status },
  frames: { frames: seqs.map(frame), cursor },
  witnessFor: null,
});

async function open(
  headers: Record<string, string> = {},
  query = "",
): Promise<{ status: number; text: string }> {
  const res = await app.request(`/v1/acme/core/runs/${RUN_ID}/stream${query}`, {
    method: "GET",
    headers,
  });
  const text = res.status === 200 ? await res.text() : await res.text();
  return { status: res.status, text };
}

/** The SSE `id:` lines, in order: the resume points the client keeps. */
const ids = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("id: "))
    .map((line) => line.slice(4));

/** The named events, in order. */
const events = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice(7));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(CTX);
});

describe("GET /runs/:run_id/stream", () => {
  it("opens with the run, writes each frame with its own cursor, and closes when the recording ends", async () => {
    mocks.invoke
      .mockResolvedValueOnce(page(["1", "2"], "cur_2"))
      .mockResolvedValueOnce(page(["3"], null, "sealed"));

    const { status, text } = await open();
    expect(status).toBe(200);
    expect(events(text)).toEqual(["run", "done"]);
    // Each frame's own cursor is the SSE id, so a client that drops after any
    // frame resumes from exactly that frame.
    expect(ids(text)).toEqual(["cur_1", "cur_2", "cur_3"]);
    expect(text).toContain('"reason":"sealed"');
    expect(text).toContain('"cursor":"cur_3"');
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("invokes get_run through the kernel on every read, so the gates run on each", async () => {
    mocks.invoke
      .mockResolvedValueOnce(page(["1"], "cur_1"))
      .mockResolvedValueOnce(page([], null, "sealed"));

    await open();
    for (const call of mocks.invoke.mock.calls) {
      expect(call[0]).toBe("get_run");
      // The run id comes from the mounted path parameter; this is the only
      // route in the table mounted with one, so it is asserted rather than
      // assumed.
      expect(call[1]).toMatchObject({ runId: RUN_ID });
      expect(call[2]).toBe(CTX);
      expect(call[3]).toEqual({ surface: "api" });
    }
    // The first read does not wait; every read after it long-polls, so an idle
    // stream costs one invoke per wait rather than one per client tick.
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ waitMs: 0 });
    expect(mocks.invoke.mock.calls[1]?.[1]).toMatchObject({ waitMs: 20_000 });
  });

  it("keeps a caught-up live run open rather than reporting a false sealed (finding 4, negative)", async () => {
    // A client connecting before the run's first frame, or reconnecting while
    // already caught up: `get_run` answers no frames and a null cursor
    // because there is no new `last` frame, but the run's status says it is
    // still `live`.
    mocks.invoke
      .mockResolvedValueOnce(page([], null))
      .mockResolvedValueOnce(page(["5"], "cur_5"))
      .mockResolvedValueOnce(page([], null, "sealed"));

    const { status, text } = await open();
    expect(status).toBe(200);
    // No premature `sealed`: the run only closes once its status says so.
    expect(events(text)).toEqual(["run", "done"]);
    expect(ids(text)).toEqual(["cur_5"]);
    expect(text).toContain('"reason":"sealed"');
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("resumes from Last-Event-ID, and from ?after for a client that is not EventSource", async () => {
    mocks.invoke.mockResolvedValue(page([], null, "sealed"));
    await open({ "last-event-id": "cur_7" });
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({
      framesAfter: "cur_7",
    });

    vi.clearAllMocks();
    mocks.capabilityContext.mockReturnValue(CTX);
    mocks.invoke.mockResolvedValue(page([], null, "sealed"));
    await open({}, "?after=cur_9");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({
      framesAfter: "cur_9",
    });
  });

  it("answers a refusal before the stream is open as a status, not as a 200 (negative)", async () => {
    mocks.invoke.mockRejectedValueOnce(
      new HandlerError({ code: "not_found", reason: "run_not_found" }),
    );
    const { status, text } = await open();
    expect(status).toBe(404);
    expect(text).not.toContain("event: run");
  });

  it("answers a failure after the stream is open as a typed error event carrying the resume point (negative)", async () => {
    mocks.invoke
      .mockResolvedValueOnce(page(["1"], "cur_1"))
      .mockRejectedValueOnce(
        // The failure a resuming client is most likely to hit: a cursor
        // `get_run` did not write. It is a kernel refusal, not a handler one.
        new CapabilityError("get_run", "invalid_input", "invalid_cursor"),
      );
    const { status, text } = await open();
    expect(status).toBe(200);
    expect(events(text)).toEqual(["run", "error"]);
    // The kernel's stable code; the message carries what went wrong.
    expect(text).toContain('"code":"invalid_input"');
    expect(text).toContain("invalid_cursor");
    expect(text).toContain('"cursor":"cur_1"');
  });

  it("keeps an active stream open past its initial idle deadline", async () => {
    const clock = vi.spyOn(Date, "now");
    let now = 0;
    clock.mockImplementation(() => now);
    mocks.invoke
      .mockResolvedValueOnce(page(["1"], "cur_1"))
      .mockImplementationOnce(async () => {
        now = 240_000;
        return page(["2"], "cur_2");
      })
      .mockImplementationOnce(async () => {
        now = 480_000;
        return page(["3"], "cur_3");
      })
      .mockResolvedValueOnce(page([], null, "sealed"));
    try {
      const { text } = await open();
      expect(text).toContain('"reason":"sealed"');
      expect(text).not.toContain('"reason":"idle"');
      expect(mocks.invoke).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
    }
  });

  it("closes after a full idle interval without losing the last emitted cursor", async () => {
    const clock = vi.spyOn(Date, "now");
    let now = 0;
    clock.mockImplementation(() => now);
    mocks.invoke
      .mockResolvedValueOnce(page(["1"], null))
      .mockImplementationOnce(async () => {
        now = 300_000;
        return page([], null);
      });
    try {
      const { text } = await open();
      expect(text).toContain('"reason":"idle","cursor":"cur_1"');
      expect(mocks.invoke.mock.calls[1]?.[1]).toMatchObject({
        framesAfter: "cur_1",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("logs unexpected failures and keeps their details out of the event", async () => {
    const error = new Error("private database connection details");
    mocks.invoke
      .mockResolvedValueOnce(page(["1"], null))
      .mockRejectedValueOnce(error);
    const { text } = await open();
    expect(text).toContain('"message":"Run stream unavailable"');
    expect(text).toContain('"code":"stream_unavailable"');
    expect(text).toContain('"cursor":"cur_1"');
    expect(text).not.toContain(error.message);
    expect(mocks.logError).toHaveBeenCalledWith(
      { err: error, runId: RUN_ID, requestId: CTX.requestId },
      "run stream failed",
    );
  });

  it("refuses a run id the contract does not accept (negative)", async () => {
    const res = await app.request("/v1/acme/core/runs/nope/stream", {
      method: "GET",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
