// @vitest-environment jsdom
/**
 * inference-details-popover.test.tsx — the Details affordance for a pending
 * inferred edge. Asserts the popover surfaces the relationship + BOTH endpoints
 * by their human labels and full properties. The Base UI popover is mocked to
 * render inline so the popup is assertable in jsdom.
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

import { InferenceDetailsPopover } from "./inference-details-popover";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";

afterEach(cleanup);

const SOURCE_UUID = "913d6df1-5dca-4bc7-aff6-193939228260";

function makeEdge(overrides: Partial<SemanticEdge> = {}): SemanticEdge {
  return {
    id: "edge-1",
    sourceNodeId: SOURCE_UUID,
    targetNodeId: "Billing Subscription Streaming",
    type: "MODIFIES",
    confidence: 0.83,
    source: { connectorId: "github", sourceId: "github" },
    inferredAt: "2026-01-01T00:00:00.000Z",
    sourceNode: {
      id: SOURCE_UUID,
      label: "Commit",
      displayName: "fix billing meter rounding",
      properties: { sha: "abc123", path: "src/billing.ts" },
    },
    targetNode: {
      id: null,
      label: "Feature",
      displayName: "Billing Subscription Streaming",
      properties: {},
    },
    relationshipProperties: {
      relationshipType: "MODIFIES",
      confidence: 0.83,
      model: "ingestion-semantic-edge-infer",
      connector: "github",
      approvalStatus: "pending",
    },
    ...overrides,
  };
}

describe("InferenceDetailsPopover", () => {
  it("renders a Details trigger", () => {
    render(<InferenceDetailsPopover edge={makeEdge()} />);
    expect(screen.getByRole("button", { name: /view relationship details/i })).toBeInTheDocument();
  });

  it("shows the relationship type and confidence", () => {
    render(<InferenceDetailsPopover edge={makeEdge()} />);
    expect(screen.getAllByText("MODIFIES").length).toBeGreaterThan(0);
    // ConfidenceMeter renders the percentage.
    expect(screen.getByText("83%")).toBeInTheDocument();
  });

  it("cites both endpoints by their human label, never a UUID", () => {
    render(<InferenceDetailsPopover edge={makeEdge()} />);
    expect(screen.getByText("Start node")).toBeInTheDocument();
    expect(screen.getByText("End node")).toBeInTheDocument();
    expect(screen.getAllByText("fix billing meter rounding").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Billing Subscription Streaming").length).toBeGreaterThan(0);
    // The source UUID never appears as visible primary text.
    expect(screen.queryByText(SOURCE_UUID)).toBeNull();
  });

  it("shows the source node's full properties", () => {
    render(<InferenceDetailsPopover edge={makeEdge()} />);
    expect(screen.getByText("Sha")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
  });

  it("surfaces the relationship's own properties (model, connector)", () => {
    render(<InferenceDetailsPopover edge={makeEdge()} />);
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("ingestion-semantic-edge-infer")).toBeInTheDocument();
  });

  it("notes when the target is a not-yet-materialised candidate", () => {
    render(<InferenceDetailsPopover edge={makeEdge()} />);
    expect(screen.getByText(/materialises in the graph when the edge is approved/i)).toBeInTheDocument();
  });

  it("falls back gracefully when endpoints are not resolved", () => {
    const bare = makeEdge({ sourceNode: undefined, targetNode: undefined, relationshipProperties: undefined });
    render(<InferenceDetailsPopover edge={bare} />);
    // Target derives from the edge's targetNodeId (a friendly name, not a UUID).
    expect(screen.getAllByText("Billing Subscription Streaming").length).toBeGreaterThan(0);
  });
});
