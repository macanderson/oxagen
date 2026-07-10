// @vitest-environment jsdom
/**
 * memory-card.test.tsx
 *
 * Render tests for MemoryCard:
 *   - Renders null when memories is empty
 *   - Renders recalled memories with lessons, class labels, confidence/enforcement, scores
 *   - Respects topN limit
 *   - Renders node refs as links when present
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TenantProvider, type ActiveTenant } from "@/lib/tenant/tenant-context";
import { MemoryCard } from "./memory-card";

// Stub NodeRef (it has its own tests) so these assertions target MemoryCard's
// wiring — that it cites the grounding node and links into the graph explorer.
vi.mock("@/components/knowledge/graph/node-ref", () => ({
  NodeRef: ({ node }: { node: { displayName: string } }) => (
    <span data-testid="node-ref">{node.displayName}</span>
  ),
}));

// next/link needs no app-router context in these render tests — render a plain
// anchor so href assertions are deterministic.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

const TENANT: ActiveTenant = {
  orgId: "o1",
  orgSlug: "acme",
  orgName: "Acme",
  workspaceId: "w1",
  workspaceSlug: "core",
  workspaceName: "Core",
};

const withNode = {
  id: "node-42",
  label: "Feature",
  displayName: "Metered Billing",
  properties: { owner: "platform" },
};

// TruncatedText (the lesson body renderer) measures scroll overflow via
// ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Brain: vi.fn(() => <span aria-hidden="true" data-testid="brain-icon" />),
  };
});

const makeMemory = (
  id: string,
  lesson: string,
  memoryClass: string,
  score: number,
  opts: { nodeRef?: string; confidenceScore?: number; enforcementScore?: number | null } = {},
) => ({
  id,
  lesson,
  memoryClass,
  memoryKind: "constraint",
  confidenceScore: opts.confidenceScore ?? 80,
  enforcementScore: opts.enforcementScore === undefined ? null : opts.enforcementScore,
  score,
  nodeRef: opts.nodeRef,
});

describe("MemoryCard", () => {
  it("renders null when memories list is empty", () => {
    const { container } = render(<MemoryCard queryId="q1" memories={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the 'Recalled memories' heading when there are memories", () => {
    const memories = [makeMemory("m1", "Always test your code", "FACT", 0.95)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("Recalled memories")).toBeInTheDocument();
  });

  it("renders lesson text for each memory", () => {
    const memories = [
      makeMemory("m1", "First lesson", "FACT", 0.9),
      makeMemory("m2", "Second lesson", "RULE", 0.7),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("First lesson")).toBeInTheDocument();
    expect(screen.getByText("Second lesson")).toBeInTheDocument();
  });

  it("renders score in a tabular-nums span", () => {
    const memories = [makeMemory("m1", "A lesson", "FACT", 0.85)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("score 0.85")).toBeInTheDocument();
  });

  it("renders confidence percentage for each memory", () => {
    const memories = [makeMemory("m1", "A lesson", "FACT", 0.85, { confidenceScore: 92 })];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("confidence 92%")).toBeInTheDocument();
  });

  it("renders enforcement score only when present (RULE/FACT)", () => {
    const memories = [
      makeMemory("m1", "A rule", "RULE", 0.9, { enforcementScore: 75 }),
      makeMemory("m2", "An observation", "OBSERVATION", 0.5, { enforcementScore: null }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("enforcement 75")).toBeInTheDocument();
    // Only one enforcement line rendered (the OBSERVATION has none).
    expect(screen.getAllByText(/enforcement /)).toHaveLength(1);
  });

  it("renders the class label for each memory", () => {
    const memories = [
      makeMemory("m1", "Lesson A", "FACT", 0.9),
      makeMemory("m2", "Lesson B", "OBSERVATION", 0.5),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("FACT")).toBeInTheDocument();
    expect(screen.getByText("OBSERVATION")).toBeInTheDocument();
  });

  it("renders the memory count matching total memories", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9),
      makeMemory("m2", "L2", "RULE", 0.8),
      makeMemory("m3", "L3", "OBSERVATION", 0.5),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("limits rendered items to topN (default 5)", () => {
    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemory(`m${i}`, `Lesson ${i}`, "FACT", 0.9 - i * 0.05),
    );
    render(<MemoryCard queryId="q1" memories={memories} />);
    // Only first 5 lessons should appear
    expect(screen.getByText("Lesson 0")).toBeInTheDocument();
    expect(screen.getByText("Lesson 4")).toBeInTheDocument();
    expect(screen.queryByText("Lesson 5")).not.toBeInTheDocument();
  });

  it("respects a custom topN prop", () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory(`m${i}`, `Lesson ${i}`, "FACT", 0.9),
    );
    render(<MemoryCard queryId="q1" memories={memories} topN={2} />);
    expect(screen.getByText("Lesson 0")).toBeInTheDocument();
    expect(screen.getByText("Lesson 1")).toBeInTheDocument();
    expect(screen.queryByText("Lesson 2")).not.toBeInTheDocument();
  });

  it("renders nodeRef as a link when present", () => {
    const memories = [makeMemory("m1", "A lesson", "FACT", 0.9, { nodeRef: "node-abc-123" })];
    render(<MemoryCard queryId="q1" memories={memories} />);
    const link = screen.getByText("node-abc-123");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "#node-abc-123");
  });

  it("does not render a nodeRef link when nodeRef is absent", () => {
    const memories = [makeMemory("m1", "A lesson", "RULE", 0.7)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    // No anchor elements should exist in the rendered output
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders the 'FACT' class in success tone", () => {
    const memories = [makeMemory("m1", "L", "FACT", 0.9)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("FACT").className).toContain("text-success");
  });

  it("renders the 'RULE' class in warning tone", () => {
    const memories = [makeMemory("m1", "L", "RULE", 0.7)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("RULE").className).toContain("text-warning");
  });

  it("renders the 'OBSERVATION' class in muted tone", () => {
    const memories = [makeMemory("m1", "L", "OBSERVATION", 0.3)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("OBSERVATION").className).toContain("text-muted-foreground");
  });

  it("renders the lesson body through TruncatedText, not a raw <p> element", () => {
    const memories = [makeMemory("m1", "A recalled lesson.", "FACT", 0.9)];
    const { container } = render(<MemoryCard queryId="q1" memories={memories} />);
    // The old plain-text renderer used <p className="whitespace-pre-wrap ...">
    // directly; TruncatedText replaces it with a clamped <span> preview.
    expect(container.querySelector("p.whitespace-pre-wrap")).toBeNull();
    expect(screen.getByText("A recalled lesson.")).toBeInTheDocument();
  });
});

describe("MemoryCard — grounding-node citations", () => {
  it("cites the grounding node via NodeRef when the memory resolves a graph node", () => {
    const memories = [
      { ...makeMemory("m1", "Usage rolls up to Stripe", "FACT", 0.9), node: withNode },
    ];
    render(
      <TenantProvider value={TENANT}>
        <MemoryCard queryId="q1" memories={memories} />
      </TenantProvider>,
    );
    expect(screen.getByTestId("node-ref")).toHaveTextContent("Metered Billing");
    // The raw-id fallback anchor must NOT render when a node is resolved.
    expect(screen.queryByText("node-42")).not.toBeInTheDocument();
  });

  it("renders a 'View in graph' deep-link to the explorer focused on the node", () => {
    const memories = [
      { ...makeMemory("m1", "Grounded fact", "FACT", 0.9), node: withNode },
    ];
    render(
      <TenantProvider value={TENANT}>
        <MemoryCard queryId="q1" memories={memories} />
      </TenantProvider>,
    );
    const link = screen.getByRole("link", {
      name: /view metered billing in the knowledge graph/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "/acme/core/knowledge/explore?focus=node-42",
    );
  });

  it("omits the 'View in graph' link when rendered outside a workspace route (no tenant)", () => {
    const memories = [
      { ...makeMemory("m1", "Grounded fact", "FACT", 0.9), node: withNode },
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    // NodeRef still cites the fact, but there is no graph deep-link without slugs.
    expect(screen.getByTestId("node-ref")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("omits the 'View in graph' link when the node is not materialised (id null)", () => {
    const memories = [
      {
        ...makeMemory("m1", "Pending fact", "OBSERVATION", 0.4),
        node: { ...withNode, id: null },
      },
    ];
    render(
      <TenantProvider value={TENANT}>
        <MemoryCard queryId="q1" memories={memories} />
      </TenantProvider>,
    );
    expect(screen.getByTestId("node-ref")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
