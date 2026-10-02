import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readPolicy, chSelect, getBody, runInTenantScope } = vi.hoisted(() => ({
  readPolicy: vi.fn(),
  chSelect: vi.fn(),
  getBody: vi.fn(),
  runInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@oxagen/database", () => ({
  schema: {},
  withSystemDb: vi.fn((fn: (tx: unknown) => unknown) => fn({ tx: true })),
  readLatestRetentionPolicy: readPolicy,
}));
vi.mock("@oxagen/telemetry", () => ({
  chSelect,
  readTachoToolCallObservations: vi.fn(),
  readTachoFileChanges: vi.fn(),
  readModelCallFrames: vi.fn(),
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope }));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({ getBody }),
  parseEvidenceBodyRef: (ref: string) =>
    ref.startsWith("foreign") ? null : { keyId: "k", digestHex: ref },
}));
vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import type { ToolCallObservationRow } from "@oxagen/telemetry";
import { ZERO_TOKENS, type RunTotalsRecord } from "./cost-rollup";
import {
  resultUseKey,
  type FindingDraft,
  type ResultUseRead,
  type ToolCallObservation,
} from "./findings";
import {
  readResultUse,
  RESULT_USE_CHAIN_FRAMES_MAX,
  resultTextMode,
} from "./findings-result-use";
import { runFindingsPass } from "./findings-store";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const S_A = "00000000-0000-4000-8000-0000000000aa";
const S_B = "00000000-0000-4000-8000-0000000000bb";
const S_SUB = "00000000-0000-4000-8000-0000000000cc";
const RUN_A = "tse_000000000000000000000a";
const RUN_B = "tse_000000000000000000000b";
const ROOTS = new Map([
  [RUN_A, S_A],
  [RUN_B, S_B],
]);
const LINE = "export function chainVerdicts(frames: readonly ChainFrame[]) {";
const OTHER =
  "A listing of every file the agent never opened again, at length.";

/** A frame's time `s` seconds into the minute, as the store prints it. */
const at = (s: number) =>
  `2026-09-10T10:00:${String(s).padStart(2, "0")}.000000Z`;

/** A large result of `tokens`, `s` seconds into the minute, on `chain` (the run's own when null). */
function result(
  runId: string,
  s: number,
  tokens: number,
  chain: string | null = null,
): ToolCallObservation {
  const time = new Date(Date.UTC(2026, 8, 10, 10, 0, s));
  return {
    runId,
    at: time,
    atMicros: time.getTime() * 1000,
    seq: s,
    tool: "mcp__docs__search",
    inputDigest: `in-${s}`,
    outputDigest: `out-${s}`,
    isMutating: false,
    resultTokens: tokens,
    sessionUuid: chain,
  };
}

interface StepRow {
  seq: string;
  at: string;
  kind: string;
  source: string;
  content_digest: string;
  bytes_ref: string;
}

const bytes = new Map<string, Uint8Array | Error>();

/** A frame row at `s` seconds whose body is `text`, stored under `ref-<s>`. */
function step(s: number, kind: string, source: string, text: string): StepRow {
  const body = new TextEncoder().encode(text);
  bytes.set(`ref-${s}`, body);
  return {
    seq: String(s),
    at: at(s),
    kind,
    source,
    content_digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    bytes_ref: `ref-${s}`,
  };
}

const call = (s: number, input: unknown, output?: unknown) =>
  step(s, "tool_call", "hook", JSON.stringify({ input, output }));
const said = (s: number, text: string) =>
  step(s, "llm_call", "transcript", text);

beforeEach(() => {
  readPolicy.mockReset();
  chSelect.mockReset();
  getBody.mockReset();
  bytes.clear();
  getBody.mockImplementation(async (_scope: unknown, ref: string) => {
    const body = bytes.get(ref);
    if (body === undefined || body instanceof Error)
      throw body ?? new Error(`no body ${ref}`);
    return { bytes: body, contentType: "text/plain", digestHex: "" };
  });
  readPolicy.mockResolvedValue(undefined);
});

describe("resultTextMode", () => {
  it.each([
    ["no policy", undefined, "content_exact"],
    [
      "a policy that keeps tool and model text",
      {
        mode: "content_exact",
        retainedContentClasses: ["tool_call", "model_call"],
      },
      "content_exact",
    ],
    [
      "a policy that keeps tool text alone",
      { mode: "content_exact", retainedContentClasses: ["tool_call"] },
      "digest_only",
    ],
    [
      "a policy that keeps model text alone",
      { mode: "content_exact", retainedContentClasses: ["model_call"] },
      "digest_only",
    ],
    [
      "a digest_only policy",
      {
        mode: "digest_only",
        retainedContentClasses: ["tool_call", "model_call"],
      },
      "digest_only",
    ],
  ])("reads %s as %s", async (_name, policy, mode) => {
    readPolicy.mockResolvedValue(policy);
    await expect(resultTextMode(SCOPE)).resolves.toBe(mode);
  });
});

