import { describe, expect, it, vi } from "vitest";
import { tachoFrame } from "@oxagen/run-ledger";
import { digestBytes } from "@oxagen/tacho";
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));
vi.mock("@oxagen/ai", () => ({
  resolveModelFundingSource: vi.fn(),
  selectModelFromFunding: vi.fn(),
}));
vi.mock("@oxagen/billing", () => ({ evaluateTurnCreditGate: vi.fn() }));
import {
  collectRunText,
  enrichmentFailureReason,
  fallbackRunTitle,
  runNarrativeTurn,
  ENRICHMENT_CHUNK_CHARS,
  uniqueRunName,
} from "./run-enrichment";
const scope = { orgId: "o", workspaceId: "w" };
function frame(seq: number, text: string) {
  const digest = digestBytes(new TextEncoder().encode(text));
  return tachoFrame({
    seq,
    ts: "2026-09-22 00:00:00.000",
    kind: "user_prompt",
    hash: digest,
    contentDigest: digest,
    bytesRef: `body-${seq}`,
    redactions: "",
    toolName: "",
    toolStatus: "",
    toolUseId: "",
    model: "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: seq,
  });
}
describe("the full recorded input", () => {
  it("includes later turns beyond the old sixty-step limit and the end of long bodies", async () => {
    const bodies = Array.from(
      { length: 75 },
      (_, i) =>
        `turn-${i}: ${i === 74 ? "x".repeat(ENRICHMENT_CHUNK_CHARS * 2) + "FINAL CORRECTION" : "prompt and agent reply"}`,
    );
    const frames = bodies.map((body, i) => frame(i, body));
    const got = await collectRunText(scope, frames, async (_scope, ref) => ({
      bytes: new TextEncoder().encode(bodies[Number(ref.slice(5))]!),
    }));
    expect(got.retained).toBe(75);
    expect(got.missing).toBe(0);
    expect(
      got.chunks.every((chunk) => chunk.length <= ENRICHMENT_CHUNK_CHARS),
    ).toBe(true);
    for (let i = 0; i < 75; i += 1)
      expect(got.chunks.join("")).toContain(`turn-${i}:`);
    expect(got.chunks.join("")).toContain("FINAL CORRECTION");
  });
  it("includes repeated bodies once while retaining every frame in order", async () => {
    const text = "one retained patch";
    const get = vi.fn(async () => ({ bytes: new TextEncoder().encode(text) }));
    const got = await collectRunText(
      scope,
      [frame(0, text), frame(1, text), frame(2, text)],
      get,
    );
    const account = got.chunks.join("");
    expect(get).toHaveBeenCalledTimes(3);
    expect(account.split(text)).toHaveLength(2);
    expect(account).toMatch(/Frame 0:[\s\S]*Frame 1:[\s\S]*Frame 2:/);
    expect(account.match(/Same retained body as frame 0/g)).toHaveLength(2);
    expect(got).toMatchObject({ retained: 3, missing: 0, frames: 3 });
  });
  it("verifies each repeated body before referring to an earlier frame", async () => {
    const text = "verified body";
    const got = await collectRunText(
      scope,
      [frame(1, text), frame(2, text)],
      async (_scope, ref) => ({
        bytes: new TextEncoder().encode(ref === "body-1" ? text : "tampered"),
      }),
    );
    expect(got).toMatchObject({ retained: 1, missing: 1, unavailable: 1 });
    expect(got.chunks.join("")).not.toContain("Same retained body");
    expect(got.chunks.join("")).not.toContain("tampered");
    expect(got.chunks.join("")).toContain("Body unavailable");
  });
  it("does not use bytes whose digest disagrees and marks missing evidence", async () => {
    const got = await collectRunText(
      scope,
      [frame(1, "original")],
      async () => ({ bytes: new TextEncoder().encode("tampered") }),
    );
    expect(got.retained).toBe(0);
    expect(got.missing).toBe(1);
    expect(got.chunks.join("")).not.toContain("tampered");
  });
  it("changes its fingerprint when an unavailable retained body becomes readable", async () => {
    const frames = [frame(1, "restored")];
    const missing = await collectRunText(scope, frames, async () => {
      throw new Error("temporary outage");
    });
    const present = await collectRunText(scope, frames, async () => ({
      bytes: new TextEncoder().encode("restored"),
    }));
    expect(missing.unavailable).toBe(1);
    expect(present.unavailable).toBe(0);
    expect(present.digest).not.toBe(missing.digest);
  });
  it("fingerprints the complete input, including later appended frames", async () => {
    const one = frame(1, "one");
    const two = frame(2, "two");
    const get = async (_scope: unknown, ref: string) => ({
      bytes: new TextEncoder().encode(ref === "body-1" ? "one" : "two"),
    });
    const a = await collectRunText(scope, [one], get);
    expect((await collectRunText(scope, [one], get)).digest).toBe(a.digest);
    expect((await collectRunText(scope, [one, two], get)).digest).not.toBe(
      a.digest,
    );
  });
  it("distinguishes runs with the same model-written title", () => {
    expect(uniqueRunName("Fix login", "tse_12345678")).not.toBe(
      uniqueRunName("Fix login", "tse_87654321"),
    );
    expect(
      uniqueRunName("x".repeat(100), "tse_12345678").length,
    ).toBeLessThanOrEqual(80);
  });
});

