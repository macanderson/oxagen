// @vitest-environment jsdom
/**
 * connections-section.test.tsx — render coverage for the async
 * ConnectionsSection Server Component.
 *
 * The section is an async function returning JSX, so it's awaited directly and
 * the resolved element passed to render(). KnowledgeConnectionsClient and the
 * shared ErrorState are stubbed so this file covers only the section's own
 * failure-vs-empty branching: a fetch failure renders ErrorState (never a bare
 * client masquerading a failure as an empty state); a successful read — empty
 * or not — renders the client.
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

vi.mock("@/app/[orgSlug]/[workspaceSlug]/_shared/components", () => ({
  ErrorState: ({ title }: { title?: string }) => (
    <div data-testid="error-state" data-title={title ?? ""} />
  ),
}));

vi.mock("@/components/knowledge/connections/knowledge-connections-client", () => ({
  KnowledgeConnectionsClient: ({ connections }: { connections: unknown[] }) => (
    <div data-testid="connections-client" data-count={connections.length} />
  ),
}));

import { ConnectionsSection } from "./connections-section";

afterEach(cleanup);
beforeEach(() => {
  mockInvoke.mockReset();
  mockRunInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
});

const BASE = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "main",
  setupConnector: undefined,
  setupConnectionId: undefined,
};

describe("ConnectionsSection", () => {
  it("renders the client with connections on success", async () => {
    mockInvoke.mockResolvedValue({
      connections: [{ publicId: "c1" }, { publicId: "c2" }],
    });
    render(await ConnectionsSection(BASE));
    expect(screen.getByTestId("connections-client")).toHaveAttribute("data-count", "2");
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders the empty client — not an error — when there are genuinely no connections", async () => {
    mockInvoke.mockResolvedValue({ connections: [] });
    render(await ConnectionsSection(BASE));
    expect(screen.getByTestId("connections-client")).toHaveAttribute("data-count", "0");
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders ErrorState — not the client — when the fetch fails", async () => {
    mockInvoke.mockRejectedValue(new Error("db down"));
    render(await ConnectionsSection(BASE));
    expect(screen.getByTestId("error-state")).toHaveAttribute(
      "data-title",
      "Couldn't load sources",
    );
    expect(screen.queryByTestId("connections-client")).toBeNull();
  });
});
