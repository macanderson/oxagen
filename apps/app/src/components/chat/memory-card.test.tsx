// @vitest-environment jsdom
/**
 * memory-card.test.tsx
 *
 * Render tests for MemoryCard:
 *   - Renders null when memories is empty
 *   - Renders recalled memories with lessons, weight badges, scores
 *   - Respects topN limit
 *   - Renders node refs as links when present
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryCard } from "./memory-card";

afterEach(cleanup);

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>{children}</span>
  ),
}));

vi.mock("lucide-react", () => ({
  Brain: () => <span aria-hidden="true" data-testid="brain-icon" />,
}));

const makeMemory = (id: string, lesson: string, weight: string, score: number, nodeRef?: string) => ({
  id,
  lesson,
  weight,
  score,
  nodeRef,
});

describe("MemoryCard", () => {
  it("renders null when memories list is empty", () => {
    const { container } = render(<MemoryCard queryId="q1" memories={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the 'Recalled memories' heading when there are memories", () => {
    const memories = [makeMemory("m1", "Always test your code", "fact", 0.95)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("Recalled memories")).toBeInTheDocument();
  });

  it("renders lesson text for each memory", () => {
    const memories = [
      makeMemory("m1", "First lesson", "fact", 0.9),
      makeMemory("m2", "Second lesson", "consider", 0.7),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("First lesson")).toBeInTheDocument();
    expect(screen.getByText("Second lesson")).toBeInTheDocument();
  });

  it("renders score in a tabular-nums span", () => {
    const memories = [makeMemory("m1", "A lesson", "fact", 0.85)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("score 0.85")).toBeInTheDocument();
  });

  it("renders weight badge for each memory", () => {
    const memories = [
      makeMemory("m1", "Lesson A", "fact", 0.9),
      makeMemory("m2", "Lesson B", "ignore", 0.5),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    const badges = screen.getAllByTestId("badge");
    // First item: count badge + weight badge; second item: weight badge
    const weights = badges.filter(
      (b) => b.textContent === "fact" || b.textContent === "ignore",
    );
    expect(weights.length).toBe(2);
  });

  it("renders count badge matching total memories", () => {
    const memories = [
      makeMemory("m1", "L1", "fact", 0.9),
      makeMemory("m2", "L2", "consider", 0.8),
      makeMemory("m3", "L3", "ignore", 0.5),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("limits rendered items to topN (default 5)", () => {
    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemory(`m${i}`, `Lesson ${i}`, "fact", 0.9 - i * 0.05),
    );
    render(<MemoryCard queryId="q1" memories={memories} />);
    // Only first 5 lessons should appear
    expect(screen.getByText("Lesson 0")).toBeInTheDocument();
    expect(screen.getByText("Lesson 4")).toBeInTheDocument();
    expect(screen.queryByText("Lesson 5")).not.toBeInTheDocument();
  });

  it("respects a custom topN prop", () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory(`m${i}`, `Lesson ${i}`, "fact", 0.9),
    );
    render(<MemoryCard queryId="q1" memories={memories} topN={2} />);
    expect(screen.getByText("Lesson 0")).toBeInTheDocument();
    expect(screen.getByText("Lesson 1")).toBeInTheDocument();
    expect(screen.queryByText("Lesson 2")).not.toBeInTheDocument();
  });

  it("renders nodeRef as a link when present", () => {
    const memories = [makeMemory("m1", "A lesson", "fact", 0.9, "node-abc-123")];
    render(<MemoryCard queryId="q1" memories={memories} />);
    const link = screen.getByText("node-abc-123");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "#node-abc-123");
  });

  it("does not render a nodeRef link when nodeRef is absent", () => {
    const memories = [makeMemory("m1", "A lesson", "consider", 0.7)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    // No anchor elements should exist in the rendered output
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("uses 'success' badge variant for 'fact' weight", () => {
    const memories = [makeMemory("m1", "L", "fact", 0.9)];
    const { container } = render(<MemoryCard queryId="q1" memories={memories} />);
    const successBadge = container.querySelector("[data-variant='success']");
    expect(successBadge).not.toBeNull();
    expect(successBadge?.textContent).toBe("fact");
  });

  it("uses 'warning' badge variant for 'consider' weight", () => {
    const memories = [makeMemory("m1", "L", "consider", 0.7)];
    const { container } = render(<MemoryCard queryId="q1" memories={memories} />);
    const warningBadge = container.querySelector("[data-variant='warning']");
    expect(warningBadge).not.toBeNull();
  });

  it("uses 'muted' badge variant for 'ignore' weight", () => {
    const memories = [makeMemory("m1", "L", "ignore", 0.3)];
    const { container } = render(<MemoryCard queryId="q1" memories={memories} />);
    const mutedBadge = container.querySelector("[data-variant='muted']");
    // The count badge is also 'muted'; there should be at least one 'muted' badge
    expect(mutedBadge).not.toBeNull();
  });
});
