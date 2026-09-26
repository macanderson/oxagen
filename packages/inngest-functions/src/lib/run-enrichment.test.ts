import { describe, expect, it, vi } from "vitest";
import { tachoFrame } from "@oxagen/run-ledger";
import { digestBytes } from "@oxagen/tacho";
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));
vi.mock("@oxagen/ai", () => ({
  resolveModelFundingSource: vi.fn(),
  selectModelFromFunding: vi.fn(),
}));
vi.mock("@oxagen/billing", () => ({
  evaluateTurnCreditGate: vi.fn(),
  // A flat test price: a cent per thousand tokens either way.
  turnCostUsd: vi.fn(
    (_model: string, usage: { inputTokens?: number; outputTokens?: number }) =>
      ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) / 100_000,
  ),
}));
import {
  collectRunText,
  enrichmentFailureReason,
  fallbackRunTitle,
  runNarrativeTurn,
  ENRICHMENT_BODY_READ_CEILING,
  ENRICHMENT_CHUNK_CHARS,
  ENRICHMENT_TEXT_CEILING_CHARS,
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

// #4202: collectRunText read every body in the run and held all of its text,
// with no ceiling, inside one durable step on a 256 MB heap.
describe("the text ceiling", () => {
  const bodyChars = ENRICHMENT_CHUNK_CHARS;
  const perFrame = bodyChars + 64;
  const count = Math.ceil(ENRICHMENT_TEXT_CEILING_CHARS / perFrame) + 10;
  const bodies = Array.from(
    { length: count + 1 },
    (_, i) => `body-${i}:${"x".repeat(bodyChars - 12)}`,
  );
  const frames = bodies.map((text, i) => frame(i, text));
  const read = async (_scope: unknown, ref: string) => ({
    bytes: new TextEncoder().encode(bodies[Number(ref.slice(5))]!),
  });

  it("stops reading bodies once the text reaches the ceiling", async () => {
    const get = vi.fn(read);
    const got = await collectRunText(scope, frames.slice(0, count), get);
    const text = got.chunks.join("");

    expect(get.mock.calls.length).toBeLessThan(count);
    expect(get.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(ENRICHMENT_TEXT_CEILING_CHARS / bodyChars),
    );
    expect(text.length).toBeLessThanOrEqual(
      ENRICHMENT_TEXT_CEILING_CHARS + 200,
    );
    expect(text).toContain("The transcript stops here.");
    expect(text).not.toContain(`body-${count - 1}:`);
    expect(got.truncated).toBe(true);
    expect(got.frames).toBeLessThan(count);
    // A left-out frame is not missing evidence: it must not mark the account partial.
    expect(got).toMatchObject({ missing: 0, unavailable: 0 });
    expect(got.chunks.every((c) => c.length <= ENRICHMENT_CHUNK_CHARS)).toBe(
      true,
    );
  });

  it("keeps its fingerprint when frames arrive past the ceiling", async () => {
    const before = await collectRunText(scope, frames.slice(0, count), read);
    const after = await collectRunText(scope, frames, read);

    expect(after.digest).toBe(before.digest);
    expect(after.truncated).toBe(true);
    expect(after.frames).toBe(before.frames);
  });
});

// #3784: the job read every frame of a run into one array before any of its
// text, and opened every body in series inside one durable step.
describe("a paged read", () => {
  const PAGE = 10;
  /** `frames` as pages of ten, counting the pages a reader pulls. */
  function paged(frames: ReturnType<typeof frame>[]) {
    const seen = { pulled: 0, closed: false };
    async function* pages() {
      try {
        for (let at = 0; at < frames.length; at += PAGE) {
          seen.pulled += 1;
          yield frames.slice(at, at + PAGE);
        }
      } finally {
        seen.closed = true;
      }
    }
    return { pages: pages(), seen };
  }
  const readOf =
    (bodies: readonly string[]) => async (_scope: unknown, ref: string) => ({
      bytes: new TextEncoder().encode(bodies[Number(ref.slice(5))]!),
    });

  it("stops pulling pages one frame past the text ceiling", async () => {
    const bodies = Array.from(
      { length: 100 },
      (_, i) => `body-${i}:${"x".repeat(ENRICHMENT_CHUNK_CHARS - 12)}`,
    );
    const frames = bodies.map((text, i) => frame(i, text));
    const { pages, seen } = paged(frames);
    const got = await collectRunText(scope, pages, readOf(bodies));
    expect(got.truncated).toBe(true);
    // The page that holds the first frame past the text, and none after it.
    expect(seen.pulled).toBe(Math.floor(got.frames / PAGE) + 1);
    expect(seen.pulled).toBeLessThan(100 / PAGE);
    expect(seen.closed).toBe(true);
    // Paged or listed, the run reads the same.
    const listed = await collectRunText(scope, frames, readOf(bodies));
    expect(got.digest).toBe(listed.digest);
    expect(got.chunks).toEqual(listed.chunks);
  });

  it("reads a run under the ceiling to its end and fingerprints it as a list does (negative)", async () => {
    const bodies = Array.from({ length: 25 }, (_, i) => `turn-${i}: a reply`);
    const frames = bodies.map((text, i) => frame(i, text));
    const { pages, seen } = paged(frames);
    const got = await collectRunText(scope, pages, readOf(bodies));
    expect(seen.pulled).toBe(3);
    expect(got).toMatchObject({ truncated: false, frames: 25, retained: 25 });
    const listed = await collectRunText(scope, frames, readOf(bodies));
    expect(got.digest).toBe(listed.digest);
  });

  it("opens at most the body-read ceiling, and the text says it stops", async () => {
    const bodies = Array.from(
      { length: ENRICHMENT_BODY_READ_CEILING + 5 },
      (_, i) => `short reply ${i}`,
    );
    const frames = bodies.map((text, i) => frame(i, text));
    const get = vi.fn(readOf(bodies));
    const { pages } = paged(frames);
    const got = await collectRunText(scope, pages, get);
    expect(get).toHaveBeenCalledTimes(ENRICHMENT_BODY_READ_CEILING);
    expect(got).toMatchObject({
      truncated: true,
      frames: ENRICHMENT_BODY_READ_CEILING,
      retained: ENRICHMENT_BODY_READ_CEILING,
    });
    expect(got.chunks.join("")).toContain("The transcript stops here.");
    expect(got.chunks.join("")).not.toContain(
      `short reply ${ENRICHMENT_BODY_READ_CEILING}`,
    );
  });

  it("reads every body of a run that opens exactly the ceiling (negative)", async () => {
    const bodies = Array.from(
      { length: ENRICHMENT_BODY_READ_CEILING },
      (_, i) => `short reply ${i}`,
    );
    const get = vi.fn(readOf(bodies));
    const got = await collectRunText(
      scope,
      bodies.map((text, i) => frame(i, text)),
      get,
    );
    expect(get).toHaveBeenCalledTimes(ENRICHMENT_BODY_READ_CEILING);
    expect(got.truncated).toBe(false);
    expect(got.chunks.join("")).not.toContain("The transcript stops here.");
  });

  it("cuts the text at the first frame past the body-read ceiling that would open a body, not at a frame that opens none", async () => {
    const ceiling = ENRICHMENT_BODY_READ_CEILING;
    /** A frame that kept no body, such as a tool call's. */
    const bare = (seq: number) =>
      tachoFrame({
        seq,
        ts: "2026-09-22 00:00:00.000",
        kind: "tool_call",
        hash: digestBytes(new TextEncoder().encode(`bare-${seq}`)),
        contentDigest: "",
        bytesRef: "",
        redactions: "",
        toolName: "Read",
        toolStatus: "ok",
        toolUseId: `toolu_${seq}`,
        model: "",
        provider: "",
        policyDecision: "",
        costUsdMicros: null,
        turnSeq: seq,
      });
    const bodies = Array.from(
      { length: ceiling + 2 },
      (_, i) => `short reply ${i}`,
    );
    const read = bodies
      .slice(0, ceiling)
      .map((text, i) => frame(i, text));
    // A frame that opens no body costs no read, so the read ceiling leaves
    // it in, and nothing was cut.
    const toolAfter = await collectRunText(
      scope,
      [...read, bare(ceiling)],
      readOf(bodies),
    );
    expect(toolAfter).toMatchObject({
      truncated: false,
      frames: ceiling + 1,
      retained: ceiling,
    });
    expect(toolAfter.chunks.join("")).not.toContain(
      "The transcript stops here.",
    );
    // The next frame that would open a body is where the text stops.
    const get = vi.fn(readOf(bodies));
    const bodyAfter = await collectRunText(
      scope,
      [...read, bare(ceiling), frame(ceiling + 1, bodies[ceiling + 1]!)],
      get,
    );
    expect(bodyAfter).toMatchObject({
      truncated: true,
      frames: ceiling + 1,
      retained: ceiling,
    });
    expect(get).toHaveBeenCalledTimes(ceiling);
    expect(bodyAfter.chunks.join("")).toContain("The transcript stops here.");
  });
});

it("uses the same resolved funding for the selected model, credit gate and Stella credential", async () => {
  const { resolveModelFundingSource, selectModelFromFunding } = await import(
    "@oxagen/ai"
  );
  const { runGovernedTurn } = await import("@oxagen/agent");
  const { evaluateTurnCreditGate, turnCostUsd } = await import(
    "@oxagen/billing"
  );
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
  const usage = {
    inputTokens: 6_000,
    outputTokens: 400,
    totalTokens: 6_400,
    cachedInputTokens: 0,
  };
  vi.mocked(runGovernedTurn).mockResolvedValue({
    fullStream: (async function* () {})(),
    finalText: Promise.resolve("Recorded work"),
    usage: Promise.resolve(usage),
    modelId: "test-model",
  } as never);
  // The call reports the tokens it used and their price (#3944, E-01), so
  // the job can hold a run to its budget.
  await expect(runNarrativeTurn(scope, "summarize")).resolves.toEqual({
    text: "Recorded work",
    model: "test-model",
    usage,
    costUsd: 0.064,
  });
  expect(turnCostUsd).toHaveBeenCalledWith("test-model", usage);
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
    [new Error("the model provider answered 403"), "model_refused"],
    [new Error("the model provider answered 429"), "rate_limited"],
    [new Error("the model provider answered 503"), "provider_error"],
    [new Error("the model provider answered 400"), "request_rejected"],
    [
      new Error("the model call failed before the provider answered"),
      "provider_unreachable",
    ],
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

// #4113: a turn whose model call failed settles with an empty answer, and the
// job recorded every such refusal as `empty_account`.
describe("a model call that fails inside the turn", () => {
  async function turnSettlingWith(parts: unknown[], text: string) {
    const { resolveModelFundingSource, selectModelFromFunding } = await import(
      "@oxagen/ai"
    );
    const { runGovernedTurn } = await import("@oxagen/agent");
    const { evaluateTurnCreditGate } = await import("@oxagen/billing");
    vi.clearAllMocks();
    vi.mocked(resolveModelFundingSource).mockResolvedValue({
      fundedBy: "platform",
    } as never);
    vi.mocked(selectModelFromFunding).mockReturnValue({
      model: {} as never,
      fundedBy: "platform",
    });
    vi.mocked(evaluateTurnCreditGate).mockResolvedValue({ ok: true } as never);
    vi.mocked(runGovernedTurn).mockResolvedValue({
      fullStream: (async function* () {
        yield* parts;
      })(),
      finalText: Promise.resolve(text),
      modelId: "test-model",
    } as never);
    return runNarrativeTurn(scope, "summarize");
  }
  const failedWith = (status: number) =>
    turnSettlingWith(
      [
        {
          type: "error",
          error: Object.assign(
            new Error(`the model provider answered ${status}`),
            { code: "model_call_failed", status },
          ),
        },
        { type: "finish", finishReason: "error" },
      ],
      "",
    );

  it("throws the provider's refusal, not an empty account, and does not retry it", async () => {
    const { NonRetriableError } = await import("@oxagen/functions");
    const error = await failedWith(403).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetriableError);
    expect(enrichmentFailureReason(error)).toBe("model_refused");
  });

  it("leaves a rate limit to the job's retries", async () => {
    const { NonRetriableError } = await import("@oxagen/functions");
    const error = await failedWith(429).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect(enrichmentFailureReason(error)).toBe("rate_limited");
  });

  it("still reports an empty account when the turn ended cleanly with no text", async () => {
    await expect(turnSettlingWith([], "  ")).rejects.toThrow(
      "Stella returned no run account",
    );
  });
});
