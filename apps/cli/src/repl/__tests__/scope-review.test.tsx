import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ScopeReview } from "../scope-review.js";
import { formatUsd } from "../../agent/rate-card.js";
import type {
  ScopeReviewInfo,
  ScopeReviewDecision,
} from "@oxagen/agent-engine";

const ESC = String.fromCharCode(27);

/** Poll until `cond` holds — Ink delivers stdin/state asynchronously (never fixed sleeps). */
async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function makeInfo(overrides: Partial<ScopeReviewInfo> = {}): ScopeReviewInfo {
  return {
    originalPrompt: "fix the login bug",
    refinedPrompt: "fix the login bug",
    enhancedPrompt:
      "fix the login bug\n\nContext: auth.ts handles session tokens.",
    context: "auth.ts handles session tokens.",
    model: "anthropic/claude-sonnet-5",
    tier: "balanced",
    estimatedInputTokens: 1200,
    estimatedOutputTokens: 800,
    estimatedCostUsd: 0.0456,
    ...overrides,
  };
}

describe("ScopeReview", () => {
  it("renders the original + enhanced prompt, model, and estimated cost", () => {
    const info = makeInfo();
    const onDecision = vi.fn();
    const { lastFrame } = render(
      <ScopeReview info={info} onDecision={onDecision} width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fix the login bug");
    expect(frame).toContain("auth.ts handles session tokens.");
    expect(frame).toContain("claude-sonnet-5");
    expect(frame).toContain(formatUsd(info.estimatedCostUsd));
  });

  it("pressing Enter calls onDecision exactly once with proceed: true", async () => {
    const info = makeInfo();
    let decision: ScopeReviewDecision | undefined;
    const onDecision = vi.fn((d: ScopeReviewDecision) => {
      decision = d;
    });
    const { stdin } = render(
      <ScopeReview info={info} onDecision={onDecision} width={80} />,
    );
    stdin.write("\r");
    await until(() => onDecision.mock.calls.length > 0);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({ proceed: true });
  });

  it("pressing n calls onDecision with proceed: false", async () => {
    const info = makeInfo();
    const onDecision = vi.fn();
    const { stdin } = render(
      <ScopeReview info={info} onDecision={onDecision} width={80} />,
    );
    stdin.write("n");
    await until(() => onDecision.mock.calls.length > 0);
    expect(onDecision).toHaveBeenCalledWith({ proceed: false });
  });

  it("pressing Esc calls onDecision with proceed: false", async () => {
    const info = makeInfo();
    const onDecision = vi.fn();
    const { stdin } = render(
      <ScopeReview info={info} onDecision={onDecision} width={80} />,
    );
    stdin.write(ESC);
    await until(() => onDecision.mock.calls.length > 0);
    expect(onDecision).toHaveBeenCalledWith({ proceed: false });
  });

  it("pressing e, typing, then Enter calls onDecision with the edited prompt", async () => {
    const info = makeInfo();
    let decision: ScopeReviewDecision | undefined;
    const onDecision = vi.fn((d: ScopeReviewDecision) => {
      decision = d;
    });
    const { stdin, lastFrame } = render(
      <ScopeReview info={info} onDecision={onDecision} width={80} />,
    );
    stdin.write("e");
    await until(() => (lastFrame() ?? "").includes("Edit the prompt"));
    stdin.write(" extra detail");
    await until(() => (lastFrame() ?? "").includes("extra detail"));
    stdin.write("\r");
    await until(() => onDecision.mock.calls.length > 0);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(decision?.proceed).toBe(true);
    if (decision?.proceed) {
      expect(decision.prompt).toContain("extra detail");
      expect(decision.prompt).toContain(info.enhancedPrompt);
    }
  });

  it("Esc during edit mode returns to review without calling onDecision", async () => {
    const info = makeInfo();
    const onDecision = vi.fn();
    const { stdin, lastFrame } = render(
      <ScopeReview info={info} onDecision={onDecision} width={80} />,
    );
    stdin.write("e");
    await until(() => (lastFrame() ?? "").includes("Edit the prompt"));
    stdin.write(ESC);
    await until(() => (lastFrame() ?? "").includes("Review scope & cost"));
    expect(onDecision).not.toHaveBeenCalled();
  });
});