it("uses the same resolved funding for the selected model, credit gate and Stella credential", async () => {
  const { resolveModelFundingSource, selectModelFromFunding } = await import(
    "@oxagen/ai"
  );
  const { runGovernedTurn } = await import("@oxagen/agent");
  const { evaluateTurnCreditGate } = await import("@oxagen/billing");
  vi.clearAllMocks();
  const funding = {
    fundedBy: "org" as const,
    keyHint: "test",
    modelKey: {
      provider: "openrouter" as const,
      apiKey: "test-key",
      digest: "digest",
      baseUrl: null,
      modelMap: {},
    },
  };
  const model = { modelId: "test-model" };
  vi.mocked(resolveModelFundingSource).mockResolvedValue(funding);
  vi.mocked(selectModelFromFunding).mockReturnValue({
    model: model as never,
    fundedBy: "org",
  });
  vi.mocked(evaluateTurnCreditGate).mockResolvedValue({ ok: true } as never);
  vi.mocked(runGovernedTurn).mockResolvedValue({
    fullStream: (async function* () {})(),
    finalText: Promise.resolve("Recorded work"),
    modelId: "test-model",
  } as never);
  await expect(runNarrativeTurn(scope, "summarize")).resolves.toEqual({
    text: "Recorded work",
    model: "test-model",
  });
  expect(resolveModelFundingSource).toHaveBeenCalledOnce();
  expect(resolveModelFundingSource).toHaveBeenCalledWith(scope.orgId);
  expect(selectModelFromFunding).toHaveBeenCalledWith(scope.orgId, funding, {
    tier: "fast",
  });
  expect(evaluateTurnCreditGate).toHaveBeenCalledWith(scope.orgId, {
    fundedBy: "org",
  });
  expect(runGovernedTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      model,
      fundedBy: "org",
      credential: funding.modelKey,
      tools: {},
    }),
  );
});

describe("the fallback title", () => {
  it("names a run for the first sentence of its first prompt and its branch", () => {
    expect(
      fallbackRunTitle(
        "Please repair authentication. The redirect loops after login.",
        "fix/auth-redirect",
      ),
    ).toBe("Please repair authentication on fix/auth-redirect");
  });
  it("leaves out a branch that names no work", () => {
    for (const branch of ["main", "master", "HEAD", " ", null])
      expect(fallbackRunTitle("Why does CI fail?", branch)).toBe(
        "Why does CI fail?",
      );
  });
  it("reads the first line with words and drops markup", () => {
    expect(
      fallbackRunTitle(
        "\n  <command-name>/review</command-name>\n\nsecond line",
        null,
      ),
    ).toBe("/review");
  });
  it("cuts a long sentence at a word and keeps the whole title within 80 characters", () => {
    const title = fallbackRunTitle(
      `Refactor ${"the billing proration path ".repeat(6)}and the invoices`,
      `feature/${"x".repeat(60)}`,
    )!;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toMatch(
      /^Refactor the billing proration path .*… on feature\//u,
    );
    expect(title.split(" on feature/")[0]!.length).toBeLessThanOrEqual(60);
  });
  it("gives no title for a prompt with no words", () => {
    expect(fallbackRunTitle(" \n <br> \n", "fix/x")).toBeNull();
  });
});

it("keeps the run's own first prompt and skips a subagent's", async () => {
  const subagent = {
    ...frame(1, "Search the repository for callers."),
    type: "turn_start",
    chain: {
      sessionUuid: "child",
      parentSessionUuid: "root",
      subagentId: "a1",
      subagentType: "Explore",
      spawnToolUseId: "toolu_1",
    },
  };
  const own = { ...frame(2, "Fix the flaky login test."), type: "turn_start" };
  const texts = [
    "",
    "Search the repository for callers.",
    "Fix the flaky login test.",
  ];
  const got = await collectRunText(
    scope,
    [frame(0, "tool output"), subagent, own],
    async (_scope, ref) => ({
      bytes: new TextEncoder().encode(
        ref === "body-0" ? "tool output" : texts[Number(ref.slice(5))]!,
      ),
    }),
  );
  expect(got.firstPrompt).toBe("Fix the flaky login test.");
});

describe("the stored failure reason", () => {
  it.each([
    [
      new Error("Run enrichment unavailable: insufficient_credits"),
      "credit_refused:insufficient_credits",
    ],
    [
      {
        name: "GatewayError",
        message: "Free tier users do not have access to this model",
      },
      "model_refused",
    ],
    [{ name: "ZodError", message: "[]" }, "invalid_account"],
    [new SyntaxError("Unexpected token"), "invalid_account"],
    [{ name: "TimeoutError", message: "The operation was aborted" }, "timeout"],
    [new Error("Run enrichment was disabled"), "disabled"],
    [new Error("Stella returned no run account"), "empty_account"],
    [new Error("socket hang up"), "unknown"],
    ["a bare string", "unknown"],
  ])("classifies %o as %s", (error, reason) => {
    expect(enrichmentFailureReason(error)).toBe(reason);
  });
});

it("does not retry a credit refusal inside the job", async () => {
  const { resolveModelFundingSource, selectModelFromFunding } = await import(
    "@oxagen/ai"
  );
  const { evaluateTurnCreditGate } = await import("@oxagen/billing");
  const { NonRetriableError } = await import("@oxagen/functions");
  vi.clearAllMocks();
  vi.mocked(resolveModelFundingSource).mockResolvedValue({
    fundedBy: "platform",
  } as never);
  vi.mocked(selectModelFromFunding).mockReturnValue({
    model: {} as never,
    fundedBy: "platform",
  });
  vi.mocked(evaluateTurnCreditGate).mockResolvedValue({
    ok: false,
    code: "insufficient_credits",
  } as never);
  const call = runNarrativeTurn(scope, "summarize");
  await expect(call).rejects.toBeInstanceOf(NonRetriableError);
  await expect(call).rejects.toThrow(
    "Run enrichment unavailable: insufficient_credits",
  );
});
