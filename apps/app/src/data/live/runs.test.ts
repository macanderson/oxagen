// The runs port: one list_runs page through the kernel seam at the asked
// cursor, mapped into the Fleet view, with a refusal passed through and an
// unmappable record reported once.
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import { runFrameBodyGet } from "@oxagen/oxagen/contracts/run.frame_body.get";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { runs } = await import("./runs");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const run = {
  id: "tse_4f0a",
  source: "tacho",
  agentKey: null,
  operatorId: null,
  status: "live",
  turns: null,
  steps: 3,
  frames: 9,
  cost: null,
  taskRef: null,
  name: null,
  summary: null,
  replayGrade: null,
  startedAt: "2026-09-15T08:55:00.000Z",
  sealedAt: null,
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("runs.list", () => {
  it("reads the newest page with no cursor and maps it", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [run], nextCursor: "c2" }));
    const read = await runs.list(ctx, { cursor: null });
    expect(read).toEqual(
      readOk({
        runs: [
          {
            id: "tse_4f0a",
            source: "tacho",
            agentKey: null,
            operatorId: null,
            status: "live",
            turns: null,
            steps: 3,
            frames: 9,
            cost: null,
            taskRef: null,
            name: null,
            summary: null,
            replayGrade: null,
            startedAt: "2026-09-15T08:55:00.000Z",
            sealedAt: null,
          },
        ],
        nextCursor: "c2",
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runList,
      input: {},
      page: "fleet",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes the cursor of a later page to list_runs", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [], nextCursor: null }));
    await runs.list(ctx, { cursor: "c2" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runList,
      input: { cursor: "c2" },
      page: "fleet",
    });
  });

  it("passes a refused read through (negative)", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "workspace.read",
    };
    kernelRead.mockResolvedValue(denied);
    expect(await runs.list(ctx, { cursor: null })).toEqual(denied);
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ runs: [{ ...run, id: "not-a-public-id" }], nextCursor: null }),
    );
    expect(await runs.list(ctx, { cursor: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("runs.get", () => {
  const frame = {
    cursor: "ZjoxMQ",
    seq: "11",
    type: "llm_call",
    stage: "act",
    observedAt: "2026-09-15T08:56:00.000Z",
    digest: "sha256:5f2d",
    summary: "anthropic · claude-opus-5 · ok",
    body: {
      digest: "sha256:9a1b",
      bytesRef: "blob://x",
      redactions: [
        { path: "bytes:1-4", reason: "api key", originalDigest: "sha256:cut" },
      ],
      fidelity: "full",
    },
    cost: { micros: "1000", currency: "USD", basis: "gateway_observed" },
  };

  it("reads the run with no cursor, never waits inside the render, and maps the frames", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        run,
        frames: { frames: [frame], cursor: "ZjoyMA" },
        witnessFor: null,
      }),
    );
    const read = await runs.get(ctx, "tse_4f0a", { framesAfter: null });
    expect(read.ok && read.value.frames.frames[0]).toMatchObject({
      seq: "11",
      digest: "sha256:5f2d",
      body: { fidelity: "full", redactions: [{ reason: "api key" }] },
      cost: { micros: "1000", currency: "USD", basis: "gateway_observed" },
    });
    expect(read.ok && read.value.witnessed).toBe(false);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runGet,
      input: { runId: "tse_4f0a", frameLimit: 200, waitMs: 0 },
      page: "run",
    });
  });

  it("passes the frame cursor the URL carried", async () => {
    kernelRead.mockResolvedValue(
      readOk({ run, frames: { frames: [], cursor: null }, witnessFor: null }),
    );
    await runs.get(ctx, "tse_4f0a", { framesAfter: "ZjoyMA" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runGet,
      input: {
        runId: "tse_4f0a",
        framesAfter: "ZjoyMA",
        frameLimit: 200,
        waitMs: 0,
      },
      page: "run",
    });
  });

  it("promises a later page only when the page came back full with a resume point", async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      ...frame,
      cursor: `c${String(i)}`,
      seq: String(i + 1),
    }));
    kernelRead.mockResolvedValue(
      readOk({
        run,
        frames: { frames: full, cursor: "ZjoyMDA" },
        witnessFor: null,
      }),
    );
    const read = await runs.get(ctx, "tse_4f0a", { framesAfter: null });
    expect(read.ok && read.value.frames.more).toBe(true);
  });

  it("promises no later page for a short batch, whatever its cursor says (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        run,
        frames: { frames: [frame], cursor: "ZjoxMQ" },
        witnessFor: null,
      }),
    );
    const read = await runs.get(ctx, "tse_4f0a", { framesAfter: null });
    expect(read.ok && read.value.frames.more).toBe(false);
    expect(read.ok && read.value.frames.cursor).toBe("ZjoxMQ");
  });

  it("carries a witness link as a boolean and nothing more", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        run,
        frames: { frames: [], cursor: null },
        witnessFor: "arun_worker",
      }),
    );
    const read = await runs.get(ctx, "tse_4f0a", { framesAfter: null });
    expect(read.ok && read.value.witnessed).toBe(true);
  });

  it("answers record_unmappable and reports once for a frame the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        run,
        frames: { frames: [{ ...frame, seq: "eleven" }], cursor: null },
        witnessFor: null,
      }),
    );
    expect(await runs.get(ctx, "tse_4f0a", { framesAfter: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("runs.frameBody", () => {
  const redaction = {
    path: "bytes:1-4",
    reason: "api key",
    originalDigest: "sha256:cut",
  };

  it("reads one frame by its seq and decodes UTF-8 bytes as text", async () => {
    const text = '{"role":"user","content":"Cut release/3.2 — go"}';
    kernelRead.mockResolvedValue(
      readOk({
        contentType: "application/json",
        bytes: Buffer.from(text, "utf8").toString("base64"),
        digest: "sha256:9a1b",
        redactions: [redaction],
      }),
    );
    const read = await runs.frameBody(ctx, "tse_4f0a", "11");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runFrameBodyGet,
      input: { runId: "tse_4f0a", seq: "11" },
      page: "run",
    });
    expect(read).toEqual(
      readOk({
        seq: "11",
        contentType: "application/json",
        text,
        bytes: Buffer.byteLength(text, "utf8"),
        digest: "sha256:9a1b",
        redactions: [redaction],
      }),
    );
  });

  it("keeps bytes that are not UTF-8 as a size with no text (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        contentType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]).toString(
          "base64",
        ),
        digest: "sha256:9a1b",
        redactions: [],
      }),
    );
    const read = await runs.frameBody(ctx, "tse_4f0a", "11");
    expect(read.ok && read.value).toMatchObject({
      contentType: "image/png",
      text: null,
      bytes: 6,
    });
  });

  it("answers a digest_only frame with its digest and no bytes", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        contentType: null,
        bytes: null,
        digest: "sha256:9a1b",
        redactions: [],
      }),
    );
    const read = await runs.frameBody(ctx, "tse_4f0a", "11");
    expect(read.ok && read.value).toMatchObject({
      contentType: null,
      text: null,
      bytes: null,
      digest: "sha256:9a1b",
    });
  });

  it("passes a refused read through (negative)", async () => {
    kernelRead.mockResolvedValue(readError("not_found", 404));
    expect(await runs.frameBody(ctx, "tse_4f0a", "999")).toEqual(
      readError("not_found", 404),
    );
  });
});

