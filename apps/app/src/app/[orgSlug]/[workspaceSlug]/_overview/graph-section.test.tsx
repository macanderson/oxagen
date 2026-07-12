// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@oxagen/handlers/register", () => ({}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}));

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));

import { GraphTile } from "./graph-section";

const PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GraphTile", () => {
  it("renders graph stat boxes and a link to the graph explorer when nodes exist", async () => {
    mockInvoke.mockResolvedValue({
      nodeCount: 120,
      edgeCount: 340,
      inferredEdgeCount: 12,
      sourceCount: 3,
      lastModifiedAt: "2026-07-12T00:00:00.000Z",
    });

    const element = await GraphTile(PROPS);
    render(element);

    expect(screen.getByTestId("overview-graph-tile")).toBeInTheDocument();
    expect(screen.getByTestId("graph-stats")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /explore graph/i })).toHaveAttribute(
      "href",
      "/acme/prod/knowledge/explore",
    );
  });

  it("renders a zero-state inviting a first connector when the graph is empty", async () => {
    mockInvoke.mockResolvedValue({
      nodeCount: 0,
      edgeCount: 0,
      inferredEdgeCount: 0,
      sourceCount: 0,
      lastModifiedAt: "",
    });

    const element = await GraphTile(PROPS);
    render(element);

    expect(screen.getByText(/no graph data yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect a source/i })).toHaveAttribute(
      "href",
      "/acme/prod/knowledge/repos",
    );
  });

  it("renders a degraded error state when get_graph_stats fails", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j unavailable"));

    const element = await GraphTile(PROPS);
    render(element);

    expect(screen.getByText(/graph stats unavailable/i)).toBeInTheDocument();
  });
});
