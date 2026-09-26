// The runs port: one list_runs page through the kernel seam at the asked
// cursor, mapped into the Fleet view, with a refusal passed through and an
// unmappable record reported once.
import { findingList } from "@oxagen/oxagen/contracts/finding.list";
import { runChainGet } from "@oxagen/oxagen/contracts/run.chain.get";
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import { runFrameBodyGet } from "@oxagen/oxagen/contracts/run.frame_body.get";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { runOutcomesSettingsGet } from "@oxagen/oxagen/contracts/run.outcomes.settings.get";
import { runOutputsGet } from "@oxagen/oxagen/contracts/run.outputs.get";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import { runIssuesGet } from "@oxagen/oxagen/contracts/run.issues.get";
import { runContextGet } from "@oxagen/oxagen/contracts/run.context.get";
import { runTurnsGet } from "@oxagen/oxagen/contracts/run.turns.get";
import { runWorkGet } from "@oxagen/oxagen/contracts/run.work.get";
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
  operatorAttribution: "host_enroller",
  operatorRole: null,
  status: "live",
  outcome: "running",
  turns: null,
  steps: 3,
  frames: 9,
  cost: null,
  model: wireModel,
  machine,
  harness: null,
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
  endedAt: null,
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
            operatorAttribution: "host_enroller",
            // Not stamped on this row, so not recorded (#3999).
            operatorRole: null,
            status: "live",
            outcome: "running",
            turns: null,
            steps: 3,
            frames: 9,
            cost: null,
            costIsEstimate: false,
            reportedCost: null,
            // #4018's session facts: a row that recorded none maps each to
            // null, never to a guess.
            effort: null,
            thinking: null,
            permissionMode: null,
            reportedTokens: null,
            model: viewModel,
            harness: null,
            machine,
            place: null,
            taskRef: null,
            name: null,
            summary: null,
            replayGrade: null,
            verdict: null,
            enforcementTier: "observe",
            commandBlock: null,
            steerBlock: null,
            enrichmentEnabled: true,
            ingressPaused: false,
            ingressRevoked: false,
            completenessGaps: ["digest_only"],
            canSummarize: false,
            startedAt: "2026-09-15T08:55:00.000Z",
            sealedAt: null,
            sealSource: null,
            endedAt: null,
            // Read only by get_run; a list row answers neither.
            effortSource: null,
            fit: null,
          },
        ],
        nextCursor: "c2",
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runList,
      input: { limit: 100 },
      page: "fleet",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes the cursor of a later page to list_runs", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [], nextCursor: null }));
    await runs.list(ctx, { cursor: "c2" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runList,
      input: { limit: 100, cursor: "c2" },
      page: "fleet",
    });
  });

  it("passes the page size and a pull-request filter to list_runs, and leaves out an `any` filter", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [], nextCursor: null }));
    await runs.list(ctx, { cursor: null, limit: 25, pullRequests: "with" });
    expect(kernelRead).toHaveBeenLastCalledWith(ctx, {
      contract: runList,
      input: { limit: 25, pullRequests: "with" },
      page: "fleet",
    });
    await runs.list(ctx, { cursor: "c2", limit: 10, pullRequests: "any" });
    expect(kernelRead).toHaveBeenLastCalledWith(ctx, {
      contract: runList,
      input: { limit: 10, cursor: "c2" },
      page: "fleet",
    });
  });

  it("asks list_runs for the live count only when the caller does (#4343 review)", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [], nextCursor: null }));
    await runs.list(ctx, { cursor: "c2", limit: 25, countLive: true });
    expect(kernelRead).toHaveBeenLastCalledWith(ctx, {
      contract: runList,
      input: { limit: 25, cursor: "c2", countLive: true },
      page: "fleet",
    });
    // Negative: the agents page, the onboarding gate and the choice dialogs
    // read runs without the tile, so their reads count nothing.
    await runs.list(ctx, { cursor: null, countLive: false });
    expect(kernelRead).toHaveBeenLastCalledWith(ctx, {
      contract: runList,
      input: { limit: 100 },
      page: "fleet",
    });
  });

  it("carries a row's pull requests, lines and the page's warning, and leaves unread ones absent", async () => {
    const pull = {
      url: "https://github.com/acme/api/pull/42",
      number: 42,
      repository: "acme/api",
      state: null,
    };
    kernelRead.mockResolvedValue(
      readOk({
        runs: [
          {
            ...run,
            pullRequests: [pull],
            pullRequestsOpened: 1,
            diff: { added: 12, removed: 3, basis: "harness_reported" },
          },
          { ...run, id: "tse_4f0b" },
        ],
        nextCursor: null,
        warnings: ["pull_requests_unread"],
      }),
    );
    const read = await runs.list(ctx, { cursor: null });
    if (!read.ok) throw new Error("the read maps");
    expect(read.value.warnings).toEqual(["pull_requests_unread"]);
    expect(read.value.runs[0]).toMatchObject({
      pullRequests: [pull],
      pullRequestsOpened: 1,
      diff: { added: 12, removed: 3, basis: "harness_reported" },
    });
    // Not read is not "none": the row carries no list at all.
    expect(read.value.runs[1]).not.toHaveProperty("pullRequests");
    expect(read.value.runs[1]).not.toHaveProperty("diff");
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
    tool: null,
    toolStatus: null,
    approvalId: null,
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

  it("carries a parked receipt's tool, outcome and approval as fields, not as words of its label", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        run,
        frames: {
          frames: [
            {
              ...frame,
              type: "tool.engine_call_completed",
              summary: "create_tag parked",
              tool: "create_tag",
              toolStatus: "parked",
              approvalId: "apr_0a1b",
            },
          ],
          cursor: "ZjoyMA",
        },
        witnessFor: null,
      }),
    );
    const read = await runs.get(ctx, "tse_4f0a", { framesAfter: null });
    expect(read.ok && read.value.frames.frames[0]).toMatchObject({
      summary: "create_tag parked",
      tool: "create_tag",
      toolStatus: "parked",
      approvalId: "apr_0a1b",
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
    server_tool_request: 0,
  };

  it("maps the rollup's snake_case token classes into the view's own spelling", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        baseline: null,
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
          advancedSteps: null,
          unproductiveSteps: null,
          unproductiveCauses: null,
          byModel: [
            {
              model: "claude-opus-5",
              provider: "anthropic",
              calls: 4,
              cost: null,
              tokens,
              costByClass: null,
              cacheSaving: null,
              hasUnpriced: true,
            },
          ],
          byTool: [
            {
              name: "create_release",
              calls: 3,
              resultTokens: null,
              cost: null,
            },
          ],
          priceEntryIds: ["prc_1"],
          rolledUpAt: "2026-09-15T08:59:00.000Z",
          isEstimate: false,
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
    // A model no call of which was priced carries no split and no saving.
    expect(read.ok && read.value.rollup?.byModel[0]).toMatchObject({
      costByClass: null,
      cacheSaving: null,
      hasUnpriced: true,
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runCostGet,
      input: { runId: "tse_4f0a" },
      page: "run",
    });
  });

  it("maps each model's recorded cost by class and cache saving, with their basis, into the view's spelling", async () => {
    const cost = (micros: string) => ({
      micros,
      currency: "USD",
      basis: "gateway_observed" as const,
    });
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        baseline: null,
        rollup: {
          cost: cost("1000"),
          tokens,
          cacheHitRate: 0.9,
          turns: 2,
          steps: 7,
          modelCalls: 4,
          toolCalls: 3,
          retries: 0,
          productiveRatio: 1,
          advancedSteps: null,
          unproductiveSteps: null,
          unproductiveCauses: null,
          byModel: [
            {
              model: "claude-opus-5",
              provider: "anthropic",
              calls: 4,
              cost: cost("1000"),
              tokens,
              costByClass: {
                input_uncached: cost("100"),
                cache_read: cost("90"),
                cache_write_5m: cost("10"),
                cache_write_1h: cost("0"),
                output: cost("600"),
                reasoning: cost("200"),
                server_tool_request: cost("0"),
              },
              cacheSaving: cost("810"),
              hasUnpriced: false,
            },
          ],
          byTool: [],
          priceEntryIds: ["prc_1"],
          rolledUpAt: "2026-09-15T08:59:00.000Z",
          isEstimate: false,
        },
      }),
    );
    const read = await runs.cost(ctx, "tse_4f0a");
    expect(read.ok && read.value.rollup?.byModel[0]).toMatchObject({
      costByClass: {
        inputUncached: cost("100"),
        cacheRead: cost("90"),
        cacheWrite5m: cost("10"),
        cacheWrite1h: cost("0"),
        output: cost("600"),
        reasoning: cost("200"),
      },
      cacheSaving: cost("810"),
      hasUnpriced: false,
    });
  });

  // #3721. The rollup records a run's web searches as requests and prices
  // them per request; the view carries both beside the token classes.
  it("carries each model's web search requests and their recorded cost", async () => {
    const cost = (micros: string) => ({
      micros,
      currency: "USD",
      basis: "client_attested" as const,
    });
    const searched = { ...tokens, server_tool_request: 3 };
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        rollup: {
          cost: cost("31000"),
          tokens: searched,
          cacheHitRate: 0.9,
          turns: 2,
          steps: 7,
          modelCalls: 4,
          toolCalls: 3,
          retries: 0,
          productiveRatio: 1,
          byModel: [
            {
              model: "claude-opus-5",
              provider: "anthropic",
              calls: 4,
              cost: cost("31000"),
              tokens: searched,
              costByClass: {
                input_uncached: cost("100"),
                cache_read: cost("90"),
                cache_write_5m: cost("10"),
                cache_write_1h: cost("0"),
                output: cost("600"),
                reasoning: cost("200"),
                server_tool_request: cost("30000"),
              },
              cacheSaving: cost("810"),
              hasUnpriced: false,
            },
          ],
          byTool: [],
          priceEntryIds: ["prc_1"],
          rolledUpAt: "2026-09-15T08:59:00.000Z",
          isEstimate: false,
        },
      }),
    );
    const read = await runs.cost(ctx, "tse_4f0a");
    const rollup = read.ok ? read.value.rollup : null;
    expect(rollup?.searchRequests).toBe(3);
    expect(rollup?.byModel[0]).toMatchObject({
      searchRequests: 3,
      searchCost: cost("30000"),
    });
    // Requests are not a token class in the view.
    expect(rollup?.tokens).not.toHaveProperty("serverToolRequest");
  });

  it("leaves an unpriced search cost as null, never an exact zero (negative)", async () => {
    const cost = (micros: string) => ({
      micros,
      currency: "USD",
      basis: "client_attested" as const,
    });
    const searched = { ...tokens, server_tool_request: 3 };
    // A model with no search rate: the rollup marks it unpriced and writes a
    // zero figure for the class it could not price.
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        rollup: {
          cost: cost("1000"),
          tokens: searched,
          cacheHitRate: 0.9,
          turns: 2,
          steps: 7,
          modelCalls: 4,
          toolCalls: 3,
          retries: 0,
          productiveRatio: 1,
          byModel: [
            {
              model: "gpt-5",
              provider: "openai",
              calls: 4,
              cost: cost("1000"),
              tokens: searched,
              costByClass: {
                input_uncached: cost("100"),
                cache_read: cost("90"),
                cache_write_5m: cost("10"),
                cache_write_1h: cost("0"),
                output: cost("600"),
                reasoning: cost("200"),
                server_tool_request: cost("0"),
              },
              cacheSaving: cost("0"),
              hasUnpriced: true,
            },
          ],
          byTool: [],
          priceEntryIds: ["prc_1"],
          rolledUpAt: "2026-09-15T08:59:00.000Z",
          isEstimate: true,
        },
      }),
    );
    const read = await runs.cost(ctx, "tse_4f0a");
    const rollup = read.ok ? read.value.rollup : null;
    expect(rollup?.byModel[0]?.searchRequests).toBe(3);
    expect(rollup?.byModel[0]?.searchCost).toBeNull();
  });

  it("keeps a row's unrecorded cache saving as null, never a zero, beside its recorded split (negative)", async () => {
    const cost = (micros: string) => ({
      micros,
      currency: "USD",
      basis: "estimated" as const,
    });
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        baseline: null,
        rollup: {
          cost: cost("1000"),
          tokens,
          cacheHitRate: 0.9,
          turns: 2,
          steps: 7,
          modelCalls: 4,
          toolCalls: 3,
          retries: 0,
          productiveRatio: 1,
          advancedSteps: null,
          unproductiveSteps: null,
          unproductiveCauses: null,
          byModel: [
            {
              model: "claude-opus-5",
              provider: "anthropic",
              calls: 4,
              cost: cost("1000"),
              tokens,
              costByClass: {
                input_uncached: cost("100"),
                cache_read: cost("90"),
                cache_write_5m: cost("10"),
                cache_write_1h: cost("0"),
                output: cost("600"),
                reasoning: cost("200"),
                server_tool_request: cost("0"),
              },
              // Rolled up before the rollup recorded savings (#4069).
              cacheSaving: null,
              hasUnpriced: false,
            },
          ],
          byTool: [],
          priceEntryIds: ["prc_1"],
          rolledUpAt: "2026-09-15T08:59:00.000Z",
          isEstimate: false,
        },
      }),
    );
    const read = await runs.cost(ctx, "tse_4f0a");
    const row = read.ok ? read.value.rollup?.byModel[0] : undefined;
    expect(row?.cacheSaving).toBeNull();
    expect(row?.costByClass?.cacheRead).toEqual(cost("90"));
  });

  it("keeps a rollup that has not run as null, never as a zero (negative)", async () => {
    kernelRead.mockResolvedValue(readOk({ runId: "tse_4f0a", rollup: null, baseline: null }));
    expect(await runs.cost(ctx, "tse_4f0a")).toEqual(
      readOk({ baseline: null, rollup: null, provisional: null }),
    );
  });

  it("maps the agent's baseline, the graded steps and each tool's estimated cost into the view (#3984, #3892)", async () => {
    const usd = (micros: string, basis: "mixed" | "estimated") => ({
      micros,
      currency: "USD",
      basis,
    });
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        baseline: {
          windowDays: 30,
          before: "2026-09-15T08:00:00.000Z",
          runs: 12,
          medianCost: usd("2890000", "mixed"),
          productiveRatio: 0.62,
        },
        rollup: {
          cost: usd("4130000", "mixed"),
          tokens,
          cacheHitRate: 0.9,
          turns: 2,
          steps: 7,
          modelCalls: 4,
          toolCalls: 3,
          retries: 1,
          productiveRatio: 5 / 7,
          advancedSteps: 5,
          unproductiveSteps: 2,
          unproductiveCauses: { failed: 1, repeated: 0, retried: 1 },
          byModel: [],
          byTool: [
            {
              name: "Read",
              calls: 2,
              resultTokens: 60_000,
              cost: usd("300000", "estimated"),
            },
            { name: "Grep", calls: 1, resultTokens: null, cost: null },
          ],
          priceEntryIds: ["prc_1"],
          rolledUpAt: "2026-09-15T08:59:00.000Z",
          isEstimate: false,
        },
      }),
    );
    const read = await runs.cost(ctx, "tse_4f0a");
    if (!read.ok) throw new Error("expected an ok read");
    expect(read.value.baseline).toEqual({
      windowDays: 30,
      before: "2026-09-15T08:00:00.000Z",
      runs: 12,
      medianCost: usd("2890000", "mixed"),
      productiveRatio: 0.62,
    });
    expect(read.value.rollup).toMatchObject({
      advancedSteps: 5,
      unproductiveSteps: 2,
      unproductiveCauses: { failed: 1, repeated: 0, retried: 1 },
    });
    expect(read.value.rollup?.byTool).toEqual([
      {
        name: "Read",
        calls: 2,
        resultTokens: 60_000,
        cost: usd("300000", "estimated"),
      },
      { name: "Grep", calls: 1, resultTokens: null, cost: null },
    ]);
  });

  it("keeps a baseline figure too few runs carry as null, never a zero (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        baseline: {
          windowDays: 30,
          before: "2026-09-15T08:00:00.000Z",
          runs: 3,
          medianCost: null,
          productiveRatio: null,
        },
        rollup: null,
      }),
    );
    const read = await runs.cost(ctx, "tse_4f0a");
    if (!read.ok) throw new Error("expected an ok read");
    expect(read.value.baseline).toEqual({
      windowDays: 30,
      before: "2026-09-15T08:00:00.000Z",
      runs: 3,
      medianCost: null,
      productiveRatio: null,
    });
  });

  it("maps a wrapped run's provisional figures, with each model's cost in the view's money", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        baseline: null,
        rollup: null,
        provisional: {
          byModel: [
            {
              model: "claude-sonnet-5",
              provider: "anthropic",
              calls: 3,
              cost: {
                micros: "2500000",
                currency: "USD",
                basis: "client_attested",
              },
            },
            { model: "gpt-5", provider: null, calls: 1, cost: null },
          ],
          toolCalls: 6,
          asOf: "2026-09-23T10:00:00.000Z",
        },
      }),
    );
    const read = await runs.cost(ctx, "tse_4f0a");
    expect(read.ok && read.value.rollup).toBeNull();
    expect(read.ok && read.value.provisional?.toolCalls).toBe(6);
    expect(read.ok && read.value.provisional?.byModel[0]?.cost).toMatchObject({
      basis: "client_attested",
    });
    expect(read.ok && read.value.provisional?.byModel[1]?.cost).toBeNull();
  });
});