describe("runs.cost", () => {
  const tokens = {
    input_uncached: 10,
    cache_read: 90,
    cache_write_5m: 1,
    cache_write_1h: 0,
    output: 5,
    reasoning: 2,
  };

  it("maps the rollup's snake_case token classes into the view's own spelling", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        rollup: {
          cost: { micros: "500", currency: "USD", basis: "mixed" },
          tokens,
          cacheHitRate: 0.9,
          turns: 2,
          steps: 7,
          modelCalls: 4,
          toolCalls: 3,
          retries: null,
          productiveRatio: null,
          byModel: [
            {
              model: "claude-opus-5",
              provider: "anthropic",
              calls: 4,
              cost: null,
              tokens,
            },
          ],
          byTool: [{ name: "create_release", calls: 3 }],
          priceEntryIds: ["prc_1"],
          rolledUpAt: "2026-09-15T08:59:00.000Z",
        },
      }),
    );
    const read = await runs.cost(ctx, "tse_4f0a");
    expect(read.ok && read.value.rollup?.tokens).toEqual({
      inputUncached: 10,
      cacheRead: 90,
      cacheWrite5m: 1,
      cacheWrite1h: 0,
      output: 5,
      reasoning: 2,
    });
    expect(read.ok && read.value.rollup?.retries).toBeNull();
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runCostGet,
      input: { runId: "tse_4f0a" },
      page: "run",
    });
  });

  it("keeps a rollup that has not run as null, never as a zero (negative)", async () => {
    kernelRead.mockResolvedValue(readOk({ runId: "tse_4f0a", rollup: null }));
    expect(await runs.cost(ctx, "tse_4f0a")).toEqual(readOk({ rollup: null }));
  });
});

describe("runs.transcript", () => {
  it("asks for the level it was given and maps the entries", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        zoom: "turns",
        entries: [
          {
            seq: "1",
            endSeq: "4",
            at: "2026-09-15T08:56:00.000Z",
            kind: "turn",
            type: "llm_call",
            label: "claude-opus-5",
            text: null,
            truncated: false,
            fidelity: "digest_only",
            frames: 4,
            turn: 2,
            cost: null,
          },
        ],
        complete: false,
      }),
    );
    const read = await runs.transcript(ctx, "tse_4f0a", "turns");
    expect(read.ok && read.value.complete).toBe(false);
    expect(read.ok && read.value.entries[0]?.fidelity).toBe("digest_only");
    expect(read.ok && read.value.entries[0]?.turn).toBe(2);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runTranscriptGet,
      input: { runId: "tse_4f0a", zoom: "turns" },
      page: "run",
    });
  });
});
