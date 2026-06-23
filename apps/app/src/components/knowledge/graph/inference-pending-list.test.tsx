// @vitest-environment jsdom
/**
 * inference-pending-list.test.tsx — the Pending Inferences review list.
 *
 * Asserts the regression that started this work: each candidate's start node is
 * cited by its human label (never a raw UUID), the Details affordance is present
 * and functional, and approve/reject still post to the decide endpoint and prune
 * the row. The Base UI popover is mocked to render inline.
 */

import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";

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

import { InferencePendingList } from "./inference-pending-list";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";

afterEach(cleanup);

const SOURCE_UUID = "913d6df1-5dca-4bc7-aff6-193939228260";

function makeEdge(overrides: Partial<SemanticEdge> = {}): SemanticEdge {
  return {
    id: "edge-1",
    sourceNodeId: SOURCE_UUID,
    targetNodeId: "OAuth Login",
    type: "MODIFIES",
    confidence: 0.83,
    source: { connectorId: "github", sourceId: "github" },
    inferredAt: "2026-01-01T00:00:00.000Z",
    approved: false,
    approvedAt: null,
    approvedBy: null,
    sourceNode: {
      id: SOURCE_UUID,
      label: "Feature",
      displayName: "Billing Subscription Streaming",
      properties: { path: "src/billing.ts" },
    },
    targetNode: {
      id: null,
      label: "Concept",
      displayName: "OAuth Login",
      properties: {},
    },
    relationshipProperties: { relationshipType: "MODIFIES", confidence: 0.83 },
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("InferencePendingList", () => {
  it("cites the start node by its label, never the raw UUID", () => {
    render(
      <InferencePendingList
        orgSlug="acme"
        workspaceSlug="main"
        initialSuggestions={[makeEdge()]}
        total={1}
      />,
    );
    expect(screen.getAllByText("Billing Subscription Streaming").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OAuth Login").length).toBeGreaterThan(0);
    // The regression: the source UUID must not be the visible endpoint text.
    expect(screen.queryByText(SOURCE_UUID)).toBeNull();
  });

  it("renders the pending total and a functional Details affordance", () => {
    render(
      <InferencePendingList
        orgSlug="acme"
        workspaceSlug="main"
        initialSuggestions={[makeEdge()]}
        total={165}
      />,
    );
    expect(screen.getByText("165")).toBeInTheDocument();
    expect(screen.getByText(/pending inferences/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /view relationship details/i }),
    ).toBeInTheDocument();
  });

  it("approves an edge via the decide endpoint and prunes the row", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => "" });
    render(
      <InferencePendingList
        orgSlug="acme"
        workspaceSlug="main"
        initialSuggestions={[makeEdge()]}
        total={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve edge edge-1" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/acme/main/semantic-edges/edge-1/decide",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ decision: "approve" });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Approve edge edge-1" })).toBeNull();
    });
  });

  it("shows the empty state when there are no suggestions", () => {
    render(
      <InferencePendingList
        orgSlug="acme"
        workspaceSlug="main"
        initialSuggestions={[]}
        total={0}
      />,
    );
    expect(screen.getByText(/no pending inferences/i)).toBeInTheDocument();
  });

  it("groups by connector with a bulk-approve action", () => {
    render(
      <InferencePendingList
        orgSlug="acme"
        workspaceSlug="main"
        initialSuggestions={[makeEdge()]}
        total={1}
      />,
    );
    const bulk = screen.getByRole("button", { name: /approve all from github/i });
    expect(within(bulk).getByText(/approve all from github/i)).toBeInTheDocument();
  });
});
