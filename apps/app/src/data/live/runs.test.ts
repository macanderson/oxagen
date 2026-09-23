// The runs port: one list_runs page through the kernel seam at the asked
// cursor, mapped into the Fleet view, with a refusal passed through and an
// unmappable record reported once.
import { runChainGet } from "@oxagen/oxagen/contracts/run.chain.get";
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

// The contract names the vendor string `id`; the view names it `slug`, so the
// two spellings are held apart here rather than shared.
const wireModel = {
  id: "claude-opus-5",
  provider: "anthropic",
  tier: "frontier",
};
const viewModel = {
  slug: "claude-opus-5",
  provider: "anthropic",
  tier: "frontier",
};

const machine = {
  hostname: "tycho",
  platform: "darwin",
  osVersion: "25.6.0",
  arch: "arm64",
  nodeVersion: "24.4.0",
};

const run = {
  id: "tse_4f0a",
  source: "tacho",
  agentKey: null,
  operatorId: null,
  // Nullable but required, all four: `RunRow` names each of them, so a
  // fixture omitting one maps to `undefined`, `RunPage.safeParse` rejects the
  // whole page, and a happy-path read asserts a 502 (`record_unmappable`).
  //
  // All four are populated rather than null, because a real value also proves
  // the mapping carries it through rather than merely tolerating the field.
  operatorKind: "human",
  operatorName: "Ada Lovelace",
  status: "live",
  outcome: "running",
  turns: null,
  steps: 3,
  frames: 9,
  cost: null,
  model: wireModel,
  machine,
  taskRef: null,
  name: null,
  summary: null,
  replayGrade: null,
  verdict: null,
  enforcementTier: "observe",
  completenessGaps: ["digest_only"],
  canSummarize: false,
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
            operatorKind: "human",
            operatorName: "Ada Lovelace",
            status: "live",
            outcome: "running",
            turns: null,
            steps: 3,
            frames: 9,
            cost: null,
            reportedCost: null,
            model: viewModel,
            harness: null,
            machine,
            taskRef: null,
            name: null,
            summary: null,
            replayGrade: null,
            verdict: null,
            enforcementTier: "observe",
            enrichmentEnabled: true,
            reportedCost: null,
            ingressPaused: false,
            ingressRevoked: false,
            completenessGaps: ["digest_only"],
            canSummarize: false,
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
            elapsedMs: 4000,
            kind: "turn",
            type: "llm_call",
            label: "claude-opus-5",
            callId: null,
            kinds: ["responses"],
            request: null,
            response: {
              seq: "1",
              type: "llm_call",
              digest: `sha256:${"a".repeat(64)}`,
              bytesRef: null,
              redactions: [],
              fidelity: "digest_only",
              text: null,
              truncated: false,
            },
            decision: null,
            frames: 4,
            turn: 2,
            cost: null,
            cumulativeCost: null,
          },
        ],
        kinds: [],
        cursor: null,
        complete: false,
      }),
    );
    const read = await runs.transcript(ctx, "tse_4f0a", "turns");
    expect(read.ok && read.value.complete).toBe(false);
    expect(read.ok && read.value.entries[0]?.response?.fidelity).toBe(
      "digest_only",
    );
    expect(read.ok && read.value.entries[0]?.turn).toBe(2);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runTranscriptGet,
      input: { runId: "tse_4f0a", zoom: "turns", kinds: [], limit: 200 },
      page: "run",
    });
  });

  it("passes the chips pressed and the cursor, and omits a cursor it was not given", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        zoom: "steps",
        kinds: ["tools"],
        entries: [],
        cursor: null,
        complete: true,
      }),
    );
    await runs.transcript(ctx, "tse_4f0a", "steps", {
      kinds: ["tools"],
      after: "cur_7",
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runTranscriptGet,
      input: {
        runId: "tse_4f0a",
        zoom: "steps",
        kinds: ["tools"],
        limit: 200,
        after: "cur_7",
      },
      page: "run",
    });

    kernelRead.mockClear();
    await runs.transcript(ctx, "tse_4f0a", "steps", { after: null });
    // The contract refuses a cursor it did not write, so "read from the start"
    // omits the key rather than sending a null it would reject.
    expect(kernelRead.mock.calls[0]?.[1]).toMatchObject({
      input: { runId: "tse_4f0a", zoom: "steps", kinds: [], limit: 200 },
    });
    expect(kernelRead.mock.calls[0]?.[1]).not.toHaveProperty("input.after");
  });
});

