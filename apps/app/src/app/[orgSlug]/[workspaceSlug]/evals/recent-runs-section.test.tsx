// @vitest-environment jsdom
/**
 * recent-runs-section.test.tsx — render coverage for the async
 * RecentRunsSection Server Component.
 *
 * Awaited directly (it's an async function returning JSX). RecentRunsClient and
 * the shared ErrorState are stubbed so this file covers only the section's own
 * failure-vs-empty branching: a fetch failure renders ErrorState (never a bare
 * client masquerading a failure as empty); a successful read renders the client.
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

vi.mock("./recent-runs-client", () => ({
  RecentRunsClient: ({ runs }: { runs: unknown[] }) => (
    <div data-testid="recent-runs-client" data-count={runs.length} />
  ),
}));

import { RecentRunsSection } from "./recent-runs-section";

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
};

describe("RecentRunsSection", () => {
  it("renders the client with runs on success", async () => {
    mockInvoke.mockResolvedValue({
      runs: [{ runId: "r1" }, { runId: "r2" }],
      allTimeTotal: 2,
    });
    render(await RecentRunsSection(BASE));
    expect(screen.getByTestId("recent-runs-client")).toHaveAttribute(
      "data-count",
      "2",
    );
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders the empty client — not an error — when there are genuinely no runs", async () => {
    mockInvoke.mockResolvedValue({ runs: [], allTimeTotal: 0 });
    render(await RecentRunsSection(BASE));
    expect(screen.getByTestId("recent-runs-client")).toHaveAttribute(
      "data-count",
      "0",
    );
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders ErrorState — not the client — when the fetch fails", async () => {
    mockInvoke.mockRejectedValue(new Error("clickhouse down"));
    render(await RecentRunsSection(BASE));
    expect(screen.getByTestId("error-state")).toHaveAttribute(
      "data-title",
      "Couldn't load recent runs",
    );
    expect(screen.queryByTestId("recent-runs-client")).toBeNull();
  });
});
