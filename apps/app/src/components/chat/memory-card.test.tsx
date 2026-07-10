// @vitest-environment jsdom
/**
 * memory-card.test.tsx
 *
 * Render tests for MemoryCard:
 *   - Renders null when memories is empty
 *   - Collapsed default: one-sentence node-type summary (counts, pluralization,
 *     dedupe by node id, uncited clause, all-uncited fallback, write variant)
 *   - Expand/collapse toggle (aria-expanded / aria-controls) reveals the unique
 *     NodeRef citation chips and per-memory detail rows
 *   - "View in graph" deep-link per chip when tenant slugs are available
 *   - Respects topN limit on the detail rows
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TenantProvider, type ActiveTenant } from "@/lib/tenant/tenant-context";
import { MemoryCard } from "./memory-card";

// Mock motion/react (the codebase test convention): motion.div → plain div,
// AnimatePresence → passthrough, reduced-motion on. This makes the expanded
// body mount/unmount synchronously with the `expanded` flag (no exit-hold), so
// the collapse assertions below don't race the height animation.
vi.mock("motion/react", () => ({
  motion: {
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
  useReducedMotion: () => true,
}));

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

const makeNode = (id: string | null, label: string, displayName: string) => ({
  id,
  label,
  displayName,
  properties: {},
});

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
  opts: {
    nodeRef?: string;
    confidenceScore?: number;
    enforcementScore?: number | null;
    node?: {
      id: string | null;
      label: string;
      displayName: string;
      properties: Record<string, unknown>;
    };
  } = {},
) => ({
  id,
  lesson,
  memoryClass,
  memoryKind: "constraint",
  confidenceScore: opts.confidenceScore ?? 80,
  enforcementScore:
    opts.enforcementScore === undefined ? null : opts.enforcementScore,
  score,
  nodeRef: opts.nodeRef,
  node: opts.node,
});

const expand = () =>
  fireEvent.click(screen.getByRole("button", { name: /show citations/i }));

describe("MemoryCard — collapsed summary sentence", () => {
  it("renders null when memories list is empty", () => {
    const { container } = render(<MemoryCard queryId="q1" memories={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("summarizes unique grounding nodes grouped by type, pluralized, deduped by id", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9, {
        node: makeNode("f1", "Feature", "Billing"),
      }),
      makeMemory("m2", "L2", "FACT", 0.8, {
        node: makeNode("f2", "Feature", "Metering"),
      }),
      // Same node id as m1 — must dedupe, not count a third Feature.
      makeMemory("m3", "L3", "RULE", 0.7, {
        node: makeNode("f1", "Feature", "Billing"),
      }),
      makeMemory("m4", "L4", "FACT", 0.6, {
        node: makeNode("r1", "Repository", "oxagen-platform"),
      }),
      makeMemory("m5", "L5", "OBSERVATION", 0.5, {
        node: makeNode("p1", "Person", "Ada"),
      }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(
      screen.getByText("Grounded in 2 Features, 1 Repository, and 1 Person."),
    ).toBeInTheDocument();
  });

  it("joins exactly two type clauses with 'and' (no comma)", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9, {
        node: makeNode("f1", "Feature", "Billing"),
      }),
      makeMemory("m2", "L2", "FACT", 0.8, {
        node: makeNode("p1", "Person", "Ada"),
      }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(
      screen.getByText("Grounded in 1 Feature and 1 Person."),
    ).toBeInTheDocument();
  });

  it("does not append 's' to a label that already ends in 's'", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9, {
        node: makeNode("s1", "Series", "A"),
      }),
      makeMemory("m2", "L2", "FACT", 0.8, {
        node: makeNode("s2", "Series", "B"),
      }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("Grounded in 2 Series.")).toBeInTheDocument();
  });

  it("counts unmaterialised nodes (id null) individually — no dedupe without an id", () => {
    const memories = [
      makeMemory("m1", "L1", "OBSERVATION", 0.4, {
        node: makeNode(null, "Feature", "Pending A"),
      }),
      makeMemory("m2", "L2", "OBSERVATION", 0.3, {
        node: makeNode(null, "Feature", "Pending B"),
      }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.getByText("Grounded in 2 Features.")).toBeInTheDocument();
  });

  it("appends a plural uncited-memories clause for memories with no resolved node", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9, { node: withNode }),
      makeMemory("m2", "L2", "RULE", 0.7),
      makeMemory("m3", "L3", "OBSERVATION", 0.5),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(
      screen.getByText("Grounded in 1 Feature, plus 2 uncited memories."),
    ).toBeInTheDocument();
  });

  it("uses singular 'memory' for a single uncited memory", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9, { node: withNode }),
      makeMemory("m2", "L2", "RULE", 0.7),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(
      screen.getByText("Grounded in 1 Feature, plus 1 uncited memory."),
    ).toBeInTheDocument();
  });

  it("falls back to a recalled-memories count when no memory resolved a node", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9),
      makeMemory("m2", "L2", "RULE", 0.7),
      makeMemory("m3", "L3", "OBSERVATION", 0.5),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(
      screen.getByText("Grounded in 3 recalled memories."),
    ).toBeInTheDocument();
  });

  it("uses the singular fallback for a single uncited memory", () => {
    const memories = [makeMemory("m1", "L1", "FACT", 0.9)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(
      screen.getByText("Grounded in 1 recalled memory."),
    ).toBeInTheDocument();
  });

  it("uses the 'Remembered' verb for the write variant (memwrite confirmation)", () => {
    const memories = [
      makeMemory("m1", "Memory written → pref-narrow-tests", "RULE", 1, {
        nodeRef: "pref-narrow-tests",
        confidenceScore: 100,
        enforcementScore: 90,
      }),
    ];
    render(<MemoryCard queryId="w1" memories={memories} variant="write" />);
    expect(screen.getByText("Remembered 1 memory.")).toBeInTheDocument();
  });

  it("keeps the Brain icon and memory-card chrome", () => {
    const memories = [makeMemory("m1", "L1", "FACT", 0.9)];
    const { container } = render(
      <MemoryCard queryId="q1" memories={memories} />,
    );
    expect(screen.getByTestId("brain-icon")).toBeInTheDocument();
    expect(
      container.querySelector("[data-component='memory-card']"),
    ).not.toBeNull();
  });
});

describe("MemoryCard — expand/collapse", () => {
  it("is collapsed by default: no citation chips or detail rows rendered", () => {
    const memories = [
      makeMemory("m1", "First lesson", "FACT", 0.9, { node: withNode }),
      makeMemory("m2", "Second lesson", "RULE", 0.7, { nodeRef: "node-abc" }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expect(screen.queryByTestId("node-ref")).not.toBeInTheDocument();
    expect(screen.queryByText("First lesson")).not.toBeInTheDocument();
    expect(screen.queryByText("node-abc")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show citations" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles aria-expanded and the accessible name when expanded", () => {
    const memories = [makeMemory("m1", "L1", "FACT", 0.9, { node: withNode })];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expand();
    const toggle = screen.getByRole("button", { name: "Hide citations" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: "Show citations" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("node-ref")).not.toBeInTheDocument();
  });

  it("points aria-controls at an element that exists in the document", () => {
    const memories = [makeMemory("m1", "L1", "FACT", 0.9)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    const toggle = screen.getByRole("button", { name: "Show citations" });
    const controls = toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls as string)).not.toBeNull();
  });

  it("expanding reveals one NodeRef chip per unique grounding node (deduped by id)", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9, {
        node: makeNode("f1", "Feature", "Billing"),
      }),
      makeMemory("m2", "L2", "RULE", 0.8, {
        node: makeNode("f1", "Feature", "Billing"),
      }),
      makeMemory("m3", "L3", "FACT", 0.7, {
        node: makeNode("p1", "Person", "Ada"),
      }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expand();
    const chips = screen.getAllByTestId("node-ref");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("Billing");
    expect(chips[1]).toHaveTextContent("Ada");
  });

  it("expanding reveals the per-memory detail rows (lesson, class, scores)", () => {
    const memories = [
      makeMemory("m1", "First lesson", "FACT", 0.85, {
        confidenceScore: 92,
        node: withNode,
      }),
      makeMemory("m2", "A rule", "RULE", 0.7, { enforcementScore: 75 }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expand();
    expect(screen.getByText("First lesson")).toBeInTheDocument();
    expect(screen.getByText("A rule")).toBeInTheDocument();
    expect(screen.getByText("confidence 92%")).toBeInTheDocument();
    expect(screen.getByText("enforcement 75")).toBeInTheDocument();
    expect(screen.getByText("score 0.85")).toBeInTheDocument();
    // Only one enforcement line rendered (the FACT has none).
    expect(screen.getAllByText(/enforcement /)).toHaveLength(1);
    const badges = screen.getAllByTestId("badge");
    expect(badges.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["FACT", "RULE"]),
    );
  });

  it("limits detail rows to topN (default 5)", () => {
    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemory(`m${i}`, `Lesson ${i}`, "FACT", 0.9 - i * 0.05),
    );
    render(<MemoryCard queryId="q1" memories={memories} />);
    expand();
    expect(screen.getByText("Lesson 0")).toBeInTheDocument();
    expect(screen.getByText("Lesson 4")).toBeInTheDocument();
    expect(screen.queryByText("Lesson 5")).not.toBeInTheDocument();
  });

  it("respects a custom topN prop", () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory(`m${i}`, `Lesson ${i}`, "FACT", 0.9),
    );
    render(<MemoryCard queryId="q1" memories={memories} topN={2} />);
    expand();
    expect(screen.getByText("Lesson 0")).toBeInTheDocument();
    expect(screen.getByText("Lesson 1")).toBeInTheDocument();
    expect(screen.queryByText("Lesson 2")).not.toBeInTheDocument();
  });

  it("renders the raw nodeRef fallback anchor only for unresolved memories", () => {
    const memories = [
      makeMemory("m1", "A lesson", "FACT", 0.9, { nodeRef: "node-abc-123" }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expand();
    const link = screen.getByText("node-abc-123");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "#node-abc-123");
  });

  it("does not render a nodeRef fallback when nodeRef is absent", () => {
    const memories = [makeMemory("m1", "A lesson", "RULE", 0.7)];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expand();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("uses 'success'/'warning'/'muted' badge variants for FACT/RULE/OBSERVATION", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9),
      makeMemory("m2", "L2", "RULE", 0.7),
      makeMemory("m3", "L3", "OBSERVATION", 0.3),
    ];
    const { container } = render(
      <MemoryCard queryId="q1" memories={memories} />,
    );
    expand();
    expect(
      container.querySelector("[data-variant='success']")?.textContent,
    ).toBe("FACT");
    expect(
      container.querySelector("[data-variant='warning']")?.textContent,
    ).toBe("RULE");
    expect(container.querySelector("[data-variant='muted']")?.textContent).toBe(
      "OBSERVATION",
    );
  });

  it("renders the lesson body through TruncatedText, not a raw <p> element", () => {
    const memories = [makeMemory("m1", "A recalled lesson.", "FACT", 0.9)];
    const { container } = render(
      <MemoryCard queryId="q1" memories={memories} />,
    );
    expand();
    // The old plain-text renderer used <p className="whitespace-pre-wrap ...">
    // directly; TruncatedText replaces it with a clamped <span> preview.
    expect(container.querySelector("p.whitespace-pre-wrap")).toBeNull();
    expect(screen.getByText("A recalled lesson.")).toBeInTheDocument();
  });
});

describe("MemoryCard — grounding-node citations", () => {
  it("cites the grounding node via NodeRef when the memory resolves a graph node", () => {
    const memories = [
      makeMemory("m1", "Usage rolls up to Stripe", "FACT", 0.9, {
        node: withNode,
      }),
    ];
    render(
      <TenantProvider value={TENANT}>
        <MemoryCard queryId="q1" memories={memories} />
      </TenantProvider>,
    );
    expand();
    expect(screen.getByTestId("node-ref")).toHaveTextContent("Metered Billing");
    // The raw-id fallback anchor must NOT render when a node is resolved.
    expect(screen.queryByText("node-42")).not.toBeInTheDocument();
  });

  it("renders a 'View in graph' deep-link to the explorer focused on the node", () => {
    const memories = [
      makeMemory("m1", "Grounded fact", "FACT", 0.9, { node: withNode }),
    ];
    render(
      <TenantProvider value={TENANT}>
        <MemoryCard queryId="q1" memories={memories} />
      </TenantProvider>,
    );
    expand();
    const link = screen.getByRole("link", {
      name: /view metered billing in the knowledge graph/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "/acme/core/knowledge/explore?focus=node-42",
    );
  });

  it("renders one deep-link per unique node, not per memory", () => {
    const memories = [
      makeMemory("m1", "L1", "FACT", 0.9, { node: withNode }),
      makeMemory("m2", "L2", "RULE", 0.8, { node: withNode }),
    ];
    render(
      <TenantProvider value={TENANT}>
        <MemoryCard queryId="q1" memories={memories} />
      </TenantProvider>,
    );
    expand();
    expect(
      screen.getAllByRole("link", {
        name: /view metered billing in the knowledge graph/i,
      }),
    ).toHaveLength(1);
  });

  it("omits the 'View in graph' link when rendered outside a workspace route (no tenant)", () => {
    const memories = [
      makeMemory("m1", "Grounded fact", "FACT", 0.9, { node: withNode }),
    ];
    render(<MemoryCard queryId="q1" memories={memories} />);
    expand();
    // NodeRef still cites the fact, but there is no graph deep-link without slugs.
    expect(screen.getByTestId("node-ref")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("omits the 'View in graph' link when the node is not materialised (id null)", () => {
    const memories = [
      makeMemory("m1", "Pending fact", "OBSERVATION", 0.4, {
        node: { ...withNode, id: null },
      }),
    ];
    render(
      <TenantProvider value={TENANT}>
        <MemoryCard queryId="q1" memories={memories} />
      </TenantProvider>,
    );
    expand();
    expect(screen.getByTestId("node-ref")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
