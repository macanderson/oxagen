import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
  backoffMs,
  compactMessages,
  contextWindowFor,
  delay,
  estimateMessageTokens,
  IMAGE_PART_TOKENS,
  FILE_PART_TOKENS,
  isContextOverflowError,
  isFatalAuthOrBillingError,
  isMutatingTool,
  isRetryableModelError,
  loopNudgeMessage,
  midFlightRetryMessage,
  MUTATING_TOOL_NAMES,
  StreamStallError,
  successfulRepeatNudgeMessage,
  SUCCESSFUL_REPEAT_THRESHOLD,
  toolCallSignature,
  withSlowWaitBreadcrumb,
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
      toolCallSignature("search", { command: "ls" }),
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
    const msg = successfulRepeatNudgeMessage(
      "bash",
      SUCCESSFUL_REPEAT_THRESHOLD,
    );
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
      {
        role: "assistant",
        content: [{ type: "text", text: "b".repeat(400) }] as never,
      },
    ];
    // ~400 + ~(json of the array) → both counted; comfortably > 100 tokens.
    expect(estimateMessageTokens(messages)).toBeGreaterThan(150);
  });

  it("returns 0 for empty content", () => {
    expect(estimateMessageTokens([{ role: "user", content: "" }])).toBe(0);
  });

  it("costs a large base64 image at the flat per-asset constant, not its length", () => {
    // A ~1 MB base64 image payload: length/4 would be ~350k tokens. It must be
    // counted flat instead, so a single screenshot never stampedes compaction.
    const bigImage = "A".repeat(1_400_000);
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this screenshot?" },
          { type: "image", image: bigImage, mediaType: "image/png" },
        ] as never,
      },
    ];
    const tokens = estimateMessageTokens(messages);
    // Near the image constant + the short text, NOT hundreds of thousands.
    expect(tokens).toBeLessThan(IMAGE_PART_TOKENS + 100);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_PART_TOKENS);
  });

  it("costs a base64 video/file part at the flat file constant", () => {
    const bigVideo = "B".repeat(3_000_000);
    const tokens = estimateMessageTokens([
      {
        role: "user",
        content: [
          { type: "file", data: bigVideo, mediaType: "video/mp4" },
        ] as never,
      },
    ]);
    expect(tokens).toBe(FILE_PART_TOKENS);
  });

  it("does NOT trigger compaction for a small conversation that carries one image", () => {
    // Reproduces the C3 defect: an otherwise-tiny turn with one image must stay
    // far below any reasonable compaction threshold (0.8 × a 200k window).
    const image = "C".repeat(2_000_000);
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "image", image, mediaType: "image/png" }] as never,
      },
      { role: "assistant", content: "Looks like a login screen." },
    ];
    expect(estimateMessageTokens(messages)).toBeLessThan(200_000 * 0.8);
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
    // Distinct payloads so this exercises POSITIONAL truncation, not the
    // content-identity dedup (which owns the identical-output case below).
    const oldBig = "X".repeat(5000);
    const recentBig = "Z".repeat(5000);
    const messages: ModelMessage[] = [
      { role: "user", content: "TASK: fix the bug" }, // protected (first user)
      {
        role: "assistant",
        content: [{ type: "text", text: "reading" }] as never,
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read_file",
            output: oldBig,
          },
        ] as never,
      }, // OLD, unprotected → truncated
      { role: "assistant", content: [{ type: "text", text: "more" }] as never },
      {
        role: "assistant",
        content: [{ type: "text", text: "recent" }] as never,
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "bash",
            output: recentBig,
          },
        ] as never,
      }, // within last N → kept
    ];
    const { messages: out, compacted } = compactMessages(messages, {
      keepLastN: 3,
      contentCap: 500,
    });
    expect(compacted).toBe(true);
    // Task preserved verbatim.
    expect(out[0]!.content).toBe("TASK: fix the bug");
    // Old tool result truncated.
    const oldOut = (out[2]!.content as unknown as Array<{ output: string }>)[0]!
      .output;
    expect(oldOut.length).toBeLessThan(oldBig.length);
    expect(oldOut).toContain("elided");
    // Recent tool result (within last 3) kept full.
    const recentOut = (
      out[5]!.content as unknown as Array<{ output: string }>
    )[0]!.output;
    expect(recentOut).toBe(recentBig);
  });

  it("elides earlier exact-duplicate tool outputs, keeps the last copy full, spares small dups + the task", () => {
    const dupBig = "D".repeat(800); // ≥ 500 → dedup candidate
    const dupSmall = "s".repeat(100); // < 500 → never deduped
    const messages: ModelMessage[] = [
      { role: "user", content: "TASK: keep me" }, // 0 first user (never elided)
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "read_file",
            output: dupBig,
          },
        ] as never,
      }, // 1 earlier big dup → elided
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "b",
            toolName: "read_file",
            output: dupSmall,
          },
        ] as never,
      }, // 2 earlier small dup → kept
      { role: "assistant", content: "thinking" }, // 3
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "read_file",
            output: dupSmall,
          },
        ] as never,
      }, // 4 later small dup → kept
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "d",
            toolName: "read_file",
            output: dupBig,
          },
        ] as never,
      }, // 5 later big dup → kept full
    ];
    // Huge contentCap so positional truncation is a no-op — isolate the dedup pass.
    const { messages: out, compacted } = compactMessages(messages, {
      keepLastN: 2,
      contentCap: 100_000,
    });
    expect(compacted).toBe(true);
    // Task untouched.
    expect(out[0]!.content).toBe("TASK: keep me");
    // Earlier big duplicate elided to the one-line dedup marker (does NOT tell
    // the model to re-read — the content is still present later).
    const earlierBig = (
      out[1]!.content as unknown as Array<{ output: string }>
    )[0]!.output;
    expect(earlierBig).toContain("duplicate tool output elided");
    expect(earlierBig).not.toContain("re-read");
    expect(earlierBig.length).toBeLessThan(dupBig.length);
    // Later (last) big duplicate kept full.
    const laterBig = (
      out[5]!.content as unknown as Array<{ output: string }>
    )[0]!.output;
    expect(laterBig).toBe(dupBig);
    // Small duplicates untouched on BOTH sides.
    expect(
      (out[2]!.content as unknown as Array<{ output: string }>)[0]!.output,
    ).toBe(dupSmall);
    expect(
      (out[4]!.content as unknown as Array<{ output: string }>)[0]!.output,
    ).toBe(dupSmall);
  });

  it("dedups a duplicate in the PROTECTED tail (dedup ignores keepLastN)", () => {
    const dupBig = "Q".repeat(700);
    const messages: ModelMessage[] = [
      { role: "user", content: "task" }, // 0
      { role: "assistant", content: "pad" }, // 1
      { role: "assistant", content: "pad2" }, // 2
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "read_file",
            output: dupBig,
          },
        ] as never,
      }, // 3 earlier dup, inside protected tail
      { role: "assistant", content: "x" }, // 4
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "b",
            toolName: "read_file",
            output: dupBig,
          },
        ] as never,
      }, // 5 later dup (kept)
    ];
    // keepLastN 4 → protectedFrom = 2, so indices 2..5 are protected; positional
    // truncation would keep index 3 verbatim, yet dedup must still reach it
    // because an identical copy exists later at index 5.
    const { messages: out, compacted } = compactMessages(messages, {
      keepLastN: 4,
      contentCap: 100_000,
    });
    expect(compacted).toBe(true);
    const earlier = (
      out[3]!.content as unknown as Array<{ output: string }>
    )[0]!.output;
    const later = (out[5]!.content as unknown as Array<{ output: string }>)[0]!
      .output;
    expect(earlier).toContain("duplicate tool output elided");
    expect(later).toBe(dupBig);
  });

  it("runs dedup BEFORE positional truncation: a unique bulky middle is still positionally truncated", () => {
    const uniqueBig = "U".repeat(1000); // unique → positionally truncated
    const dupBig = "D".repeat(1000); // duplicated → deduped, not positionally truncated
    const messages: ModelMessage[] = [
      { role: "user", content: "TASK" }, // 0
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "u",
            toolName: "read_file",
            output: uniqueBig,
          },
        ] as never,
      }, // 1 unique → truncate
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "d1",
            toolName: "read_file",
            output: dupBig,
          },
        ] as never,
      }, // 2 earlier dup → elide
      { role: "assistant", content: "x" }, // 3
      { role: "assistant", content: "y" }, // 4
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "d2",
            toolName: "read_file",
            output: dupBig,
          },
        ] as never,
      }, // 5 later dup → kept
    ];
    const { messages: out, compacted } = compactMessages(messages, {
      keepLastN: 3,
      contentCap: 500,
    });
    expect(compacted).toBe(true);
    // Unique middle: positionally truncated to cap + the compaction marker.
    const uniqueOut = (
      out[1]!.content as unknown as Array<{ output: string }>
    )[0]!.output;
    expect(uniqueOut.length).toBeLessThan(uniqueBig.length);
    expect(uniqueOut).toContain("re-read"); // the positional COMPACTION_MARKER
    expect(uniqueOut).not.toContain("duplicate tool output elided");
    // Earlier duplicate: replaced by the dedup marker (short) — NOT the sliced
    // cap+compaction form, proving dedup ran first and left nothing to truncate.
    const dupOut = (out[2]!.content as unknown as Array<{ output: string }>)[0]!
      .output;
    expect(dupOut).toBe(
      "[duplicate tool output elided — identical content appears later in the conversation]",
    );
    // Later duplicate (tail) kept full.
    expect(
      (out[5]!.content as unknown as Array<{ output: string }>)[0]!.output,
    ).toBe(dupBig);
  });

  it("never elides the first user message even if a later tool-result repeats it", () => {
    const shared = "R".repeat(900);
    const messages: ModelMessage[] = [
      { role: "user", content: shared }, // 0 first user — must stay full
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "z",
            toolName: "bash",
            output: shared,
          },
        ] as never,
      }, // later identical copy
    ];
    const { messages: out } = compactMessages(messages, {
      keepLastN: 2,
      contentCap: 100_000,
    });
    expect(out[0]!.content).toBe(shared);
  });

  it("is a no-op for short transcripts and never mutates the input", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const snapshot = JSON.stringify(messages);
    const { compacted } = compactMessages(messages, {
      keepLastN: 8,
      contentCap: 100,
    });
    expect(compacted).toBe(false);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("truncates the { value } tool-output shape (ai@6)", () => {
    const big = "Y".repeat(3000);
    const messages: ModelMessage[] = [
      { role: "user", content: "task" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            output: { type: "text", value: big },
          },
        ] as never,
      },
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const { messages: out } = compactMessages(messages, {
      keepLastN: 2,
      contentCap: 200,
    });
    const val = (
      out[1]!.content as unknown as Array<{ output: { value: string } }>
    )[0]!.output.value;
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
    expect(
      isRetryableModelError(new Error("stream error: premature close")),
    ).toBe(true);
  });

  it("does NOT retry aborts, auth/402/4xx-other, or context overflow", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableModelError(abort)).toBe(false);
    expect(isRetryableModelError(new Error("401 unauthorized"))).toBe(false);
    expect(
      isRetryableModelError(
        new Error("insufficient_funds: add a positive credit balance"),
      ),
    ).toBe(false);
    expect(isRetryableModelError({ statusCode: 400 })).toBe(false);
    expect(isRetryableModelError(new Error("context_length_exceeded"))).toBe(
      false,
    );
  });
});

