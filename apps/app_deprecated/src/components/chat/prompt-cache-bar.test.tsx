// @vitest-environment jsdom
/**
 * prompt-cache-bar.test.tsx
 *
 * Render tests for PromptCacheBar — the per-turn prompt-cache token-layer meter:
 *   (a) renders nothing when there are no tokens at all
 *   (b) computes the cache-hit rate over the PROMPT (not the total)
 *   (c) renders one segment per non-zero layer, none for zero layers
 *   (d) clamps cached tokens to the prompt size (noisy provider counts)
 *   (e) exposes an accessible, full-sentence aria-label + data attributes
 *   (f) formats a whole-number hit rate without a trailing ".0"
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { cloneElement, isValidElement } from "react";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Render both the trigger element (`render`) AND the tooltip children so the
// bar + caption are in the tree; render the popup content too for assertions.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render: trigger,
    children,
  }: {
    render: React.ReactElement;
    children: React.ReactNode;
  }) => (isValidElement(trigger) ? cloneElement(trigger, {}, children) : null),
  TooltipPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { PromptCacheBar } from "./prompt-cache-bar";

describe("PromptCacheBar", () => {
  it("(a) renders nothing when there are no tokens", () => {
    const { container } = render(
      <PromptCacheBar promptTokens={0} completionTokens={0} cachedTokens={0} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("(b) computes the cache-hit rate over the prompt only", () => {
    // 800 of 1000 prompt tokens cached = 80% — output (500) does not dilute it.
    render(
      <PromptCacheBar
        promptTokens={1000}
        completionTokens={500}
        cachedTokens={800}
      />,
    );
    const bar = screen.getByTestId("prompt-cache-bar");
    expect(bar.getAttribute("data-hit-rate")).toBe("80.0");
    // Caption shows "80% cached" (whole number → no ".0").
    expect(screen.getAllByText(/80% cached/).length).toBeGreaterThan(0);
  });

  it("(c) renders one segment per non-zero layer", () => {
    render(
      <PromptCacheBar
        promptTokens={1000}
        completionTokens={500}
        cachedTokens={800}
      />,
    );
    const bar = screen.getByTestId("prompt-cache-bar");
    const layers = bar.querySelectorAll("[data-layer]");
    // cached + fresh + output all non-zero → 3 segments.
    expect(layers.length).toBe(3);
    expect(bar.querySelector('[data-layer="cached"]')).not.toBeNull();
    expect(bar.querySelector('[data-layer="fresh"]')).not.toBeNull();
    expect(bar.querySelector('[data-layer="output"]')).not.toBeNull();
  });

  it("(c') omits zero-width layers", () => {
    // No cache hits and no output → only the "fresh" layer renders.
    render(
      <PromptCacheBar
        promptTokens={1000}
        completionTokens={0}
        cachedTokens={0}
      />,
    );
    const bar = screen.getByTestId("prompt-cache-bar");
    expect(bar.querySelectorAll("[data-layer]").length).toBe(1);
    expect(bar.querySelector('[data-layer="fresh"]')).not.toBeNull();
    expect(bar.getAttribute("data-hit-rate")).toBe("0.0");
  });

  it("(d) clamps cached tokens to the prompt size", () => {
    // Provider reported 1500 cached against a 1000-token prompt → clamp to 100%.
    render(
      <PromptCacheBar
        promptTokens={1000}
        completionTokens={0}
        cachedTokens={1500}
      />,
    );
    const bar = screen.getByTestId("prompt-cache-bar");
    expect(bar.getAttribute("data-hit-rate")).toBe("100.0");
    expect(screen.getAllByText(/100% cached/).length).toBeGreaterThan(0);
  });

  it("(e) exposes an accessible, full-sentence aria-label", () => {
    render(
      <PromptCacheBar
        promptTokens={1000}
        completionTokens={500}
        cachedTokens={800}
      />,
    );
    const img = screen.getByRole("img");
    const label = img.getAttribute("aria-label") ?? "";
    expect(label).toContain("80% hit rate");
    expect(label).toContain("800 cached");
    expect(label).toContain("200 fresh input");
    expect(label).toContain("500 output");
  });

  it("(f) formats a fractional hit rate to one decimal", () => {
    // 1 of 3 cached = 33.333…% → "33.3%".
    render(
      <PromptCacheBar promptTokens={3} completionTokens={0} cachedTokens={1} />,
    );
    expect(screen.getAllByText(/33\.3% cached/).length).toBeGreaterThan(0);
  });
});
