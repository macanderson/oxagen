import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readPolicy, chSelect, getBody, runInTenantScope, warn, error } =
  vi.hoisted(() => ({
    readPolicy: vi.fn(),
    chSelect: vi.fn(),
    getBody: vi.fn(),
    runInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
    warn: vi.fn(),
    error: vi.fn(),
  }));

vi.mock("@oxagen/database", () => ({
  schema: {},
  withSystemDb: vi.fn((fn: (tx: unknown) => unknown) => fn({ tx: true })),
  readLatestRetentionPolicy: readPolicy,
}));
vi.mock("@oxagen/telemetry", () => ({
  chSelect,
  readTachoToolCallObservations: vi.fn(),
  readModelCallFrames: vi.fn(),
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope }));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({ getBody }),
  // A ref this store cannot read starts with "foreign".
  parseEvidenceBodyRef: (ref: string) =>
    ref.startsWith("foreign") ? null : { keyId: "k", digestHex: ref },
}));
vi.mock("./logger", () => ({ logger: { warn, error, info: vi.fn() } }));

import { ZERO_TOKENS, type RunTotalsRecord } from "./cost-rollup";
import {
  microsOf,
  type PricedRequestFrame,
  type SpendProposalInput,
} from "./findings";
import {
  PROMPT_BODIES_MAX,
  PROMPT_READ_MAX,
  promptTextMode,
  readRunPrompts,
} from "./findings-prompts";
import { runFindingsPass } from "./findings-store";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const WINDOW = {
  start: new Date("2026-08-16T00:00:00.000Z"),
  end: new Date("2026-09-15T00:00:00.000Z"),
};
const S_A = "00000000-0000-4000-8000-0000000000aa";
const S_B = "00000000-0000-4000-8000-0000000000bb";
const S_C = "00000000-0000-4000-8000-0000000000cc";
const S_D = "00000000-0000-4000-8000-0000000000dd";
const S_X = "00000000-0000-4000-8000-0000000000ee";
const RUN_A = "tse_000000000000000000000a";
const RUN_B = "tse_000000000000000000000b";
const RUN_C = "tse_000000000000000000000c";
const RUN_D = "tse_000000000000000000000d";
const BY_SESSION = new Map([
  [S_A, RUN_A],
  [S_B, RUN_B],
  [S_C, RUN_C],
  [S_D, RUN_D],
]);
const TESTS = "Run the unit tests before you open a pull request.";

interface Row {
  root_session_uuid: string;
  seq: string | number;
  at: string;
  prompt_digest: string;
  prompt_length: string | number | null;
  content_digest: string;
  bytes_ref: string;
}