describe("runs.turns", () => {
  const usd = (micros: string) => ({
    micros,
    currency: "USD",
    basis: "client_attested" as const,
  });

  it("reads get_run_turns and keeps each cost's basis and each unreported class as null", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        runId: "tse_4f0a",
        turns: [
          {
            turn: 1,
            seq: "1",
            at: "2026-09-15T08:00:01.000Z",
            frames: 22,
            modelSteps: 4,
            toolSteps: 4,
            cost: usd("121000"),
            cumulativeCost: usd("126000"),
            tokens: { inputUncached: 16, cacheRead: 105 },
          },
          {
            turn: 2,
            seq: "17",
            at: "2026-09-15T08:00:30.000Z",
            frames: 7,
            modelSteps: 2,
            toolSteps: 3,
            cost: null,
            cumulativeCost: usd("126000"),
            tokens: { inputUncached: null, cacheRead: null },
          },
        ],
        complete: false,
        chains: [
          { sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c1d0", turn: 2 },
        ],
      }),
    );
    const read = await runs.turns(ctx, "tse_4f0a");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runTurnsGet,
      input: { runId: "tse_4f0a" },
      page: "run",
    });
    expect(read.ok && read.value.complete).toBe(false);
    // A subagent chain keeps the turn that spawned it (#4001).
    expect(read.ok && read.value.chains).toEqual([
      { sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c1d0", turn: 2 },
    ]);
    expect(read.ok && read.value.turns[0]).toEqual({
      turn: 1,
      seq: "1",
      at: "2026-09-15T08:00:01.000Z",
      frames: 22,
      modelSteps: 4,
      toolSteps: 4,
      cost: usd("121000"),
      cumulativeCost: usd("126000"),
      tokens: { inputUncached: 16, cacheRead: 105 },
    });
    expect(read.ok && read.value.turns[1]?.cost).toBeNull();
    expect(read.ok && read.value.turns[1]?.tokens).toEqual({
      inputUncached: null,
      cacheRead: null,
    });
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

    // A reader that pages the whole run asks for the largest page.
    kernelRead.mockClear();
    await runs.transcript(ctx, "tse_4f0a", "everything", { limit: 500 });
    expect(kernelRead.mock.calls[0]?.[1]).toMatchObject({
      input: { runId: "tse_4f0a", zoom: "everything", kinds: [], limit: 500 },
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

  it("asks for whole bodies and a search when the caller does", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        zoom: "steps",
        kinds: [],
        entries: [],
        cursor: null,
        complete: true,
      }),
    );
    await runs.transcript(ctx, "tse_4f0a", "steps", {
      text: "full",
      query: "retry",
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runTranscriptGet,
      input: {
        runId: "tse_4f0a",
        zoom: "steps",
        kinds: [],
        limit: 200,
        text: "full",
        query: "retry",
      },
      page: "run",
    });
  });

  // ADR-182: every fact the page draws is the server's, carried across as
  // the fold stated it, with the tool_use block's claim and family.
  it("carries what the fold states about each entry, and the run's counts, figures and search", async () => {
    const decision = {
      seq: "3",
      sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c1d0",
      decision: "allow",
      type: "policy_decision",
      source: "bundle",
      harness: false,
      rules: [],
      taint: null,
      at: "2026-09-15T08:56:01.000Z",
    };
    kernelRead.mockResolvedValue(
      readOk({
        zoom: "steps",
        kinds: [],
        entries: [
          {
            seq: "2",
            endSeq: "5",
            subagent: {
              sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c1d0",
              id: null,
              type: "Explore",
              spawnCallId: "toolu_task",
              parentSessionUuid: null,
            },
            at: "2026-09-15T08:56:00.000Z",
            elapsedMs: 4000,
            kind: "tool_call",
            type: "tool_requested",
            label: "Bash",
            callId: "toolu_1",
            kinds: ["tools", "policy"],
            request: null,
            response: {
              seq: "5",
              type: "llm_call",
              digest: null,
              bytesRef: null,
              redactions: [],
              fidelity: "full",
              text: null,
              truncated: false,
              assembly: {
                blocks: [
                  {
                    id: "b0",
                    chars: 4,
                    tokens: 1,
                    partial: false,
                    cost: null,
                    kind: "tool_use",
                    name: "claude_code__Read",
                    input: { file_path: "a.ts" },
                    inputRaw: false,
                    inputFolded: false,
                    callKey: "toolu_2",
                    verdict: null,
                    stepKey: "9",
                    result: { ok: true, summary: "12 lines" },
                    family: "read",
                    tool: "Read",
                  },
                ],
                precis: "",
                stopReason: null,
                ttftMs: null,
                durationMs: null,
                tokensPerSecond: null,
                usage: {
                  inputTokens: null,
                  cacheReadTokens: null,
                  cacheWriteTokens: null,
                  outputTokens: null,
                },
                partial: false,
                wire: { events: 1, bytes: 10 },
              },
            },
            decision,
            frames: 4,
            turn: 1,
            cost: null,
            cumulativeCost: null,
            key: "0192d4a8-7c1e-7a00-8000-00000000c1d0:2",
            parentKey: "1",
            node: "tool",
            quiet: false,
            outcome: "parked",
            error: true,
            approvalId: "apr_7Kq2",
            gates: [decision],
            subject: "claude_code__Bash",
            tool: "Bash",
            family: "shell",
            model: null,
            durationMs: 1200,
            echoOf: null,
            recall: null,
            matches: ["response"],
          },
        ],
        cursor: null,
        complete: true,
        counts: {
          kinds: {
            prompt: 1,
            responses: 0,
            thinking: 0,
            tools: 1,
            policy: 1,
            usage: 0,
            recall: 0,
            seal: 0,
            errors: 0,
          },
          entries: 2,
          errors: 0,
          policy: 1,
          frames: { kinds: { policy: 3, recall: 1 }, policy: 2 },
        },
        figures: {
          steps: { model: 0, tool: 1 },
          prompts: 1,
          calls: {
            count: 1,
            failed: 0,
            tools: [{ name: "Bash", calls: 1 }],
            families: [
              {
                family: "shell",
                calls: 1,
                share: 1,
                ms: 1200,
                failed: 0,
                tools: 1,
              },
            ],
            batches: null,
          },
          wall: { modelMs: 0, toolMs: 1200, waitingMs: 0 },
        },
        search: { query: "lines", matched: 1, unsearched: 0 },
      }),
    );
    const read = await runs.transcript(ctx, "tse_4f0a", "steps");
    if (!read.ok) throw new Error("the read failed");
    const [entry] = read.value.entries;
    expect(entry).toMatchObject({
      key: "0192d4a8-7c1e-7a00-8000-00000000c1d0:2",
      parentKey: "1",
      node: "tool",
      outcome: "parked",
      // Carried as the server stated it, whatever the outcome says: the page
      // marks rows failed by this alone.
      error: true,
      approvalId: "apr_7Kq2",
      subject: "claude_code__Bash",
      tool: "Bash",
      family: "shell",
      durationMs: 1200,
      matches: ["response"],
      gates: [
        {
          seq: "3",
          chainRef: "0192d4a8-7c1e-7a00-8000-00000000c1d0",
          decision: "allow",
          source: "bundle",
          harness: false,
          rules: [],
          taint: null,
        },
      ],
    });
    expect(entry?.response?.blocks?.[0]).toEqual({
      kind: "tool_use",
      name: "claude_code__Read",
      input: { file_path: "a.ts" },
      callKey: "toolu_2",
      stepKey: "9",
      result: { ok: true, summary: "12 lines" },
      family: "read",
      tool: "Read",
    });
    expect(read.value.counts?.policy).toBe(1);
    // The frames' counts at `everything`, carried on a read at `steps`.
    expect(read.value.counts?.frames).toEqual({
      kinds: { policy: 3, recall: 1 },
      policy: 2,
    });
    expect(read.value.figures?.calls.families[0]?.family).toBe("shell");
    expect(read.value.search).toEqual({
      query: "lines",
      matched: 1,
      unsearched: 0,
    });
  });

  it("reads an answer that carried none of the fold's facts as saying nothing (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        zoom: "everything",
        kinds: [],
        entries: [
          {
            seq: "4",
            endSeq: "4",
            at: "2026-09-15T08:56:00.000Z",
            elapsedMs: 0,
            kind: "frame",
            type: "turn_start",
            label: "turn_start",
            callId: null,
            kinds: [],
            request: null,
            response: null,
            decision: null,
            frames: 1,
            turn: 1,
            cost: null,
            cumulativeCost: null,
          },
        ],
        cursor: null,
        complete: true,
      }),
    );
    const read = await runs.transcript(ctx, "tse_4f0a", "everything");
    if (!read.ok) throw new Error("the read failed");
    expect(read.value.entries[0]).toMatchObject({
      key: "4",
      parentKey: null,
      node: null,
      quiet: false,
      outcome: null,
      error: false,
      gates: [],
      matches: [],
    });
    expect(read.value.counts).toBeNull();
    expect(read.value.figures).toBeNull();
    expect(read.value.search).toBeNull();
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
            archiveSegmentDigest: null,
            attestation: null,
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
            archiveSegmentDigest: null,
            attestation: null,
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

  it("carries a signed seal's archive digest and signature, naming the key by reference (#4000)", async () => {
    const signsOver = [
      "run_id",
      "attempt_id",
      "frame_count",
      "merkle_root",
      "archive_segment_digest",
      "enforcement_tier",
      "completeness_gaps",
      "replay_grade",
    ];
    kernelRead.mockResolvedValue(
      readOk({
        runId: "arun_4f0a",
        hashRule: "ledger.event_stream_digest_v1",
        frameCount: 7,
        firstSeq: "1",
        lastSeq: "7",
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
            sealedAt: "2026-09-11T10:05:00.000Z",
            terminalStatus: "completed",
            eventCount: 7,
            finalRunSeq: "7",
            finalEventDigest: `sha256:${"2".repeat(64)}`,
            eventStreamDigest: `sha256:${"2".repeat(64)}`,
            merkleRoot: `sha256:${"2".repeat(64)}`,
            archiveSegmentRef: "runs/arun_4f0a/attempt-1.ndjson.zst",
            archiveSegmentDigest: `sha256:${"3".repeat(64)}`,
            attestation: {
              alg: "ed25519",
              keyId: `sha256:${"4".repeat(64)}`,
              sig: "c2lnbmF0dXJl",
              signsOver,
            },
          },
        ],
        enforcementTier: "gateway",
        recordedGrade: "view",
        ladder: [],
        complete: true,
      }),
    );
    const read = await runs.chain(ctx, "arun_4f0a");
    if (!read.ok) throw new Error("expected an ok read");
    const seal = read.value.seals[0];
    expect(seal?.archiveSegmentDigest).toBe(`sha256:${"3".repeat(64)}`);
    // The contract's `keyId` is a digest, not a public id, so the view names
    // it `keyRef` (INV-11) and carries no `keyId` beside it.
    expect(seal?.attestation).toEqual({
      alg: "ed25519",
      keyRef: `sha256:${"4".repeat(64)}`,
      sig: "c2lnbmF0dXJl",
      signsOver,
    });
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

