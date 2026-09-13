// @vitest-environment jsdom
/**
 * node-neighbors.test.tsx — render coverage for the async Neighbors section.
 *
 * NodeNeighbors is an async Server Component: it's just an async function
 * returning JSX, so it can be awaited directly and the resolved element
 * passed to @testing-library/react's render() — the same technique used to
 * unit-test async RSC data-fetch wrappers without a full Next runtime.
 *
 * NodeRefLink is mocked to a simple stub (it has its own tests at
 * components/knowledge/graph/node-ref-link.test.tsx) so this file covers only
 * NodeNeighbors' own wiring: empty state (no neighbors / invoke throws), the
 * get_ontology_neighbors call shape, and grouping-by-relationship-type +
 * per-neighbor href wiring.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { mockInvoke, mockRunInTenantScope } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));

vi.mock("@/components/knowledge/graph/node-ref-link", () => ({
  NodeRefLink: ({
    node,
    href,
  }: {
    node: { displayName: string };
    href?: string | null;
  }) => (
    <a href={href ?? undefined} data-testid="neighbor-chip">
      {node.displayName}
    </a>
  ),
}));

import { NodeNeighbors } from "./node-neighbors";

afterEach(cleanup);
beforeEach(() => {
  mockInvoke.mockReset();
  mockRunInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
});

const BASE = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "main",
  nodeId: "kn_1",
};

function neighbor(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "kn_2",
    label: "Repository",
    displayName: "oxagen-platform",
    description: null,
    edgeType: "OWNS",
    direction: "out",
    validFrom: null,
    validTo: null,
    recordedAt: null,
    invalidatedAt: null,
    ...overrides,
  };
}

describe("NodeNeighbors", () => {
  it("shows the empty state when there are no neighbors", async () => {
    mockInvoke.mockResolvedValue({
      nodeId: "kn_1",
      found: true,
      neighbors: [],
      truncated: false,
    });
    const jsx = await NodeNeighbors(BASE);
    render(jsx);
    expect(screen.getByText("No connected nodes.")).toBeInTheDocument();
  });

  it("shows the empty state when invoke throws, instead of crashing the page", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j down"));
    const jsx = await NodeNeighbors(BASE);
    render(jsx);
    expect(screen.getByText("No connected nodes.")).toBeInTheDocument();
  });

  it("calls get_ontology_neighbors scoped to the node with the agent surface override", async () => {
    mockInvoke.mockResolvedValue({
      nodeId: "kn_1",
      found: true,
      neighbors: [],
      truncated: false,
    });
    await NodeNeighbors(BASE);
    expect(mockInvoke.mock.calls[0]?.[0]).toBe("get_ontology_neighbors");
    expect(mockInvoke.mock.calls[0]?.[1]).toMatchObject({
      nodeId: "kn_1",
      direction: "both",
    });
    expect(mockInvoke.mock.calls[0]?.[3]).toEqual({ surface: "agent" });
  });

  it("groups neighbors by relationship type + direction and links to each node detail", async () => {
    mockInvoke.mockResolvedValue({
      nodeId: "kn_1",
      found: true,
      truncated: false,
      neighbors: [
        neighbor({
          nodeId: "kn_2",
          displayName: "oxagen-platform",
          edgeType: "OWNS",
          direction: "out",
        }),
        neighbor({
          nodeId: "kn_3",
          label: "Person",
          displayName: "Ada Lovelace",
          edgeType: "AUTHORED",
          direction: "in",
        }),
      ],
    });

    const jsx = await NodeNeighbors(BASE);
    render(jsx);

    const chips = screen.getAllByTestId("neighbor-chip");
    expect(chips).toHaveLength(2);

    const repoChip = screen.getByText("oxagen-platform");
    expect(repoChip).toHaveAttribute("href", "/acme/main/knowledge/graph/kn_2");

    const personChip = screen.getByText("Ada Lovelace");
    expect(personChip).toHaveAttribute(
      "href",
      "/acme/main/knowledge/graph/kn_3",
    );

    // Two distinct relationship-type groups render their own heading (mixed
    // text + icon content, so assert on the headings' combined text rather
    // than a leaf-text match).
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent ?? "");
    expect(headings.some((t) => t.includes("OWNS"))).toBe(true);
    expect(headings.some((t) => t.includes("AUTHORED"))).toBe(true);
  });
});