function row(over: Partial<Row> = {}): Row {
  return {
    root_session_uuid: S_A,
    seq: "1",
    at: "2026-09-10T10:00:00.000000Z",
    prompt_digest: "sha256:prompt",
    prompt_length: "80",
    content_digest: "",
    bytes_ref: "",
    ...over,
  };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
const digestOf = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A row whose body is `text`, stored under `ref` with a matching digest. */
function withBody(ref: string, text: string, over: Partial<Row> = {}): Row {
  return row({ bytes_ref: ref, content_digest: digestOf(bytesOf(text)), ...over });
}

/** An error carrying `name`, as the storage driver and evidence store throw. */
function failure(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function bodies(byRef: Record<string, Uint8Array | Error>) {
  getBody.mockImplementation(async (_scope: unknown, ref: string) => {
    const body = byRef[ref];
    if (body === undefined || body instanceof Error)
      throw body ?? new Error(`no body ${ref}`);
    return { bytes: body, contentType: "text/plain", digestHex: "" };
  });
}

function pricedRun(runId: string): RunTotalsRecord {
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
    startedAt: new Date("2026-09-01T00:00:00.000Z"),
    sealedAt: null,
    turns: 1,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 1,
    modelCalls: 1,
    toolCalls: 0,
    tokens: { ...ZERO_TOKENS, input_uncached: 3_000 },
    costMicros: 9_000n,
    currency: "USD",
    costBasis: "gateway_observed",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: { models: [], tools: [], steps: null },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
  };
}

beforeEach(() => {
  readPolicy.mockReset();
  chSelect.mockReset();
  getBody.mockReset();
  runInTenantScope.mockClear();
  warn.mockReset();
  error.mockReset();
});

describe("promptTextMode", () => {
  it("reads prompt text when the workspace pinned no policy", async () => {
    readPolicy.mockResolvedValue(undefined);
    await expect(promptTextMode(SCOPE)).resolves.toBe("content_exact");
    expect(readPolicy).toHaveBeenCalledWith(
      { tx: true },
      SCOPE.orgId,
      SCOPE.workspaceId,
    );
  });

  it("reads prompt text when the policy keeps model_call bodies", async () => {
    readPolicy.mockResolvedValue({
      mode: "content_exact",
      retainedContentClasses: ["model_call", "tool_output"],
    });
    await expect(promptTextMode(SCOPE)).resolves.toBe("content_exact");
  });

  it("reads digests only when the policy leaves out model_call", async () => {
    readPolicy.mockResolvedValue({
      mode: "content_exact",
      retainedContentClasses: ["tool_output"],
    });
    await expect(promptTextMode(SCOPE)).resolves.toBe("digest_only");
  });

  it("reads digests only on a digest_only policy", async () => {
    readPolicy.mockResolvedValue({
      mode: "digest_only",
      retainedContentClasses: ["model_call"],
    });
    await expect(promptTextMode(SCOPE)).resolves.toBe("digest_only");
  });
});

describe("readRunPrompts", () => {
  it("reads the window's run-chain prompts in the workspace's tenant scope", async () => {
    readPolicy.mockResolvedValue({ mode: "digest_only", retainedContentClasses: [] });
    chSelect.mockResolvedValue({ data: [] });
    const readFrames = vi.fn();
    const read = await readRunPrompts(
      SCOPE,
      WINDOW,
      BY_SESSION,
      new Set([RUN_A]),
      readFrames,
    );
    expect(read).toEqual({ mode: "digest_only", prompts: [], frames: new Map() });
    expect(readFrames).not.toHaveBeenCalled();
    expect(runInTenantScope).toHaveBeenCalledWith(SCOPE, expect.any(Function));
    const [{ query, params }] = chSelect.mock.calls[0]! as [
      { query: string; params: Record<string, unknown> },
    ];
    expect(query).toContain("FROM tacho_events FINAL");
    expect(query).toContain("kind = 'turn_start'");
    expect(query).toContain("session_uuid = root_session_uuid");
    expect(query).toContain("command_name = ''");
    expect(params).toEqual({
      from: "2026-08-16 00:00:00.000",
      to: "2026-09-15 00:00:00.000",
      limit: PROMPT_READ_MAX,
    });
  });

  it("keeps digests on a digest_only workspace and prices a whole-prompt repeat on its run's own chain", async () => {
    readPolicy.mockResolvedValue({ mode: "digest_only", retainedContentClasses: [] });
    chSelect.mockResolvedValue({
      data: [
        row({ seq: "3", at: "2026-09-10T10:05:00.123456Z", prompt_digest: "sha256:same", bytes_ref: "ref1", content_digest: "sha256:x" }),
        row({ seq: "1", at: "2026-09-10T10:00:00.000000Z", prompt_digest: "sha256:first", prompt_length: 50 }),
        row({ root_session_uuid: S_B, at: "2026-09-10T09:00:00.000000Z", prompt_digest: "sha256:same" }),
        row({ root_session_uuid: S_X, prompt_digest: "sha256:same" }),
        row({ root_session_uuid: S_D, prompt_digest: "sha256:same" }),
      ],
    });
    const frames = new Map<string, PricedRequestFrame[]>([[RUN_A, []]]);
    const readFrames = vi.fn(async () => frames);
    const read = await readRunPrompts(
      SCOPE,
      WINDOW,
      BY_SESSION,
      new Set([RUN_A, RUN_B]),
      readFrames,
    );
    expect(getBody).not.toHaveBeenCalled();
    expect(read.mode).toBe("digest_only");
    expect(read.prompts).toEqual([
      {
        runId: RUN_A,
        seq: 3,
        at: new Date("2026-09-10T10:05:00.123Z"),
        atMicros: microsOf("2026-09-10T10:05:00.123456Z"),
        digest: "sha256:same",
        length: 80,
        text: null,
      },
      expect.objectContaining({ runId: RUN_A, seq: 1, length: 50 }),
      expect.objectContaining({ runId: RUN_B, digest: "sha256:same" }),
    ]);
    expect(readFrames).toHaveBeenCalledWith(SCOPE, [
      {
        runId: RUN_A,
        ref: { kind: "tacho", rootSessionUuid: S_A, sessionUuids: [S_A] },
      },
    ]);
    expect(read.frames).toBe(frames);
  });

  it("reads a body only when it matches its digest and decodes as UTF-8", async () => {
    readPolicy.mockResolvedValue(undefined);
    const notUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    bodies({
      good: bytesOf(TESTS),
      altered: bytesOf("Something else entirely."),
      binary: notUtf8,
      gone: failure("StorageNotFoundError"),
      erased: failure("BodyKeyGoneError"),
      damaged: failure("BodyUnopenableError"),
      malformed: new RangeError("frame body plaintext too short"),
    });
    chSelect.mockResolvedValue({
      data: [
        withBody("good", TESTS, { seq: 1, prompt_length: "42" }),
        row({ seq: 2, bytes_ref: "altered", content_digest: digestOf(bytesOf(TESTS)), prompt_length: null }),
        row({ seq: 3, bytes_ref: "binary", content_digest: digestOf(notUtf8), prompt_length: "n/a" }),
        row({ seq: 4, bytes_ref: "", content_digest: "sha256:none" }),
        row({ seq: 5, bytes_ref: "gone", content_digest: "sha256:none" }),
        row({ seq: 6, bytes_ref: "erased", content_digest: "sha256:none" }),
        row({ seq: 7, bytes_ref: "damaged", content_digest: "sha256:none" }),
        row({ seq: 8, bytes_ref: "malformed", content_digest: "sha256:none" }),
        row({ seq: 9, bytes_ref: "foreign:1", content_digest: "sha256:none" }),
      ],
    });
    const readFrames = vi.fn();
    const read = await readRunPrompts(
      SCOPE,
      WINDOW,
      BY_SESSION,
      new Set([RUN_A]),
      readFrames,
    );
    expect(read.mode).toBe("content_exact");
    expect(read.prompts.map((p) => [p.seq, p.text, p.length])).toEqual([
      [1, TESTS, 42],
      [2, null, null],
      [3, null, null],
      [4, null, 80],
      [5, null, 80],
      [6, null, 80],
      [7, null, 80],
      [8, null, 80],
      [9, null, 80],
    ]);
    expect(getBody).toHaveBeenCalledTimes(7);
    expect(getBody).toHaveBeenCalledWith(SCOPE, "good");
    expect(getBody).not.toHaveBeenCalledWith(SCOPE, "foreign:1");
    expect(readFrames).not.toHaveBeenCalled();
  });

  it("fails the read when a body read fails for a reason that can pass", async () => {
    readPolicy.mockResolvedValue(undefined);
    bodies({
      good: bytesOf(TESTS),
      broken: new TypeError("fetch failed"),
    });
    chSelect.mockResolvedValue({
      data: [
        withBody("good", TESTS, { seq: 1 }),
        row({ seq: 2, bytes_ref: "broken", content_digest: "sha256:none" }),
      ],
    });
    await expect(
      readRunPrompts(SCOPE, WINDOW, BY_SESSION, new Set([RUN_A]), vi.fn()),
    ).rejects.toThrow("fetch failed");
  });

  it(`reads at most ${PROMPT_BODIES_MAX} bodies, newest first`, async () => {
    readPolicy.mockResolvedValue(undefined);
    bodies({ body: bytesOf("Keep the diff small.") });
    chSelect.mockResolvedValue({
      data: Array.from({ length: PROMPT_BODIES_MAX + 3 }, (_, i) =>
        withBody("body", "Keep the diff small.", { seq: i + 1 }),
      ),
    });
    const read = await readRunPrompts(
      SCOPE,
      WINDOW,
      BY_SESSION,
      new Set([RUN_A]),
      vi.fn(async () => new Map()),
    );
    expect(getBody).toHaveBeenCalledTimes(PROMPT_BODIES_MAX);
    expect(read.prompts[PROMPT_BODIES_MAX - 1]!.text).toBe("Keep the diff small.");
    expect(read.prompts[PROMPT_BODIES_MAX]!.text).toBeNull();
  });
});

describe("the findings pass with prompts", () => {
  const baseDeps = (runs: RunTotalsRecord[]) => ({
    now: () => WINDOW.end,
    readRuns: async () => runs,
    readRootSessions: async () => BY_SESSION,
    readToolCalls: async () => [],
    readFrames: async () => new Map(),
    readDecisions: async () => new Map(),
    write: vi.fn(async () => 0),
  });

  it("opens one proposal for an instruction three runs received", async () => {
    const runs = [pricedRun(RUN_A), pricedRun(RUN_B), pricedRun(RUN_C)];
    const at = (m: number) => new Date(Date.UTC(2026, 8, 10, 10, m));
    const readPrompts = vi.fn(async () => ({
      mode: "content_exact" as const,
      prompts: runs.map((r, i) => ({
        runId: r.runId,
        seq: 1,
        at: at(i),
        digest: `sha256:${i}`,
        length: TESTS.length,
        text: TESTS,
      })),
      frames: new Map(),
    }));
    const openProposals = vi.fn(async () => undefined);
    await runFindingsPass(SCOPE, {
      ...baseDeps(runs),
      readPrompts,
      openProposals,
    });
    expect(readPrompts).toHaveBeenCalledWith(
      SCOPE,
      { start: WINDOW.start, end: WINDOW.end },
      BY_SESSION,
      new Set([RUN_A, RUN_B, RUN_C]),
    );
    const [, input] = openProposals.mock.calls[0]! as unknown as [
      unknown,
      SpendProposalInput,
    ];
    expect(input.instructions).toHaveLength(1);
    expect(input.instructions[0]!.statement).toBe(TESTS);
  });

  it("hands the opener the drafts it wrote", async () => {
    const deps = baseDeps([pricedRun(RUN_A)]);
    const openProposals = vi.fn(async () => undefined);
    await runFindingsPass(SCOPE, {
      ...deps,
      readPrompts: async () => undefined,
      openProposals,
    });
    const [, , , written] = deps.write.mock.calls[0]! as unknown as [
      unknown,
      unknown,
      unknown,
      unknown,
    ];
    const [, input] = openProposals.mock.calls[0]! as unknown as [
      unknown,
      SpendProposalInput,
    ];
    expect(input.findings).toBe(written);
    expect(input.instructions).toEqual([]);
  });

  it("reads no prompts for a workspace with no runs", async () => {
    const readPrompts = vi.fn();
    const openProposals = vi.fn(async () => undefined);
    await runFindingsPass(SCOPE, {
      ...baseDeps([]),
      readPrompts,
      openProposals,
    });
    expect(readPrompts).not.toHaveBeenCalled();
    expect(openProposals).toHaveBeenCalledWith(SCOPE, {
      instructions: [],
      findings: [],
    });
  });

  it("writes nothing when the prompt read fails", async () => {
    const deps = baseDeps([pricedRun(RUN_A)]);
    const openProposals = vi.fn(async () => undefined);
    await expect(
      runFindingsPass(SCOPE, {
        ...deps,
        readPrompts: async () => {
          throw new TypeError("fetch failed");
        },
        openProposals,
      }),
    ).rejects.toThrow("fetch failed");
    expect(deps.write).not.toHaveBeenCalled();
    expect(openProposals).not.toHaveBeenCalled();
  });
});