describe("runs.transcript", () => {
  it("carries the chips and the resume point the caller asked for", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        zoom: "steps",
        kinds: ["tools", "errors"],
        entries: [],
        cursor: "e:41",
        complete: false,
      }),
    );
    await runs.transcript(ctx, "tse_4f0a", "steps", {
      kinds: ["tools", "errors"],
      after: "e:20",
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runTranscriptGet,
      input: {
        runId: "tse_4f0a",
        zoom: "steps",
        kinds: ["tools", "errors"],
        limit: 200,
        after: "e:20",
      },
      page: "run",
    });
  });

  it("omits `after` entirely when the caller has no resume point (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        zoom: "steps",
        kinds: [],
        entries: [],
        cursor: null,
        complete: true,
      }),
    );
    await runs.transcript(ctx, "tse_4f0a", "steps", { kinds: [], after: null });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runTranscriptGet,
      input: { runId: "tse_4f0a", zoom: "steps", kinds: [], limit: 200 },
      page: "run",
    });
  });
});

describe("runs.chain", () => {
  it("reads get_run_chain for the run and maps the ladder, the gaps and the seal", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        hashRule: "tacho.sha256_prev_hash_v1",
        frameCount: 9,
        firstSeq: "1",
        lastSeq: "9",
        merkleRoot: null,
        checkpoints: [],
        gaps: {
          missingSequences: [{ from: "4", to: "5" }],
          missingFrameCount: 2,
          missingBodies: 9,
          recorded: ["digest_only"],
        },
        seals: [],
        enforcementTier: "observe",
        recordedGrade: null,
        ladder: [
          { grade: "inspect", met: true, reason: "frames_recorded" },
          { grade: "view", met: false, reason: "no_retained_bodies" },
        ],
        complete: true,
      }),
    );
    const read = await runs.chain(ctx, "tse_4f0a");
    expect(read.ok && read.value.gaps.missingSequences).toEqual([
      { from: "4", to: "5" },
    ]);
    expect(read.ok && read.value.recordedGrade).toBeNull();
    expect(read.ok && read.value.ladder).toHaveLength(2);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runChainGet,
      input: { runId: "tse_4f0a" },
      page: "run",
    });
  });

  it("maps one seal per attempt, oldest first, not only the latest (finding 8, negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        runId: "arun_4f0a",
        hashRule: "ledger.event_stream_digest_v1",
        frameCount: 12,
        firstSeq: "1",
        lastSeq: "12",
        merkleRoot: `sha256:${"2".repeat(64)}`,
        checkpoints: [],
        gaps: {
          missingSequences: [],
          missingFrameCount: 0,
          missingBodies: 0,
          recorded: [],
        },
        seals: [
          {
            sealedAt: "2026-09-11T10:01:00.000Z",
            terminalStatus: "abandoned",
            eventCount: 5,
            finalRunSeq: "5",
            finalEventDigest: `sha256:${"1".repeat(64)}`,
            eventStreamDigest: `sha256:${"1".repeat(64)}`,
            merkleRoot: `sha256:${"1".repeat(64)}`,
            archiveSegmentRef: null,
          },
          {
            sealedAt: "2026-09-11T10:05:00.000Z",
            terminalStatus: "completed",
            eventCount: 7,
            finalRunSeq: "12",
            finalEventDigest: `sha256:${"2".repeat(64)}`,
            eventStreamDigest: `sha256:${"2".repeat(64)}`,
            merkleRoot: `sha256:${"2".repeat(64)}`,
            archiveSegmentRef: null,
          },
        ],
        enforcementTier: "harness",
        recordedGrade: "view",
        ladder: [],
        complete: true,
      }),
    );
    const read = await runs.chain(ctx, "arun_4f0a");
    if (!read.ok) throw new Error("expected an ok read");
    expect(read.value.seals).toHaveLength(2);
    expect(read.value.seals[0]?.terminalStatus).toBe("abandoned");
    expect(read.value.seals[1]?.terminalStatus).toBe("completed");
  });

  it("reports a record the view refuses rather than passing it on (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        hashRule: "tacho.sha256_prev_hash_v1",
        frameCount: -1,
        firstSeq: null,
        lastSeq: null,
        merkleRoot: null,
        checkpoints: [],
        gaps: {
          missingSequences: [],
          missingFrameCount: 0,
          missingBodies: 0,
          recorded: [],
        },
        seals: [],
        enforcementTier: "observe",
        recordedGrade: null,
        ladder: [],
        complete: true,
      }),
    );
    const read = await runs.chain(ctx, "tse_4f0a");
    expect(read).toEqual({
      ok: false,
      reason: "error",
      code: "record_unmappable",
      status: 502,
    });
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