// A refusal from the kernel seam is the section's answer, passed through
// untouched: the page renders the denial or the named error, never a mapped
// empty value in its place.
describe("a refused read passes through every run read (negative)", () => {
  const refusals = [
    { ok: false, reason: "denied", permission: "workspace.read" },
    readError("frame_store_unreachable", 503),
  ];
  const reads: [string, () => Promise<unknown>][] = [
    ["outcomesSettings", () => runs.outcomesSettings(ctx)],
    ["work", () => runs.work(ctx, "tse_4f0a")],
    ["issues", () => runs.issues(ctx, "tse_4f0a")],
    ["context", () => runs.context(ctx, "tse_4f0a")],
    ["findings", () => runs.findings(ctx, "tse_4f0a")],
    ["get", () => runs.get(ctx, "tse_4f0a", { framesAfter: null })],
    ["cost", () => runs.cost(ctx, "tse_4f0a")],
    ["turns", () => runs.turns(ctx, "tse_4f0a")],
    ["transcript", () => runs.transcript(ctx, "tse_4f0a", "turns")],
    ["outputs", () => runs.outputs(ctx, "tse_4f0a")],
    ["chain", () => runs.chain(ctx, "tse_4f0a")],
  ];
  for (const [name, call] of reads)
    it(`runs.${name}`, async () => {
      for (const refusal of refusals) {
        kernelRead.mockResolvedValueOnce(refusal);
        expect(await call()).toEqual(refusal);
      }
      expect(captureError).not.toHaveBeenCalled();
    });
});