describe("readResultUse", () => {
  it("reads nothing on a digest_only workspace", async () => {
    readPolicy.mockResolvedValue({
      mode: "digest_only",
      retainedContentClasses: [],
    });
    const read = await readResultUse(SCOPE, [result(RUN_A, 2, 9_000)], ROOTS);
    expect(read).toEqual({ mode: "digest_only", verdicts: new Map() });
    expect(chSelect).not.toHaveBeenCalled();
    expect(getBody).not.toHaveBeenCalled();
  });

  it("tells a result a later call quoted from one no step quoted", async () => {
    const quoted = result(RUN_A, 2, 9_000);
    const ignored = result(RUN_A, 4, 8_000);
    chSelect.mockResolvedValue({
      data: [
        call(2, { query: "chain verdicts" }, { content: LINE }),
        call(3, { old_string: LINE }),
        call(4, { query: "files" }, { content: OTHER }),
        // A proxy's llm_call holds the whole request, so the query leaves it
        // out. The agent's own text quotes neither result.
        said(5, "Both reads are done."),
        step(6, "turn_end", "hook", "Done."),
      ],
    });
    const read = await readResultUse(SCOPE, [quoted, ignored], ROOTS);
    expect(read.mode).toBe("content_exact");
    expect(read.verdicts).toEqual(
      new Map([
        [resultUseKey(quoted), "used"],
        [resultUseKey(ignored), "unused"],
      ]),
    );
    expect(chSelect).toHaveBeenCalledTimes(1);
    expect(chSelect.mock.calls[0]![0].params).toEqual({
      root: S_A,
      chain: S_A,
      from: "2026-09-10 10:00:02.000",
      limit: RESULT_USE_CHAIN_FRAMES_MAX + 1,
    });
    expect(getBody).toHaveBeenCalledTimes(5);
  });

  it("reads a subagent's result on the subagent's own chain", async () => {
    chSelect.mockResolvedValue({ data: [] });
    await readResultUse(SCOPE, [result(RUN_A, 2, 9_000, S_SUB)], ROOTS);
    expect(chSelect.mock.calls[0]![0].params).toMatchObject({
      root: S_A,
      chain: S_SUB,
    });
  });

  it("reads the chain whose results add the most tokens first", async () => {
    chSelect.mockResolvedValue({ data: [] });
    await readResultUse(
      SCOPE,
      [result(RUN_A, 2, 9_000), result(RUN_B, 2, 30_000)],
      ROOTS,
    );
    expect(chSelect.mock.calls.map((c) => c[0].params.root)).toEqual([
      S_B,
      S_A,
    ]);
  });

  it("gives no verdict to a result before a body that is gone for good", async () => {
    const quoted = result(RUN_A, 2, 9_000);
    const rows = [
      call(2, {}, { content: LINE }),
      call(3, { command: "ls" }),
      said(4, "Done."),
    ];
    bytes.set(
      "ref-3",
      Object.assign(new Error("gone"), { name: "BodyKeyGoneError" }),
    );
    chSelect.mockResolvedValue({ data: rows });
    const read = await readResultUse(SCOPE, [quoted], ROOTS);
    expect(read.verdicts).toEqual(new Map());
  });

  it("gives no verdict to a result whose body the control plane did not keep", async () => {
    const quoted = result(RUN_A, 2, 9_000);
    chSelect.mockResolvedValue({
      data: [
        { ...call(2, {}, { content: LINE }), bytes_ref: "" },
        said(3, "Done."),
      ],
    });
    const read = await readResultUse(SCOPE, [quoted], ROOTS);
    expect(read.verdicts).toEqual(new Map());
    expect(getBody).toHaveBeenCalledTimes(1);
  });

  it("fails the read on a body failure that a retry can change", async () => {
    // Build the rows first: each one stores its own body under its ref, so
    // the failure must replace the stored body after the row is built.
    const rows = [call(2, {}, { content: LINE }), said(3, "Done.")];
    bytes.set("ref-3", new Error("connection reset"));
    chSelect.mockResolvedValue({ data: rows });
    await expect(
      readResultUse(SCOPE, [result(RUN_A, 2, 9_000)], ROOTS),
    ).rejects.toThrow("connection reset");
  });

  it("checks no chain that holds more frames than the cap", async () => {
    chSelect.mockResolvedValue({
      data: Array.from({ length: RESULT_USE_CHAIN_FRAMES_MAX + 1 }, (_, i) =>
        said(i, "x"),
      ),
    });
    const read = await readResultUse(SCOPE, [result(RUN_A, 2, 9_000)], ROOTS);
    expect(read.verdicts).toEqual(new Map());
    expect(getBody).not.toHaveBeenCalled();
  });
});

