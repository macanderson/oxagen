// @vitest-environment jsdom
/**
 * memories-section.test.tsx — render coverage for the async MemoriesSection
 * Server Component.
 *
 * Awaited directly (it's an async function returning JSX). MemoriesClient, the
 * shared ErrorState, and the server-action modules are stubbed so this file
 * covers only the section's own failure-vs-empty branching: a fetch failure
 * renders ErrorState (never a bare client masquerading a failure as empty); a
 * successful read — empty or not — renders the client.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { mockInvoke, mockRunInTenantScope } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));

vi.mock("./actions", () => ({
  createMemoryAction: vi.fn(),
  updateMemoryAction: vi.fn(),
  deleteMemoryAction: vi.fn(),
  promoteMemoryAction: vi.fn(),
  dismissPromotionAction: vi.fn(),
  demoteMemoryAction: vi.fn(),
  suggestRationalesAction: vi.fn(),
  promotionCandidatesAction: vi.fn(),
}));
vi.mock("./bulk-import-actions", () => ({
  parseImportAction: vi.fn(),
  commitImportAction: vi.fn(),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/_shared/components", () => ({
  ErrorState: ({ title }: { title?: string }) => (
    <div data-testid="error-state" data-title={title ?? ""} />
  ),
}));

vi.mock("@/components/knowledge/memories/memories-client", () => ({
  MemoriesClient: ({ initialRecords }: { initialRecords: unknown[] }) => (
    <div data-testid="memories-client" data-count={initialRecords.length} />
  ),
}));

import { MemoriesSection } from "./memories-section";

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

describe("MemoriesSection", () => {
  it("renders the client with memories on success", async () => {
    mockInvoke.mockResolvedValue({
      memories: [{ id: "m1" }, { id: "m2" }],
      total: 2,
    });
    render(await MemoriesSection(BASE));
    expect(screen.getByTestId("memories-client")).toHaveAttribute(
      "data-count",
      "2",
    );
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders the empty client — not an error — when there are genuinely no memories", async () => {
    mockInvoke.mockResolvedValue({ memories: [], total: 0 });
    render(await MemoriesSection(BASE));
    expect(screen.getByTestId("memories-client")).toHaveAttribute(
      "data-count",
      "0",
    );
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders ErrorState — not the client — when the fetch fails", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j down"));
    render(await MemoriesSection(BASE));
    expect(screen.getByTestId("error-state")).toHaveAttribute(
      "data-title",
      "Couldn't load memory",
    );
    expect(screen.queryByTestId("memories-client")).toBeNull();
  });
});
