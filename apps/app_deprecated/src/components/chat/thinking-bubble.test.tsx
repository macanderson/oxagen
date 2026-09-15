// @vitest-environment jsdom
/**
 * thinking-bubble.test.tsx
 *
 * Tests for ThinkingBubble:
 *   1. Renders with role="status" and aria-label="Thinking"
 *   2. Renders exactly 3 dots
 *   3. Applies custom className alongside defaults
 *   4. Has data-component="thinking-bubble"
 *   5. Reduced-motion path renders correctly (useReducedMotion → true)
 *   6. Normal-motion path renders correctly (useReducedMotion → false)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ThinkingBubble } from "./thinking-bubble";

afterEach(cleanup);

// Declare mock type before vi.mock so TypeScript is happy
const mockUseReducedMotion = vi.fn<() => boolean>(() => false);

vi.mock("motion/react", () => ({
  motion: {
    span: ({
      children,
      className,
      animate,
      transition,
      ...props
    }: {
      children?: React.ReactNode;
      className?: string;
      animate?: unknown;
      transition?: unknown;
      [key: string]: unknown;
    }) => (
      <span
        className={className}
        data-animate={JSON.stringify(animate)}
        {...(props as React.HTMLAttributes<HTMLSpanElement>)}
      >
        {children}
      </span>
    ),
  },
  useReducedMotion: () => mockUseReducedMotion(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("ThinkingBubble", () => {
  it("renders with role='status' and aria-label='Thinking'", () => {
    render(<ThinkingBubble />);
    const el = screen.getByRole("status");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("aria-label", "Thinking");
  });

  it("renders exactly 3 dots", () => {
    render(<ThinkingBubble />);
    // The motion.span mock renders as <span> elements inside the container.
    // The container itself is a div; the dots are spans.
    const container = screen.getByRole("status");
    const dots = container.querySelectorAll("span");
    expect(dots).toHaveLength(3);
  });

  it("applies custom className alongside defaults", () => {
    render(<ThinkingBubble className="my-custom-class" />);
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute(
      "class",
      expect.stringContaining("my-custom-class"),
    );
    expect(el).toHaveAttribute("class", expect.stringContaining("flex"));
  });

  it("has data-component='thinking-bubble'", () => {
    render(<ThinkingBubble />);
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("data-component", "thinking-bubble");
  });

  it("renders reduced-motion animation when useReducedMotion returns true", () => {
    mockUseReducedMotion.mockReturnValue(true);
    render(<ThinkingBubble />);
    const container = screen.getByRole("status");
    const dots = container.querySelectorAll("span[data-animate]");
    expect(dots).toHaveLength(3);
    // Each dot should have the reduced-motion animate value: { opacity: 0.7 }
    dots.forEach((dot) => {
      const animate = JSON.parse(dot.getAttribute("data-animate") ?? "null");
      expect(animate).toEqual({ opacity: 0.7 });
    });
  });

  it("renders normal-motion animation when useReducedMotion returns false", () => {
    mockUseReducedMotion.mockReturnValue(false);
    render(<ThinkingBubble />);
    const container = screen.getByRole("status");
    const dots = container.querySelectorAll("span[data-animate]");
    expect(dots).toHaveLength(3);
    // Each dot should have the full y+opacity animate array
    dots.forEach((dot) => {
      const animate = JSON.parse(dot.getAttribute("data-animate") ?? "null");
      expect(animate).toEqual({ y: [0, -5, 0], opacity: [0.5, 1, 0.5] });
    });
  });
});
