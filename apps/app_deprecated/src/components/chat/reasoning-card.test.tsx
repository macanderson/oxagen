// @vitest-environment jsdom
/**
 * reasoning-card.test.tsx
 *
 * Render + interaction tests for ReasoningCard:
 *   - Renders "Thinking…" label when status=thinking
 *   - Renders "Thought for Xs" label when status=done with durationMs
 *   - Renders "Reasoning" when status=done and no durationMs
 *   - Starts open when thinking, shows reasoning text in body
 *   - Starts closed (auto-collapsed) when status=done
 *   - Toggle button opens the body on click
 *   - Redacted reasoning (empty text): no toggle, static pill
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

vi.mock("motion/react", () => ({
  motion: {
    span: ({
      children,
      animate: _animate,
      ...rest
    }: React.HTMLAttributes<HTMLSpanElement> & { animate?: unknown }) => (
      <span {...rest}>{children}</span>
    ),
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      style,
      ...rest
    }: React.HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
    }) => (
      <div style={style} {...rest}>
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useReducedMotion: () => true, // use reduced motion in tests to bypass animation
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Brain: vi.fn(() => <span data-testid="icon-brain" />),
    ChevronDown: vi.fn(() => <span data-testid="icon-chevron-down" />),
    ChevronRight: vi.fn(() => <span data-testid="icon-chevron-right" />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@oxagen/ui/lib/motion", () => ({
  transition: { base: { duration: 0.15 } },
}));

vi.mock("./streaming-text", () => ({
  StreamingText: ({ text }: { text: string }) => (
    <div data-testid="streaming-text">{text}</div>
  ),
}));

// formatDuration is imported from tool-call-card, mock that module
vi.mock("./tool-call-card", () => ({
  formatDuration: (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${s}s`;
  },
  safeJson: (v: unknown) => JSON.stringify(v),
}));

describe("ReasoningCard", () => {
  it("renders 'Thinking…' when status=thinking", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(<ReasoningCard text="some reasoning" status="thinking" />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("renders 'Thought for Xs' when status=done with durationMs", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(
      <ReasoningCard text="done reasoning" status="done" durationMs={3000} />,
    );
    expect(screen.getByText("Thought for 3s")).toBeInTheDocument();
  });

  it("renders 'Reasoning' when status=done and no durationMs", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(<ReasoningCard text="done reasoning" status="done" />);
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
  });

  it("is open when thinking — shows streaming text in body", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(<ReasoningCard text="active thinking text" status="thinking" />);
    expect(screen.getByTestId("streaming-text")).toBeInTheDocument();
  });

  it("auto-collapses when status=done (body hidden)", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    // With reducedMotion=true, AnimatePresence doesn't animate — body is absent when closed
    render(<ReasoningCard text="done reasoning" status="done" />);
    // The streaming text should NOT appear since card starts closed on done
    expect(screen.queryByTestId("streaming-text")).not.toBeInTheDocument();
    // Static text in the done body is inside a <p> tag, also absent
    expect(screen.queryByText("done reasoning")).not.toBeInTheDocument();
  });

  it("toggle button opens the body on click when status=done", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(
      <ReasoningCard text="done reasoning" status="done" durationMs={1000} />,
    );
    const toggleBtn = screen.getByRole("button");
    // Initially closed
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggleBtn);
    await waitFor(() => {
      expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("shows reasoning text after toggle when status=done", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(<ReasoningCard text="my reasoning" status="done" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getByText("my reasoning")).toBeInTheDocument();
    });
  });

  it("renders Brain icon", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(<ReasoningCard text="text" status="thinking" />);
    expect(screen.getByTestId("icon-brain")).toBeInTheDocument();
  });

  it("has data-component='reasoning-card' attribute", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(<ReasoningCard text="text" status="thinking" />);
    expect(
      document.querySelector("[data-component='reasoning-card']"),
    ).toBeInTheDocument();
  });

  it("button is disabled for empty text (redacted reasoning)", async () => {
    const { ReasoningCard } = await import("./reasoning-card");
    render(<ReasoningCard text="" status="done" durationMs={2000} />);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
  });
});
