import { NO_BODY, tachoFrame } from "@oxagen/run-ledger";
import { NonRetriableError } from "@oxagen/functions";
import { digestBytes } from "@oxagen/tacho";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  modelIdOf: vi.fn(),
  resolveModelFundingSource: vi.fn(),
  selectModel: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  ledgerStore: vi.fn(),
  readRunFrames: vi.fn(),
  resolveRunRecord: vi.fn(),
  evidenceStore: vi.fn(),
}));

type StepRun = (name: string, fn: () => unknown) => Promise<unknown>;
type Handler = (ctx: {
  event: { data: unknown };
  step: { run: StepRun };
}) => Promise<unknown>;

/** Where the createFunction stub leaves the handler the module hands it. */
const captured = vi.hoisted(
  () => ({ handler: undefined }) as { handler?: Handler },
);

vi.mock("../create-function", () => ({
  createFunction: (_opts: unknown, _trigger: unknown, fn: Handler) => {
    captured.handler = fn;
    return [{}, {}];
  },
}));
vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
  modelIdOf: mocks.modelIdOf,
  resolveModelFundingSource: mocks.resolveModelFundingSource,
  selectModel: mocks.selectModel,
}));
vi.mock("@oxagen/database", () => {
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    schema: {
      tachoSessions: {
        id: "sessions.id",
        publicId: "sessions.public_id",
        orgId: "sessions.org_id",
        workspaceId: "sessions.workspace_id",
      },
    },
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: mocks.evidenceStore,
}));
vi.mock("../lib/run-record", () => ({
  ledgerStore: mocks.ledgerStore,
  readRunFrames: mocks.readRunFrames,
  resolveRunRecord: mocks.resolveRunRecord,
}));

import {
  collectSummarySteps,
  SUMMARY_STEP_MAX,
  SUMMARY_TEXT_MAX,
  summaryPrompt,
  summarySchema,
} from "./run.summarize";

const enc = new TextEncoder();
const scope = { orgId: "o", workspaceId: "w" };

function row(seq: number, kind: string, text?: string, toolUseId?: string) {
  const bytes = text === undefined ? null : enc.encode(text);
  return tachoFrame({
    seq,
    ts: "2026-09-11 09:00:00.000",
    kind,
    hash: `sha256:${String(seq).padStart(64, "0")}`,
    contentDigest: bytes ? digestBytes(bytes) : "",
    bytesRef: bytes ? `evb:v1:k:${digestBytes(bytes).slice(7)}` : "",
    redactions: "",
    toolName: kind === "tool_call" ? "Read" : "",
    toolStatus: kind === "tool_call" ? "ok" : "",
    toolUseId: toolUseId ?? (kind === "tool_call" ? `tu_${seq}` : ""),
    model: kind === "llm_call" ? "haiku" : "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: null,
  });
}

const objects = new Map<string, Uint8Array>();
const store = (text: string) => {
  const bytes = enc.encode(text);
  objects.set(`evb:v1:k:${digestBytes(bytes).slice(7)}`, bytes);
};
const getBody = (_s: unknown, ref: string) => {
  const bytes = objects.get(ref);
  return bytes
    ? Promise.resolve({ bytes })
    : Promise.reject(new Error("no object"));
};

describe("run.summarize", () => {
  it("collects the steps with their body text, and says when a body was not retained or does not hash", async () => {
    store("What is in README?");
    store('{"path":"README.md"}');
    objects.set(
      `evb:v1:k:${digestBytes(enc.encode("forged")).slice(7)}`,
      enc.encode("other"),
    );
    const frames = [
      row(0, "agent_start"),
      row(1, "llm_call", "What is in README?"),
      row(2, "tool_call", '{"path":"README.md"}'),
      row(3, "llm_call", "forged"),
      { ...row(4, "llm_call"), body: NO_BODY },
      row(5, "agent_stop"),
    ];
    const collected = await collectSummarySteps(scope, frames, getBody);
    expect(collected.total).toBe(5);
    expect(collected.steps.map((s) => [s.seq, s.kind, s.text])).toEqual([
      ["0", "frame", null],
      ["1", "model_call", "What is in README?"],
      ["2", "tool_call", '{"path":"README.md"}'],
      ["3", "model_call", null],
      ["4", "model_call", null],
    ]);
    const prompt = summaryPrompt("tse_0a1b2c", collected);
    expect(prompt).toContain("[1] model_call haiku\nWhat is in README?");
    expect(prompt).toContain("[3] model_call haiku\n(body not retained)");
    expect(prompt).not.toContain("omitted");
  });

  it("bounds the steps and each body's text, and says how many steps were left out", async () => {
    const long = "x".repeat(SUMMARY_TEXT_MAX + 10);
    store(long);
    const frames = Array.from({ length: SUMMARY_STEP_MAX + 5 }, (_, i) =>
      row(i, "llm_call", long),
    );
    const collected = await collectSummarySteps(scope, frames, getBody);
    expect(collected.steps).toHaveLength(SUMMARY_STEP_MAX);
    expect(collected.steps[0]?.text).toHaveLength(SUMMARY_TEXT_MAX);
    expect(summaryPrompt("tse_x", collected)).toContain(
      "(5 later steps omitted)",
    );
  });

  it("refuses a generated name or summary outside the bounds (negative)", () => {
    expect(
      summarySchema.safeParse({
        name: "Review PR 42",
        summary: "Left two comments.",
      }).success,
    ).toBe(true);
    expect(summarySchema.safeParse({ name: "", summary: "x" }).success).toBe(
      false,
    );
    expect(
      summarySchema.safeParse({ name: "x".repeat(81), summary: "x" }).success,
    ).toBe(false);
  });
});