describe("isFatalAuthOrBillingError", () => {
  it("matches credit-balance, insufficient-funds, bad-key, and 401/403", () => {
    expect(
      isFatalAuthOrBillingError(
        new Error(
          "A positive credit balance is required for all requests, please add credits.",
        ),
      ),
    ).toBe(true);
    expect(isFatalAuthOrBillingError(new Error("insufficient_funds"))).toBe(
      true,
    );
    expect(
      isFatalAuthOrBillingError(new Error("Invalid API key provided")),
    ).toBe(true);
    expect(isFatalAuthOrBillingError(new Error("401 unauthorized"))).toBe(true);
    expect(
      isFatalAuthOrBillingError(new Error("request failed with status 403")),
    ).toBe(true);
  });

  it("does not flag transient or unrelated errors", () => {
    expect(isFatalAuthOrBillingError(new Error("model is overloaded"))).toBe(
      false,
    );
    expect(
      isFatalAuthOrBillingError(new Error("context_length_exceeded")),
    ).toBe(false);
    expect(isFatalAuthOrBillingError({ statusCode: 500 })).toBe(false);
  });
});

describe("isContextOverflowError", () => {
  it("matches the provider prompt-too-long family", () => {
    expect(isContextOverflowError(new Error("context_length_exceeded"))).toBe(
      true,
    );
    expect(
      isContextOverflowError(
        new Error("This model's maximum context length is 200000 tokens"),
      ),
    ).toBe(true);
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(true);
    expect(isContextOverflowError(new Error("429 rate limit"))).toBe(false);
  });
});

