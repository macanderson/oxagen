import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  backoffMs,
  compactMessages,
  contextWindowFor,
  delay,
  estimateMessageTokens,
  isContextOverflowError,
  isFatalAuthOrBillingError,
  isRetryableModelError,
  loopNudgeMessage,
  successfulRepeatNudgeMessage,
  SUCCESSFUL_REPEAT_THRESHOLD,
  toolCallSignature,
} from "./loop-driver";

describe("toolCallSignature", () => {
  it("is stable for identical name+input and differs otherwise", () => {
    expect(toolCallSignature("edit_file", { path: "a", old_string: "x" })).toBe(
      toolCallSignature("edit_file", { path: "a", old_string: "x" }),
    );
    expect(toolCallSignature("edit_file", { path: "a" })).not.toBe(
      toolCallSignature("edit_file", { path: "b" }),
    );
    expect(toolCallSignature("bash", { command: "ls" })).not.toBe(
      toolCallSignature("grep", { command: "ls" }),
    );
  });
});

describe("loopNudgeMessage", () => {
  it("names the tool, the repeat count, and truncates the error", () => {
    const msg = loopNudgeMessage("edit_file", 3, "X".repeat(1000));
    expect(msg).toContain("edit_file");
    expect(msg).toContain("3 times");
    expect(msg.toLowerCase()).toContain("different approach");
    expect(msg.length).toBeLessThan(700); // error truncated to 400
  });
});

describe("successfulRepeatNudgeMessage", () => {
  it("names the tool and count, and tells the model to stop re-running", () => {
    const msg = successfulRepeatNudgeMessage("bash", SUCCESSFUL_REPEAT_THRESHOLD);
    expect(msg).toContain("bash");
    expect(msg).toContain(`${SUCCESSFUL_REPEAT_THRESHOLD} times`);
    expect(msg.toLowerCase()).toContain("do not run this command again");
  });

  it("SUCCESSFUL_REPEAT_THRESHOLD is a positive integer", () => {
    expect(SUCCESSFUL_REPEAT_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isInteger(SUCCESSFUL_REPEAT_THRESHOLD)).toBe(true);
  });
});

describe("estimateMessageTokens", () => {
  it("estimates ~chars/4 across string and structured content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(400) },
      { role: "assistant", content: [{ type: "text", text: "b".repeat(400) }] as never },
    ];
    // ~400 + ~(json of the array) → both counted; comfortably > 100 tokens.
    expect(estimateMessageTokens(messages)).toBeGreaterThan(150);
  });

  it("returns 0 for empty content", () => {
    expect(estimateMessageTokens([{ role: "user", content: "" }])).toBe(0);
  });
});

describe("contextWindowFor", () => {
  it("maps known model families and defaults conservatively", () => {
    expect(contextWindowFor("anthropic/claude-opus-4-8")).toBe(200_000);
    expect(contextWindowFor("google/gemini-3-pro")).toBe(1_000_000);
    expect(contextWindowFor("openai/gpt-5.2")).toBe(400_000);
    expect(contextWindowFor("openai/gpt-4o")).toBe(128_000);
    expect(contextWindowFor("mystery/model")).toBe(128_000);
  });
});

