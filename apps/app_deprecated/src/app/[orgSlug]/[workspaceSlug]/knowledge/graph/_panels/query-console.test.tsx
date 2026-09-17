// @vitest-environment jsdom
/**
 * query-console.test.tsx
 *
 * Covers the typed traversal console: query_ontology with edgeTypes parsed from a
 *     comma-separated input, "start node not found" handling, and the
 *     rendered node/edge subgraph.
 *
 * `@/components/ui/select` is mocked to a plain clickable stand-in — the established pattern in this repo
 * (see list-toolbar.test.tsx / preferences-form.test.tsx) since the real Base
 * UI primitives render through portals/pointer-capture jsdom doesn't support.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const { mockOntologyQuery } = vi.hoisted(() => ({
  mockOntologyQuery: vi.fn(),
}));

vi.mock("../actions", () => ({
  ontologyQueryAction: mockOntologyQuery,
}));

vi.mock("@/components/knowledge/graph/node-ref", () => ({
  NodeRef: ({ node }: { node: { displayName: string } }) => (
    <span data-testid="node-ref">{node.displayName}</span>
  ),
}));

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
      <button
        type="button"
        aria-label="Direction: Incoming"
        onClick={() => onValueChange?.("in")}
      />
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <div data-value={value}>{children}</div>,
}));

import { QueryConsole } from "./query-console";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("QueryConsole — traversal console", () => {
  it("runs a traversal with parsed edge types and the selected direction", async () => {
    mockOntologyQuery.mockResolvedValue({
      ok: true,
      startNode: {
        nodeId: "pub-1",
        label: "Feature",
        displayName: "Streaming",
        description: null,
        depth: 0,
      },
      nodes: [
        {
          nodeId: "pub-1",
          label: "Feature",
          displayName: "Streaming",
          description: null,
          depth: 0,
        },
      ],
      edges: [],
      truncated: false,
    });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);

    fireEvent.change(screen.getByLabelText("Start node ID"), {
      target: { value: " pub-1 " },
    });
    fireEvent.change(
      screen.getByLabelText("Relationship types (comma-separated, optional)"),
      {
        target: { value: "OWNS, DEPENDS_ON" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Direction: Incoming" }),
    );
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
    mockOntologyQuery.mockResolvedValue({
      ok: true,
      startNode: null,
      nodes: [],
      edges: [],
      truncated: false,
    });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Start node ID"), {
      target: { value: "missing-id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Traverse" }));
    await waitFor(() =>
      expect(
        screen.getByText("Start node not found in this workspace."),
      ).toBeInTheDocument(),
    );
  });

  it("renders the reached nodes and traversed edges", async () => {
    mockOntologyQuery.mockResolvedValue({
      ok: true,
      startNode: {
        nodeId: "pub-1",
        label: "Feature",
        displayName: "Streaming",
        description: null,
        depth: 0,
      },
      nodes: [
        {
          nodeId: "pub-1",
          label: "Feature",
          displayName: "Streaming",
          description: null,
          depth: 0,
        },
        {
          nodeId: "pub-2",
          label: "Person",
          displayName: "Jane",
          description: null,
          depth: 1,
        },
      ],
      edges: [
        {
          fromNodeId: "pub-1",
          toNodeId: "pub-2",
          edgeType: "OWNS",
          validFrom: null,
          validTo: null,
          recordedAt: null,
          invalidatedAt: null,
        },
      ],
      truncated: false,
    });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Start node ID"), {
      target: { value: "pub-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Traverse" }));

    await waitFor(() =>
      expect(screen.getByText("2 nodes reached")).toBeInTheDocument(),
    );
    expect(screen.getByText("1 edge traversed")).toBeInTheDocument();
    expect(screen.getByText(/OWNS/)).toBeInTheDocument();
  });

  it("shows an inline error on traversal failure", async () => {
    mockOntologyQuery.mockResolvedValue({ ok: false, error: "graph timeout" });
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Start node ID"), {
      target: { value: "pub-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Traverse" }));
    await waitFor(() =>
      expect(screen.getByText("graph timeout")).toBeInTheDocument(),
    );
  });

  it("disables Traverse while the start-node field is empty", () => {
    render(<QueryConsole orgSlug="acme" workspaceSlug="core" />);
    expect(screen.getByRole("button", { name: "Traverse" })).toBeDisabled();
  });
});
