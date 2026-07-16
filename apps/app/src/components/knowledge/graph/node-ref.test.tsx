// @vitest-environment jsdom
/**
 * node-ref.test.tsx — the node-citation rule, in tests.
 *
 * A node is cited by its human label (displayName + domain label), never by its
 * raw UUID, and the full property bag is available on inspect. The Base UI
 * popover is mocked to render inline so the popup content is assertable in
 * jsdom (the floating/portal behaviour is Base UI's concern, not ours).
 */

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    children,
    "aria-label": ariaLabel,
    className,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
    className?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} className={className}>
      {children}
    </button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { NodeRef, sourceNodeRef, targetNodeRef } from "./node-ref";
import type { KnowledgeNodeRef, SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";

afterEach(cleanup);

const SOURCE_UUID = "913d6df1-5dca-4bc7-aff6-193939228260";

function makeNode(overrides: Partial<KnowledgeNodeRef> = {}): KnowledgeNodeRef {
  return {
    id: SOURCE_UUID,
    label: "Feature",
    displayName: "Billing Subscription Streaming",
    properties: { path: "src/billing.ts", owner: "platform" },
    ...overrides,
  };
}

function makeEdge(overrides: Partial<SemanticEdge> = {}): SemanticEdge {
  return {
    id: "edge-1",
    sourceNodeId: SOURCE_UUID,
    targetNodeId: "OAuth Login",
    type: "MODIFIES",
    confidence: 0.83,
    source: { connectorId: "github", sourceId: "github" },
    inferredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("NodeRef", () => {
  it("cites the node by its displayName, not its UUID", () => {
    render(<NodeRef node={makeNode()} />);
    // Friendly label is shown (trigger chip + popup header → at least one).
    expect(screen.getAllByText("Billing Subscription Streaming").length).toBeGreaterThan(0);
    // The raw UUID is never the primary on-screen identifier.
    expect(screen.queryByText(SOURCE_UUID)).toBeNull();
  });

  it("shows the domain label and full properties on inspect", () => {
    render(<NodeRef node={makeNode()} />);
    expect(screen.getByText("Feature")).toBeInTheDocument();
    // Humanized property keys + values from the bag.
    expect(screen.getByText("Path")).toBeInTheDocument();
    expect(screen.getByText("src/billing.ts")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("exposes a copyable id in the inspect panel", () => {
    render(<NodeRef node={makeNode()} />);
    // CopyableId renders an accessible copy control carrying the full id.
    expect(
      screen.getByRole("button", { name: `Copy ID ${SOURCE_UUID}` }),
    ).toBeInTheDocument();
  });

  it("marks a not-yet-materialised node (null id) as a candidate", () => {
    render(<NodeRef node={makeNode({ id: null, displayName: "OAuth Login" })} />);
    expect(screen.getByText(/not yet materialised/i)).toBeInTheDocument();
  });

  it("falls back to the label/id when displayName is empty", () => {
    render(<NodeRef node={makeNode({ displayName: "", properties: {} })} />);
    // Label is the best remaining human identifier.
    expect(screen.getAllByText("Feature").length).toBeGreaterThan(0);
  });

  it("cites by the domain label when displayName is only the server's id fallback", () => {
    // The graph.node.list handler coalesces displayName → name → publicId, so an
    // unnamed node arrives with displayName === its own UUID. That is not a human
    // label — the chip must cite by the domain label, never the UUID.
    render(<NodeRef node={makeNode({ displayName: SOURCE_UUID, properties: {} })} />);
    expect(screen.getAllByText("Feature").length).toBeGreaterThan(0);
    expect(screen.queryByText(SOURCE_UUID)).toBeNull();
  });
});

describe("sourceNodeRef / targetNodeRef", () => {
  it("prefers the resolved sourceNode/targetNode from the edge", () => {
    const edge = makeEdge({
      sourceNode: { id: SOURCE_UUID, label: "Feature", displayName: "Billing", properties: { a: 1 } },
      targetNode: { id: null, label: "Concept", displayName: "OAuth Login", properties: {} },
    });
    expect(sourceNodeRef(edge)).toEqual({
      id: SOURCE_UUID,
      label: "Feature",
      displayName: "Billing",
      properties: { a: 1 },
    });
    expect(targetNodeRef(edge).displayName).toBe("OAuth Login");
    expect(targetNodeRef(edge).id).toBeNull();
  });

  it("falls back to the edge ids when no resolved node is present", () => {
    const edge = makeEdge();
    expect(sourceNodeRef(edge)).toEqual({
      id: SOURCE_UUID,
      label: "Node",
      displayName: SOURCE_UUID,
      properties: {},
    });
    expect(targetNodeRef(edge)).toEqual({
      id: null,
      label: "Node",
      displayName: "OAuth Login",
      properties: {},
    });
  });
});