describe("compactMessages", () => {
  it("truncates bulky OLD tool results but keeps the task + last N verbatim", () => {
    const big = "X".repeat(5000);
    const messages: ModelMessage[] = [
      { role: "user", content: "TASK: fix the bug" }, // protected (first user)
      { role: "assistant", content: [{ type: "text", text: "reading" }] as never },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: big }] as never }, // OLD, unprotected → truncated
      { role: "assistant", content: [{ type: "text", text: "more" }] as never },
      { role: "assistant", content: [{ type: "text", text: "recent" }] as never },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c2", toolName: "bash", output: big }] as never }, // within last N → kept
    ];
    const { messages: out, compacted } = compactMessages(messages, { keepLastN: 3, contentCap: 500 });
    expect(compacted).toBe(true);
    // Task preserved verbatim.
    expect(out[0]!.content).toBe("TASK: fix the bug");
    // Old tool result truncated.
    const oldOut = (out[2]!.content as unknown as Array<{ output: string }>)[0]!.output;
    expect(oldOut.length).toBeLessThan(big.length);
    expect(oldOut).toContain("elided");
    // Recent tool result (within last 3) kept full.
    const recentOut = (out[5]!.content as unknown as Array<{ output: string }>)[0]!.output;
    expect(recentOut).toBe(big);
  });

  it("is a no-op for short transcripts and never mutates the input", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const snapshot = JSON.stringify(messages);
    const { compacted } = compactMessages(messages, { keepLastN: 8, contentCap: 100 });
    expect(compacted).toBe(false);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("truncates the { value } tool-output shape (ai@6)", () => {
    const big = "Y".repeat(3000);
    const messages: ModelMessage[] = [
      { role: "user", content: "task" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", output: { type: "text", value: big } }] as never },
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const { messages: out } = compactMessages(messages, { keepLastN: 2, contentCap: 200 });
    const val = (out[1]!.content as unknown as Array<{ output: { value: string } }>)[0]!.output.value;
    expect(val.length).toBeLessThan(big.length);
    expect(val).toContain("elided");
  });
});

describe("isRetryableModelError", () => {
  it("retries 429/5xx and the network/overload/stream family", () => {
    expect(isRetryableModelError({ statusCode: 429 })).toBe(true);
    expect(isRetryableModelError({ statusCode: 503 })).toBe(true);
    expect(isRetryableModelError(new Error("model is overloaded"))).toBe(true);
    expect(isRetryableModelError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableModelError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableModelError(new Error("stream error: premature close"))).toBe(true);
  });

  it("does NOT retry aborts, auth/402/4xx-other, or context overflow", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableModelError(abort)).toBe(false);
    expect(isRetryableModelError(new Error("401 unauthorized"))).toBe(false);
    expect(isRetryableModelError(new Error("insufficient_funds: add a positive credit balance"))).toBe(false);
    expect(isRetryableModelError({ statusCode: 400 })).toBe(false);
    expect(isRetryableModelError(new Error("context_length_exceeded"))).toBe(false);
  });
});

describe("isFatalAuthOrBillingError", () => {
  it("matches credit-balance, insufficient-funds, bad-key, and 401/403", () => {
    expect(
      isFatalAuthOrBillingError(
        new Error("A positive credit balance is required for all requests, please add credits."),
      ),
    ).toBe(true);
    expect(isFatalAuthOrBillingError(new Error("insufficient_funds"))).toBe(true);
    expect(isFatalAuthOrBillingError(new Error("Invalid API key provided"))).toBe(true);
    expect(isFatalAuthOrBillingError(new Error("401 unauthorized"))).toBe(true);
    expect(isFatalAuthOrBillingError(new Error("request failed with status 403"))).toBe(true);
  });

  it("does not flag transient or unrelated errors", () => {
    expect(isFatalAuthOrBillingError(new Error("model is overloaded"))).toBe(false);
    expect(isFatalAuthOrBillingError(new Error("context_length_exceeded"))).toBe(false);
    expect(isFatalAuthOrBillingError({ statusCode: 500 })).toBe(false);
  });
});

describe("isContextOverflowError", () => {
  it("matches the provider prompt-too-long family", () => {
    expect(isContextOverflowError(new Error("context_length_exceeded"))).toBe(true);
    expect(isContextOverflowError(new Error("This model's maximum context length is 200000 tokens"))).toBe(true);
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(true);
    expect(isContextOverflowError(new Error("429 rate limit"))).toBe(false);
  });
});

describe("backoffMs", () => {
  it("grows exponentially and stays within [0, cap] with injected rand", () => {
    // rand=1 → full exp; capped at 8000.
    expect(backoffMs(1, { baseMs: 500, capMs: 8000, rand: () => 1 })).toBe(500);
    expect(backoffMs(2, { baseMs: 500, capMs: 8000, rand: () => 1 })).toBe(1000);
    expect(backoffMs(10, { baseMs: 500, capMs: 8000, rand: () => 1 })).toBe(8000);
    // rand=0 → 0 (full jitter floor).
    expect(backoffMs(5, { rand: () => 0 })).toBe(0);
  });
});

describe("delay", () => {
  it("rejects with AbortError when the signal fires", async () => {
    const ac = new AbortController();
    const p = delay(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves immediately for ms<=0", async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });
});
