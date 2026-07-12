// @vitest-environment jsdom
/**
 * query-console.test.tsx
 *
 * Covers both console surfaces:
 *   - CypherConsole: run in Cypher mode (nlQuery=false) and NL mode
 *     (nlQuery=true), result table rendering (scalars, node cells with an
 *     Open link, "no rows" message), and the inline error state.
 *   - TraversalConsole: run_ontology query with edgeTypes parsed from a
 *     comma-separated input, "start node not found" handling, and the
 *     rendered node/edge subgraph.
 *
 * `@/components/ui/select` and `@/components/ui/segmented-control` are
 * mocked to plain clickable stand-ins — the established pattern in this repo
 * (see list-toolbar.test.tsx / preferences-form.test.tsx) since the real Base
 * UI primitives render through portals/pointer-capture jsdom doesn't support.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { mockRunCypher, mockOntologyQuery } = vi.hoisted(() => ({
  mockRunCypher: vi.fn(),
  mockOntologyQuery: vi.fn(),
}));

vi.mock("../actions", () => ({
  runCypherAction: mockRunCypher,
  ontologyQueryAction: mockOntologyQuery,
}));

vi.mock("@/components/knowledge/graph/node-ref", () => ({
  NodeRef: ({ node }: { node: { displayName: string } }) => (
    <span data-testid="node-ref">{node.displayName}</span>
  ),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <div role="group">
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        const { value: itemValue, children: itemChildren } = child.props as {
          value: string;
          children: React.ReactNode;
        };
        return (
          <button
            type="button"
            role="radio"
            aria-checked={value === itemValue}
            onClick={() => onValueChange(itemValue)}
          >
            {itemChildren}
          </button>
        );
      })}
    </div>
  ),
  SegmentedControlItem: ({ children }: { children: React.ReactNode; value: string }) => <>{children}</>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange?: (v: string) => void;
  }) => (
    <div>
      {children}
      <button type="button" aria-label="Direction: Incoming" onClick={() => onValueChange?.("in")} />
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}));

import { QueryConsole } from "./query-console";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("QueryConsole — Cypher/NL console", () => {
  it("runs in Cypher mode by default (nlQuery: false)", async () => {
    mockRunCypher.mockResolvedValue({
      ok: true,
      columns: ["name"],
      rows: [{ name: "Billing" }],
      rowCount: 1,
    });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);

    fireEvent.change(screen.getByLabelText("Cypher query"), {
      target: { value: "MATCH (n) RETURN n.displayName AS name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByText("Billing")).toBeInTheDocument());
    expect(mockRunCypher).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "core",
        query: "MATCH (n) RETURN n.displayName AS name",
        nlQuery: false,
      }),
    );
  });

  it("switches to natural-language mode (nlQuery: true)", async () => {
    mockRunCypher.mockResolvedValue({ ok: true, columns: [], rows: [], rowCount: 0 });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);

    fireEvent.click(screen.getByRole("radio", { name: "Natural language" }));
    fireEvent.change(screen.getByLabelText("Natural-language query"), {
      target: { value: "Show me recent features" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(mockRunCypher).toHaveBeenCalled());
    expect(mockRunCypher).toHaveBeenCalledWith(expect.objectContaining({ nlQuery: true }));
  });

  it("renders a node cell with an Open link when a row contains a node-shaped value", async () => {
    mockRunCypher.mockResolvedValue({
      ok: true,
      columns: ["n"],
      rows: [{ n: { id: "pub-1", label: "Feature", displayName: "Streaming", properties: {} } }],
      rowCount: 1,
    });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "MATCH (n) RETURN n" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByText("Streaming")).toBeInTheDocument());
    const openLink = screen.getByRole("link", { name: "Open" });
    expect(openLink).toHaveAttribute("href", "/acme/core/knowledge/graph/pub-1");
  });

  it("shows a 'no rows' message for an empty result", async () => {
    mockRunCypher.mockResolvedValue({ ok: true, columns: [], rows: [], rowCount: 0 });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "MATCH (n) WHERE false RETURN n" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(screen.getByText("Query ran successfully — no rows returned.")).toBeInTheDocument(),
    );
  });

  it("shows an inline error on failure", async () => {
    mockRunCypher.mockResolvedValue({ ok: false, error: "Syntax error at line 1" });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "GARBAGE" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("Syntax error at line 1")).toBeInTheDocument());
  });

  it("disables Run while the query text is empty", () => {
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });
});

describe("QueryConsole — traversal console", () => {
  it("runs a traversal with parsed edge types and the selected direction", async () => {
    mockOntologyQuery.mockResolvedValue({
      ok: true,
      startNode: { nodeId: "pub-1", label: "Feature", displayName: "Streaming", description: null, depth: 0 },
      nodes: [{ nodeId: "pub-1", label: "Feature", displayName: "Streaming", description: null, depth: 0 }],
      edges: [],
      truncated: false,
    });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);

    fireEvent.change(screen.getByLabelText("Start node ID"), { target: { value: " pub-1 " } });
    fireEvent.change(screen.getByLabelText("Relationship types (comma-separated, optional)"), {
      target: { value: "OWNS, DEPENDS_ON" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Direction: Incoming" }));
    fireEvent.click(screen.getByRole("button", { name: "Traverse" }));

    await waitFor(() => expect(mockOntologyQuery).toHaveBeenCalled());
    expect(mockOntologyQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "core",
        startNodeId: "pub-1",
        edgeTypes: ["OWNS", "DEPENDS_ON"],
        direction: "in",
        maxDepth: 2,
      }),
    );
  });

  it("shows 'start node not found' when startNode is null", async () => {
    mockOntologyQuery.mockResolvedValue({ ok: true, startNode: null, nodes: [], edges: [], truncated: false });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Start node ID"), { target: { value: "missing-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Traverse" }));
    await waitFor(() =>
      expect(screen.getByText("Start node not found in this workspace.")).toBeInTheDocument(),
    );
  });

  it("renders the reached nodes and traversed edges", async () => {
    mockOntologyQuery.mockResolvedValue({
      ok: true,
      startNode: { nodeId: "pub-1", label: "Feature", displayName: "Streaming", description: null, depth: 0 },
      nodes: [
        { nodeId: "pub-1", label: "Feature", displayName: "Streaming", description: null, depth: 0 },
        { nodeId: "pub-2", label: "Person", displayName: "Jane", description: null, depth: 1 },
      ],
      edges: [{ fromNodeId: "pub-1", toNodeId: "pub-2", edgeType: "OWNS", validFrom: null, validTo: null, recordedAt: null, invalidatedAt: null }],
      truncated: false,
    });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Start node ID"), { target: { value: "pub-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Traverse" }));

    await waitFor(() => expect(screen.getByText("2 nodes reached")).toBeInTheDocument());
    expect(screen.getByText("1 edge traversed")).toBeInTheDocument();
    expect(screen.getByText(/OWNS/)).toBeInTheDocument();
  });

  it("shows an inline error on traversal failure", async () => {
    mockOntologyQuery.mockResolvedValue({ ok: false, error: "graph timeout" });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Start node ID"), { target: { value: "pub-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Traverse" }));
    await waitFor(() => expect(screen.getByText("graph timeout")).toBeInTheDocument());
  });

  it("disables Traverse while the start-node field is empty", () => {
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    expect(screen.getByRole("button", { name: "Traverse" })).toBeDisabled();
  });
});