describe("run.summarize job", () => {
  const data = {
    orgId: "org_1",
    workspaceId: "ws_1",
    runPublicId: "tse_4q8r1t6v3x5z0b2d7h2k9m",
    requestedByUserId: "user_1",
  };
  const tachoRecord = {
    source: "tacho",
    sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c0de",
    enforcementTier: "gateway",
    completenessGaps: [],
    replayGrade: "view",
  };

  /** Runs the captured job, answering `returned` from the tacho update. */
  function run(returned: unknown[]) {
    const steps: string[] = [];
    const updates: Array<{ values: unknown; where: unknown }> = [];
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          update: () => ({
            set: (values: unknown) => ({
              where: (where: unknown) => ({
                returning: () => {
                  updates.push({ values, where });
                  return Promise.resolve(returned);
                },
              }),
            }),
          }),
        }),
    );
    const done = (captured.handler as Handler)({
      event: { data },
      step: {
        run: async (name, fn) => {
          steps.push(name);
          return fn();
        },
      },
    });
    return { done, steps, updates };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
    mocks.resolveRunRecord.mockResolvedValue(tachoRecord);
    store("What is in README?");
    mocks.readRunFrames.mockResolvedValue([
      row(1, "llm_call", "What is in README?"),
    ]);
    mocks.evidenceStore.mockReturnValue({ getBody });
    mocks.resolveModelFundingSource.mockResolvedValue({
      fundedBy: "platform",
      credential: null,
    });
    mocks.selectModel.mockReturnValue({ id: "fast" });
    mocks.modelIdOf.mockReturnValue("fast-model");
    mocks.generateObjectFor.mockResolvedValue({
      object: { name: "Review PR 42", summary: "Left two comments." },
    });
  });

  it("reads the run in its workspace, generates, then writes the summary fenced on public id, org and workspace", async () => {
    const { done, steps, updates } = run([{ id: "s1" }]);
    await expect(done).resolves.toEqual({
      runPublicId: data.runPublicId,
      model: "fast-model",
    });
    expect(steps).toEqual(["read-transcript", "generate", "write-summary"]);
    expect(mocks.resolveRunRecord).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      data.runPublicId,
    );
    expect(mocks.readRunFrames).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      tachoRecord,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values).toMatchObject({
      name: "Review PR 42",
      summary: "Left two comments.",
      summaryModel: "fast-model",
    });
    expect(updates[0]?.where).toEqual({
      and: [
        { eq: ["sessions.public_id", data.runPublicId] },
        { eq: ["sessions.org_id", "org_1"] },
        { eq: ["sessions.workspace_id", "ws_1"] },
      ],
    });
  });

  it("fails without retry when the update writes no row (negative)", async () => {
    const { done } = run([]);
    await expect(done).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("fails without retry, before any model call, when the run is not in the job's workspace (negative)", async () => {
    mocks.resolveRunRecord.mockResolvedValue(null);
    const { done, steps } = run([{ id: "s1" }]);
    await expect(done).rejects.toBeInstanceOf(NonRetriableError);
    expect(steps).toEqual(["read-transcript"]);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("fails without retry, before any model call, when no step kept a body (negative)", async () => {
    mocks.readRunFrames.mockResolvedValue([
      row(1, "llm_call"),
      row(2, "tool_call"),
    ]);
    const { done, steps, updates } = run([{ id: "s1" }]);
    await expect(done).rejects.toBeInstanceOf(NonRetriableError);
    expect(steps).toEqual(["read-transcript"]);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("writes a ledger run's summary through the ledger store", async () => {
    const ledger = { source: "ledger", runId: "r1", attempts: [] };
    mocks.resolveRunRecord.mockResolvedValue(ledger);
    const setRunSummary = vi.fn().mockResolvedValue(true);
    mocks.ledgerStore.mockReturnValue({ setRunSummary });
    const { done, updates } = run([]);
    await done;
    expect(setRunSummary).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ name: "Review PR 42", model: "fast-model" }),
    );
    expect(updates).toHaveLength(0);
  });
});

describe("a step the producer wrote in two halves", () => {
  it("reads the RESULT, and names what the call was made with", async () => {
    // `tool_requested` then `tool_call` is one step. Reading the frame that
    // opens it would hand the model the tool's input and call it the result.
    store('{"path":"README.md"}');
    store("# Oxagen\nWorkforce management for autonomous agents.");
    const frames = [
      row(1, "tool_requested", '{"path":"README.md"}', "tu_shared"),
      row(
        2,
        "tool_call",
        "# Oxagen\nWorkforce management for autonomous agents.",
        "tu_shared",
      ),
    ];
    const collected = await collectSummarySteps(scope, frames, getBody);
    expect(collected.total).toBe(1);
    expect(collected.steps[0]).toMatchObject({
      seq: "1",
      kind: "tool_call",
      input: '{"path":"README.md"}',
      text: "# Oxagen\nWorkforce management for autonomous agents.",
    });
    const prompt = summaryPrompt("tse_0a1b2c", collected);
    expect(prompt).toContain('called with: {"path":"README.md"}');
    expect(prompt).toContain("Workforce management for autonomous agents.");
  });

  it("says the result was not retained rather than showing the input in its place (negative)", async () => {
    store('{"path":"README.md"}');
    const frames = [
      row(1, "tool_requested", '{"path":"README.md"}', "tu_shared"),
      { ...row(2, "tool_call", undefined, "tu_shared"), body: NO_BODY },
    ];
    const collected = await collectSummarySteps(scope, frames, getBody);
    expect(collected.steps[0]).toMatchObject({
      input: '{"path":"README.md"}',
      text: null,
    });
    expect(summaryPrompt("tse_0a1b2c", collected)).toContain(
      "(body not retained)",
    );
  });
});