describe("runs.issues", () => {
  const issues = {
    runId: "tse_4f0a",
    issues: [
      {
        ref: "acme/core#12",
        repository: {
          host: "github.com",
          owner: "acme",
          name: "core",
          url: "https://github.com/acme/core",
          connected: true,
        },
        number: 12,
        title: "Retry the upload on a 503",
        status: "open",
        statusRead: "read",
        readAt: "2026-09-15T08:59:00.000Z",
        relation: "task",
        resolvedBy: [],
        actions: ["viewed"],
        edge: "stated",
        frameSeqs: ["4"],
        url: "https://github.com/acme/core/issues/12",
      },
      {
        ref: "#7",
        repository: null,
        number: 7,
        title: null,
        status: null,
        statusRead: "repository_unknown",
        readAt: null,
        relation: "referenced",
        resolvedBy: [],
        actions: ["mentioned"],
        edge: "observed",
        frameSeqs: ["9"],
        url: null,
      },
    ],
    complete: false,
    warnings: ["issue_frame_limit"],
  };

  it("reads get_run_issues for the run and carries each issue as the contract wrote it", async () => {
    kernelRead.mockResolvedValue(readOk(issues));
    expect(await runs.issues(ctx, "tse_4f0a")).toEqual(readOk(issues));
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runIssuesGet,
      input: { runId: "tse_4f0a" },
      page: "run",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for an issue the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ ...issues, issues: [{ ...issues.issues[0], edge: "inferred" }] }),
    );
    expect(await runs.issues(ctx, "tse_4f0a")).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("runs.context", () => {
  const out = {
    runId: "tse_4f0a",
    source: "wrapped",
    windows: [
      {
        seq: "12",
        responseSeq: "12",
        modelCallId: "req_12",
        provider: "anthropic",
        model: "claude-opus-5",
        promptTokens: 1000,
        bytes: 2000,
        blocks: [
          { kind: "system", bytes: 200, items: 1, tokens: 100 },
          { kind: "conversation", bytes: 1800, items: 9, tokens: 900 },
        ],
      },
    ],
    unmeasured: 2,
    assemblies: [
      {
        seq: "0",
        budgetTokens: 2000,
        spentTokens: 1102,
        included: 14,
        cut: 24,
        textDigest: null,
      },
    ],
    complete: true,
  };

  it("reads get_run_context for the run and names the call by reference, not by id", async () => {
    kernelRead.mockResolvedValue(readOk(out));
    const read = await runs.context(ctx, "tse_4f0a");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runContextGet,
      input: { runId: "tse_4f0a" },
      page: "run",
    });
    expect(read).toEqual(
      readOk({
        source: "wrapped",
        windows: [
          {
            seq: "12",
            responseSeq: "12",
            callRef: "req_12",
            provider: "anthropic",
            model: "claude-opus-5",
            promptTokens: 1000,
            bytes: 2000,
            blocks: out.windows[0]?.blocks,
          },
        ],
        unmeasured: 2,
        assemblies: out.assemblies,
        complete: true,
      }),
    );
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a window the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        ...out,
        windows: [{ ...out.windows[0], blocks: [] }],
      }),
    );
    expect(await runs.context(ctx, "tse_4f0a")).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("runs.findings", () => {
  const finding = {
    id: "fnd_7k2m9q",
    kind: "repeated_shell_commands",
    level: "tool",
    subject: "Bash",
    saving: { micros: "1250000", currency: "USD", basis: "gateway_observed" },
    confidence: "high",
    window: {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-15T00:00:00.000Z",
    },
    why: "The same command ran twice with the same result.",
    fix: "Reuse the earlier result.",
    runs: 1,
    calls: 3,
    status: "open",
    detectedAt: "2026-09-15T01:00:00.000Z",
    decidedAt: null,
    appliedActionId: null,
  };
  const page = (findings: unknown[]) => ({
    status: "open",
    window: null,
    saving: null,
    spend: null,
    share: null,
    annualised: null,
    counts: { findings: findings.length, high: 0, medium: 0, operators: 0 },
    findings,
  });

  it("reads the open findings that cite the run, with the frames each cites there (#4001)", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        page([
          {
            ...finding,
            citation: {
              runId: "tse_4f0a",
              runLevel: false,
              frames: [
                { seq: "12" },
                {
                  seq: "4",
                  sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c1d0",
                },
              ],
              framesTotal: 3,
            },
          },
        ]),
      ),
    );
    const read = await runs.findings(ctx, "tse_4f0a");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: findingList,
      input: { status: "open", runId: "tse_4f0a" },
      page: "run",
    });
    if (!read.ok) throw new Error("expected an ok read");
    expect(read.value.findings).toEqual([
      {
        id: "fnd_7k2m9q",
        kind: "repeated_shell_commands",
        subject: "Bash",
        saving: {
          micros: "1250000",
          currency: "USD",
          basis: "gateway_observed",
        },
        confidence: "high",
        citation: {
          runLevel: false,
          frames: [
            { seq: "12" },
            { seq: "4", sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c1d0" },
          ],
          framesTotal: 3,
        },
      },
    ]);
  });

  it("keeps a finding written before frames were cited as not cited, and leaves out one with no citation (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        page([
          {
            ...finding,
            citation: {
              runId: "tse_4f0a",
              runLevel: false,
              frames: null,
              framesTotal: 0,
            },
          },
          { ...finding, id: "fnd_uncited" },
        ]),
      ),
    );
    const read = await runs.findings(ctx, "tse_4f0a");
    if (!read.ok) throw new Error("expected an ok read");
    expect(read.value.findings).toHaveLength(1);
    expect(read.value.findings[0]?.citation.frames).toBeNull();
  });
});