function pricedRun(runId: string): RunTotalsRecord {
  const tokens = { ...ZERO_TOKENS, input_uncached: 3_000 };
  return {
    runId,
    runSource: "tacho",
    ...SCOPE,
    operatorPrincipalId: null,
    operatorKey: "prn_0123456789abcdefghjkmn",
    agentPrincipalId: null,
    agentKey: "acme.core.triage",
    taskRef: null,
    costCenter: null,
    startedAt: new Date("2026-09-10T09:00:00.000Z"),
    sealedAt: null,
    turns: 1,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 1,
    modelCalls: 1,
    toolCalls: 1,
    tokens,
    costMicros: 9_000n,
    currency: "USD",
    costBasis: "gateway_observed",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: {
      models: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 1,
          tokens,
          costMicros: 9_000n,
          costByClass: {
            input_uncached: 9_000n,
            cache_read: 0n,
            cache_write_5m: 0n,
            cache_write_1h: 0n,
            output: 0n,
            reasoning: 0n,
            server_tool_request: 0n,
          },
          cacheSavingMicros: 0n,
          basis: "gateway_observed",
          hasUnpriced: false,
        },
      ],
      tools: [],
      steps: null,
    },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
  };
}

describe("result use in a pass", () => {
  // A 25,000-token result on a run whose frames were not read is priced once
  // at the run's input price, 3 micros a token, against a 4,000-token page.
  const row: ToolCallObservationRow = {
    rootSessionUuid: S_A,
    sessionUuid: S_A,
    at: "2026-09-10T10:00:02.000000Z",
    seq: 2,
    tool: "mcp__docs__search",
    inputDigest: "in",
    outputDigest: "out",
    isMutating: false,
    resultTokens: 25_000,
    status: "ok",
    errorClass: null,
  };

  async function pass(verdict: "used" | "unused") {
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const readResultUse = vi.fn(
      async (
        _scope: unknown,
        results: readonly ToolCallObservation[],
        _roots: ReadonlyMap<string, string>,
      ): Promise<ResultUseRead> => ({
        mode: "content_exact",
        verdicts: new Map(results.map((c) => [resultUseKey(c), verdict])),
      }),
    );
    await runFindingsPass(SCOPE, {
      now: () => new Date("2026-09-15T00:00:00.000Z"),
      readRuns: async () => [pricedRun(RUN_A)],
      readRootSessions: async () => new Map([[S_A, RUN_A]]),
      readToolCalls: async () => [row],
      readFrames: async () => new Map(),
      readDecisions: async () => new Map(),
      readResultUse,
      write,
    });
    return { write, readResultUse };
  }

  it("hands the store the large result and its run's root", async () => {
    const { readResultUse } = await pass("unused");
    expect(readResultUse).toHaveBeenCalledTimes(1);
    const [scope, results, roots] = readResultUse.mock.calls[0]!;
    expect(scope).toEqual(SCOPE);
    expect(results.map((c) => [c.runId, c.seq, c.sessionUuid])).toEqual([
      [RUN_A, 2, null],
    ]);
    expect(roots).toEqual(new Map([[RUN_A, S_A]]));
  });

  it("writes the finding for a result no later step quoted, and none for one a later step quoted", async () => {
    const unpaged = (write: Awaited<ReturnType<typeof pass>>["write"]) =>
      (write.mock.calls[0]?.[3] ?? []).filter(
        (d) => d.kind === "unpaged_results",
      );
    const unused = await pass("unused");
    expect(unpaged(unused.write)).toEqual([
      expect.objectContaining({
        savingMicros: 63_000n,
        evidence: expect.objectContaining({
          resultUse: expect.objectContaining({
            mode: "content_exact",
            unused: { results: 1, reads: 1, pageSavingMicros: "63000" },
          }),
        }),
      }),
    ]);
    const used = await pass("used");
    expect(unpaged(used.write)).toEqual([]);
  });
});