describe("backoffMs", () => {
  it("grows exponentially and stays within [0, cap] with injected rand", () => {
    // rand=1 → full exp; capped at 8000.
    expect(backoffMs(1, { baseMs: 500, capMs: 8000, rand: () => 1 })).toBe(500);
    expect(backoffMs(2, { baseMs: 500, capMs: 8000, rand: () => 1 })).toBe(
      1000,
    );
    expect(backoffMs(10, { baseMs: 500, capMs: 8000, rand: () => 1 })).toBe(
      8000,
    );
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

  it("rejects immediately when the signal is ALREADY aborted (never waits the full duration)", async () => {
    // addEventListener('abort') does not fire for an abort dispatched before the
    // listener is attached, so without an up-front `signal.aborted` guard an
    // already-aborted signal would wait the full `ms`. Assert it rejects fast.
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    await expect(delay(10_000, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    // Rejected essentially instantly, not after ~10s.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("estimateMessageTokens caching", () => {
  it("returns the SAME total on repeated calls (memo is exact, not stale)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: "y".repeat(80) },
    ];
    const first = estimateMessageTokens(messages);
    const second = estimateMessageTokens(messages);
    expect(second).toBe(first);
    // ~400/4 + ~80/4 = 100 + 20.
    expect(first).toBe(Math.ceil(400 / 4) + Math.ceil(80 / 4));
  });

  it("equals the sum of the per-message estimates (cache never changes the value)", () => {
    const a: ModelMessage = { role: "user", content: "a".repeat(1000) };
    const b: ModelMessage = { role: "assistant", content: "b".repeat(200) };
    // Measure each alone (warms the cache per object), then together.
    const soloA = estimateMessageTokens([a]);
    const soloB = estimateMessageTokens([b]);
    expect(estimateMessageTokens([a, b])).toBe(soloA + soloB);
  });

  it("re-measures a NEW message object with different content (identity-keyed, self-invalidating)", () => {
    const original: ModelMessage = { role: "user", content: "z".repeat(40) };
    const before = estimateMessageTokens([original]); // 10 tokens
    // A rewrite (as compaction does) produces a NEW object → cache miss → exact.
    const rewritten: ModelMessage = { ...original, content: "z".repeat(4000) };
    const after = estimateMessageTokens([rewritten]);
    expect(before).toBe(10);
    expect(after).toBe(1000);
    // The original object's memo is untouched — still its own value.
    expect(estimateMessageTokens([original])).toBe(10);
  });
});

describe("MUTATING_TOOL_NAMES / isMutatingTool", () => {
  it("classifies every filesystem mutator as mutating, and reads as not", () => {
    expect(isMutatingTool("bash")).toBe(true);
    expect(isMutatingTool("write_file")).toBe(true);
    expect(isMutatingTool("edit_file")).toBe(true);
    // delete_file belongs here for the reason the set exists: a step that
    // deleted a file and THEN failed mid-stream must not be blindly retried,
    // because the retry re-runs the delete.
    expect(isMutatingTool("delete_file")).toBe(true);
    expect(isMutatingTool("read_file")).toBe(false);
    expect(isMutatingTool("search")).toBe(false);
    expect(isMutatingTool("code_graph")).toBe(false);
    expect(isMutatingTool("ask_user")).toBe(false);
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual([
      "bash",
      "delete_file",
      "edit_file",
      "write_file",
    ]);
  });
});

describe("midFlightRetryMessage", () => {
  it("names the mutating tools, dedupes/sorts them, and tells the model to re-inspect state", () => {
    const msg = midFlightRetryMessage(["bash", "write_file", "bash"]);
    expect(msg).toContain("bash, write_file"); // deduped + sorted
    expect(msg).not.toMatch(/bash.*bash/); // no duplicate
    expect(msg.toLowerCase()).toContain("not retried");
    expect(msg.toLowerCase()).toContain("re-inspect");
  });

  it("falls back to a generic phrase when the tool list is empty", () => {
    const msg = midFlightRetryMessage([]);
    expect(msg.toLowerCase()).toContain("state-changing tool");
  });
});

describe("StreamStallError + isRetryableModelError", () => {
  it("is a retryable error carrying the stall deadline", () => {
    const err = new StreamStallError(180_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StreamStallError");
    expect(err.stallMs).toBe(180_000);
    expect(isRetryableModelError(err)).toBe(true);
  });

  it("a plain AbortError stays NON-retryable (a stall must not be confused with a user cancel)", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableModelError(abort)).toBe(false);
    // The stall, by contrast, retries.
    expect(isRetryableModelError(new StreamStallError(1000))).toBe(true);
  });
});

describe("withSlowWaitBreadcrumb", () => {
  it("does NOT fire the breadcrumb when fn settles before the threshold", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      const p = withSlowWaitBreadcrumb(
        () => Promise.resolve("fast"),
        60_000,
        onSlow,
      );
      await expect(p).resolves.toBe("fast");
      // Advance well past the threshold — the timer was cleared on settle.
      vi.advanceTimersByTime(120_000);
      expect(onSlow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires the breadcrumb once when fn is still pending at the threshold, then resolves normally", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      let release!: (v: string) => void;
      const gate = new Promise<string>((r) => (release = r));
      const p = withSlowWaitBreadcrumb(() => gate, 60_000, onSlow);
      // Cross the threshold while fn is still pending → breadcrumb fires once.
      await vi.advanceTimersByTimeAsync(60_001);
      expect(onSlow).toHaveBeenCalledTimes(1);
      // The wait is NOT cancelled — only the human/producer resolves it.
      release("approved");
      await expect(p).resolves.toBe("approved");
      // Still only fired once.
      expect(onSlow).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer even when fn rejects", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      await expect(
        withSlowWaitBreadcrumb(
          () => Promise.reject(new Error("boom")),
          60_000,
          onSlow,
        ),
      ).rejects.toThrow("boom");
      vi.advanceTimersByTime(120_000);
      expect(onSlow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
