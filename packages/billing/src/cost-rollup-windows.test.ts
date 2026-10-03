/**
 * Unit tests for `readRunWindowComposition` (#5341): the rollup reads a run's
 * request windows from the store that recorded them and sums them with the
 * decoder `get_run_context` uses. The two stores are fakes. The ClickHouse
 * read runs against a real table in
 * packages/telemetry/src/context-window-frames.integration.test.ts.
 */
import type { AttemptEventReadRecord } from "@oxagen/run-ledger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readTachoWindowFrames, readAttemptEventsSince, createPostgresRunStore } =
  vi.hoisted(() => {
    const readAttemptEventsSince = vi.fn();
    return {
      readTachoWindowFrames: vi.fn(),
      readAttemptEventsSince,
      createPostgresRunStore: vi.fn(() => ({ readAttemptEventsSince })),
    };
  });

vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/telemetry")>()),
  readTachoWindowFrames,
}));

vi.mock("@oxagen/run-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/run-ledger")>()),
  createPostgresRunStore,
}));

vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  deferredEvidenceArchive: { getSegment: vi.fn(), putSegment: vi.fn() },
}));

import type { RunMeta } from "./cost-rollup";
import { readRunWindowComposition, type RunSource } from "./cost-rollup-store";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const ROOT = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c0df";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000a0001";

const META: RunMeta = {
  runId: "tse_worker0000000000000001",
  runSource: "tacho",
  ...SCOPE,
  operatorPrincipalId: null,
  operatorKey: null,
  agentPrincipalId: null,
  agentKey: "acme.core.bot",
  taskRef: null,
  costCenter: null,
  startedAt: new Date("2026-09-15T09:00:00.000Z"),
  sealedAt: null,
  turns: null,
  retries: null,
  enforcementTier: null,
  replayGrade: null,
};

const wrapped: RunSource = {
  meta: META,
  frames: { kind: "tacho", rootSessionUuid: ROOT, sessionUuids: [ROOT, CHILD] },
};

const ledger: RunSource = {
  meta: { ...META, runId: "arun_0123456789abcdef012345", runSource: "ledger" },
  frames: { kind: "ledger", runUuid: RUN_UUID, originMessageId: null },
};

/** A windowed `llm_call` row as the telemetry read hands it over. */
const windowed = (seq: number, window: string, input: number | null) => ({
  seq,
  kind: "llm_call" as const,
  attrs: { "oxagen.window": window },
  model: "claude-opus-5",
  provider: "anthropic",
  requestId: `req_${String(seq)}`,
  inputTokens: input,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  body: "" as const,
});

function event(
  runSeq: number,
  eventType: string,
  payload: Record<string, unknown>,
): AttemptEventReadRecord {
  return {
    eventId: `0192d4a8-7c1e-7a00-8000-0000000000e${String(runSeq)}`,
    attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
    attemptPublicId: "aatt_0123456789abcdefghjkmn",
    runSeq: String(runSeq),
    attemptSeq: runSeq,
    eventSchemaVersion: "agent-run-event/v2",
    eventType,
    stage: "model",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    eventDigest: `sha256:${String(runSeq).padStart(64, "0")}`,
    payload,
    encryptedPayloadRef: null,
    observedAt: new Date("2026-09-15T09:00:00.000Z"),
    recordedAt: new Date("2026-09-15T09:00:00.500Z"),
    body: { digest: null, ref: null, bytes: null, redactions: null, fidelity: null },
  } as unknown as AttemptEventReadRecord;
}

beforeEach(() => {
  readTachoWindowFrames.mockReset();
  readAttemptEventsSince.mockReset();
  createPostgresRunStore.mockClear();
});

describe("readRunWindowComposition — a wrapped run", () => {
  it("sums every chain's windows, each split to the prompt total its call reported", async () => {
    readTachoWindowFrames.mockImplementation(
      async (_args: unknown, consume: (rows: unknown[]) => Promise<void>) => {
        await consume([
          windowed(2, "system=200:1;tools=300:4;conversation=500:3", 1_000),
          // A call that reported no input: counted apart, summed nowhere.
          windowed(3, "system=200:1;conversation=800:5", null),
        ]);
        await consume([windowed(4, "system=100:1;conversation=900:6", 2_000)]);
      },
    );
    const composition = await readRunWindowComposition(wrapped);
    expect(readTachoWindowFrames).toHaveBeenCalledWith(
      { ...SCOPE, rootSessionUuid: ROOT, sessionUuids: [ROOT, CHILD] },
      expect.any(Function),
    );
    expect(composition).toEqual({
      requests: 2,
      requestsWithoutTokens: 1,
      promptTokens: 3_000,
      blocks: {
        system: 400,
        steering: null,
        tools: 300,
        context: null,
        conversation: 2_300,
      },
      initialConversationTokens: 500,
    });
  });

  it("answers null for a run whose calls carried no window, never a zero (negative)", async () => {
    readTachoWindowFrames.mockImplementation(async () => {});
    expect(await readRunWindowComposition(wrapped)).toBeNull();
  });

  it("throws when the frames cannot be read, so the rollup retries", async () => {
    readTachoWindowFrames.mockRejectedValue(new Error("clickhouse down"));
    await expect(readRunWindowComposition(wrapped)).rejects.toThrow(
      "clickhouse down",
    );
  });
});

describe("readRunWindowComposition — a ledger run", () => {
  const WINDOW = {
    blocks: [
      { kind: "system", bytes: 1_000, items: 1 },
      { kind: "context", bytes: 1_000, items: 2 },
      { kind: "conversation", bytes: 8_000, items: 9 },
    ],
  };

  it("walks the run's events through the run store and sums its windows", async () => {
    const events = [
      event(1, "model.engine_call_started", {
        model_call_id: "prov-1-0",
        provider: "oxagen",
        model: "anthropic/claude-sonnet-4",
        window: WINDOW,
      }),
      event(2, "model.engine_call_completed", {
        model_call_id: "prov-1-0",
        model: "anthropic/claude-sonnet-4",
        input_tokens: 10_000,
      }),
    ];
    readAttemptEventsSince.mockImplementation(
      async (runId: string, after: string, limit: number) => {
        expect(runId).toBe(RUN_UUID);
        return events.filter((e) => Number(e.runSeq) > Number(after)).slice(0, limit);
      },
    );
    const composition = await readRunWindowComposition(ledger);
    expect(createPostgresRunStore).toHaveBeenCalledWith({
      archive: expect.objectContaining({ getSegment: expect.any(Function) }),
    });
    expect(composition).toEqual({
      requests: 1,
      requestsWithoutTokens: 0,
      promptTokens: 10_000,
      blocks: {
        system: 1_000,
        steering: null,
        tools: null,
        context: 1_000,
        conversation: 8_000,
      },
      initialConversationTokens: 8_000,
    });
  });

  it("answers null for a ledger run recorded before windows existed (negative)", async () => {
    readAttemptEventsSince.mockResolvedValue([
      event(1, "model.engine_call_started", { model_call_id: "prov-1-0" }),
      event(2, "model.engine_call_completed", {
        model_call_id: "prov-1-0",
        input_tokens: 10_000,
      }),
    ]);
    expect(await readRunWindowComposition(ledger)).toBeNull();
  });
});
