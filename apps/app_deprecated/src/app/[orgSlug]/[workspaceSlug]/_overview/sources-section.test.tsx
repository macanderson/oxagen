// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
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

import { SourcesTile } from "./sources-section";

const PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

function connection(
  overrides: Partial<ConnectionListOutput["connections"][number]> = {},
) {
  return {
    id: "conn_1",
    publicId: "cn_1",
    connectorId: "github",
    displayName: "GitHub — acme/repo",
    authScheme: "oauth",
    deliveryMethod: "push",
    status: "connected",
    entityCount: 42,
    lastSyncAt: null,
    healthStatus: "healthy" as const,
    lastPollAt: null,
    nextPollAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SourcesTile", () => {
  it("renders connection names and health status, capped at 6 rows", async () => {
    const connections = Array.from({ length: 8 }, (_, i) =>
      connection({
        id: `conn_${i}`,
        displayName: `Source ${i}`,
        healthStatus: i === 0 ? "degraded" : "healthy",
      }),
    );
    mockInvoke.mockResolvedValue({ connections });

    const element = await SourcesTile(PROPS);
    render(element);

    expect(screen.getByTestId("overview-sources-tile")).toBeInTheDocument();
    expect(screen.getByText("Source 0")).toBeInTheDocument();
    expect(screen.getByText("Source 5")).toBeInTheDocument();
    expect(screen.queryByText("Source 6")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view sources/i })).toHaveAttribute(
      "href",
      "/acme/prod/knowledge/sources",
    );
  });

  it("renders a zero-state inviting the first connector when there are no connections", async () => {
    mockInvoke.mockResolvedValue({ connections: [] });

    const element = await SourcesTile(PROPS);
    render(element);

    expect(screen.getByText(/no sources connected yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /connect a source/i }),
    ).toHaveAttribute("href", "/acme/prod/knowledge/sources");
  });

  it("renders a degraded error state when list_connections fails", async () => {
    mockInvoke.mockRejectedValue(new Error("db unavailable"));

    const element = await SourcesTile(PROPS);
    render(element);

    expect(screen.getByText(/source health unavailable/i)).toBeInTheDocument();
  });
});