describe("runs.outcomesSettings", () => {
  const policy = {
    customerEnabled: true,
    platformDisabled: true,
    platformDisabledReason: "outcome scoring is paused platform-wide",
    effectiveEnabled: false,
  };

  it("reads get_run_outcomes_settings and carries the policy as recorded", async () => {
    kernelRead.mockResolvedValue(readOk(policy));
    expect(await runs.outcomesSettings(ctx)).toEqual(readOk(policy));
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runOutcomesSettingsGet,
      input: {},
      page: "run",
    });
  });

  it("answers record_unmappable and reports once for a policy the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(readOk({ ...policy, effectiveEnabled: "no" }));
    expect(await runs.outcomesSettings(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      context: "runs.outcomesSettings record_unmappable",
    });
  });
});

describe("runs.work", () => {
  const repository = {
    host: "github.com",
    owner: "acme",
    name: "core",
    url: "https://github.com/acme/core",
    connected: true,
  };
  const work = {
    runId: "tse_4f0a",
    machine: { name: "tycho" },
    checkouts: [
      {
        id: "chk_1",
        path: "/work/core",
        branch: "release/3.2",
        headSha: "abc123",
        remoteDigest: null,
        repository,
        firstSeq: "1",
        lastSeq: "9",
      },
    ],
    diffs: [
      {
        checkoutId: "chk_1",
        seq: "7",
        baseSha: "abc000",
        headSha: "abc123",
        digest: "sha256:d1",
        bodyAvailable: false,
        completeness: "not_retained",
        limitations: [],
        observedAt: "2026-09-15T08:57:00.000Z",
      },
    ],
    pullRequests: [
      {
        repository,
        number: 482,
        url: "https://github.com/acme/core/pull/482",
        title: "Cut the 3.2 release",
        state: "open",
        headSha: "abc123",
        headRef: "release/3.2",
        baseRef: "main",
        association: "recorded",
        closingIssues: null,
        checkoutIds: ["chk_1"],
        observedAt: "2026-09-15T08:58:00.000Z",
        current: true,
        ci: null,
        diff: null,
      },
    ],
    // `get_run_work` always sends this array, empty for a ledger run
    // (`run.work.get.ts`, `subagents`). The adapter maps it unguarded, so a
    // fixture that omits it tests a shape the wire never sends.
    subagents: [
      {
        id: "a0182b6cd3a21d284",
        type: "Explore",
        firstSeq: "12",
        lastSeq: "30",
        stopped: true,
      },
    ],
    complete: true,
    warnings: [],
  };

  it("reads get_run_work and renames the wire's checkout ids to the view's refs", async () => {
    kernelRead.mockResolvedValue(readOk(work));
    const read = await runs.work(ctx, "tse_4f0a");
    if (!read.ok) throw new Error("expected an ok read");
    expect(read.value.checkouts[0]).toMatchObject({
      ref: "chk_1",
      path: "/work/core",
    });
    expect(read.value.checkouts[0]).not.toHaveProperty("id");
    expect(read.value.diffs[0]).toMatchObject({ checkoutRef: "chk_1" });
    expect(read.value.diffs[0]).not.toHaveProperty("checkoutId");
    expect(read.value.pullRequests[0]).toMatchObject({
      number: 482,
      checkoutRefs: ["chk_1"],
    });
    expect(read.value.pullRequests[0]).not.toHaveProperty("checkoutIds");
    // A subagent's id is the harness's own, so the view names it a ref (INV-11).
    expect(read.value.subagents?.[0]).toMatchObject({
      agentRef: "a0182b6cd3a21d284",
      type: "Explore",
    });
    expect(read.value.subagents?.[0]).not.toHaveProperty("id");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runWorkGet,
      input: { runId: "tse_4f0a" },
      page: "run",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(readOk({ ...work, runId: "not a run id" }));
    expect(await runs.work(ctx, "tse_4f0a")).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("runs.outputs", () => {
  const node = {
    seq: "7",
    kind: "file",
    name: "packages/core/package.json",
    nameIsLocator: false,
    where: "/work/core",
    state: "written",
    note: null,
    stat: { added: 1, removed: 1 },
    observedAt: "2026-09-15T08:57:00.000Z",
    digestBefore: "sha256:b",
    digestAfter: "sha256:a",
  };
  const outputs = {
    source: "wrapped",
    nodes: [node],
    tally: { artifacts: 1, reads: 0, gates: 0 },
    complete: false,
  };

  it("reads get_run_outputs and maps the spine, keeping a capped read marked incomplete", async () => {
    kernelRead.mockResolvedValue(readOk(outputs));
    expect(await runs.outputs(ctx, "tse_4f0a")).toEqual(readOk(outputs));
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runOutputsGet,
      input: { runId: "tse_4f0a" },
      page: "run",
    });
  });

  it("answers record_unmappable and reports once for a node the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ ...outputs, nodes: [{ ...node, name: "" }] }),
    );
    expect(await runs.outputs(ctx, "tse_4f0a")).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
