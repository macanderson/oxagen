// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { GraphStatsOutput } from "@oxagen/oxagen/contracts/graph.stats";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
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

import { GraphHero } from "./graph-hero";

const PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

function graphStats(
  overrides: Partial<GraphStatsOutput> = {},
): GraphStatsOutput {
  return {
    nodeCount: 0,
    edgeCount: 0,
    inferredEdgeCount: 0,
    sourceCount: 0,
    lastModifiedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function connections(
  overrides: Partial<ConnectionListOutput["connections"][number]>[] = [],
): ConnectionListOutput {
  return {
    connections: overrides.map((o, i) => ({
      id: `conn_${i}`,
      publicId: `conn_${i}`,
      connectorId: "generic",
      displayName: `Connection ${i}`,
      authScheme: "oauth",
      deliveryMethod: "webhook",
      status: "connected",
      entityCount: 0,
      lastSyncAt: null,
      healthStatus: "healthy",
      lastPollAt: null,
      nextPollAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      ...o,
    })),
  };
}

/** Route the shared mockInvoke by capability name, mirroring the hero's Promise.allSettled call. */
function invokeByCapability(handlers: Record<string, () => Promise<unknown>>) {
  mockInvoke.mockImplementation((name: string) => {
    const handler = handlers[name];
    if (!handler)
      return Promise.reject(new Error(`unexpected capability: ${name}`));
    return handler();
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GraphHero", () => {
  it("renders graph, repo, and source counts on the populated path", async () => {
    invokeByCapability({
      get_graph_stats: () =>
        Promise.resolve(
          graphStats({
            nodeCount: 120,
            edgeCount: 340,
            inferredEdgeCount: 12,
            sourceCount: 2,
            growth: {
              nodesToday: 5,
              nodesYesterday: 3,
              nodesThisWeek: 20,
              nodesLastWeek: 15,
              daily: Array.from({ length: 14 }, (_, i) => ({
                day: `2026-06-${(i + 1).toString().padStart(2, "0")}`,
                count: i,
              })),
            },
          }),
        ),
      list_connections: () =>
        Promise.resolve(
          connections([{ connectorId: "github" }, { connectorId: "notion" }]),
        ),
    });

    const element = await GraphHero(PROPS);
    render(element);

    expect(screen.getByTestId("overview-graph-hero")).toBeInTheDocument();

    expect(screen.getByTestId("overview-graph-stat-nodes")).toHaveTextContent(
      "120",
    );
    expect(screen.getByTestId("overview-graph-stat-edges")).toHaveTextContent(
      "340",
    );
    expect(screen.getByTestId("overview-graph-stat-repos")).toHaveTextContent(
      "1",
    );
    expect(screen.getByTestId("overview-graph-stat-sources")).toHaveTextContent(
      "2",
    );
  });

  it("renders the growth block with two DeltaChips and a MiniBars trend", async () => {
    invokeByCapability({
      get_graph_stats: () =>
        Promise.resolve(
          graphStats({
            nodeCount: 10,
            growth: {
              nodesToday: 5,
              nodesYesterday: 3,
              nodesThisWeek: 20,
              nodesLastWeek: 15,
              daily: Array.from({ length: 14 }, (_, i) => ({
                day: `2026-06-${(i + 1).toString().padStart(2, "0")}`,
                count: i,
              })),
            },
          }),
        ),
      list_connections: () => Promise.resolve(connections([])),
    });

    const element = await GraphHero(PROPS);
    render(element);

    const deltaChips = screen.getAllByTestId("delta-chip");
    expect(deltaChips).toHaveLength(2);
    expect(screen.getByText(/vs yesterday/i)).toBeInTheDocument();
    expect(screen.getByText(/this wk vs last/i)).toBeInTheDocument();
    expect(screen.getByTestId("overview-mini-bars")).toBeInTheDocument();
  });

  it("renders the empty state when there are no nodes at all", async () => {
    invokeByCapability({
      get_graph_stats: () => Promise.resolve(graphStats({ nodeCount: 0 })),
      list_connections: () => Promise.resolve(connections([])),
    });

    const element = await GraphHero(PROPS);
    render(element);

    expect(screen.getByText(/no graph data yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /connect a source/i }),
    ).toHaveAttribute("href", "/acme/prod/knowledge/sources");
  });
});
