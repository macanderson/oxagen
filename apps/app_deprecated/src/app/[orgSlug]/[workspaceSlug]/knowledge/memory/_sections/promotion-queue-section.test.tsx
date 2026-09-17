// @vitest-environment jsdom
/**
 * promotion-queue-section.test.tsx — render coverage for the async
 * PromotionQueueSection Server Component.
 *
 * Like the other async RSC data-fetch wrappers in this PR, the section is just
 * an async function returning JSX, so it's awaited directly and the resolved
 * element passed to render(). MemoryPromotionQueue is mocked to a stub (it has
 * its own tests at components/knowledge/memories/memory-promotion-queue.test.tsx)
 * so this file covers only the section's own wiring: the list_memory_promotions
 * call shape (capped limit) and the fail-open loadError path.
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
vi.mock("../actions", () => ({
  promoteMemoryAction: vi.fn(),
  dismissPromotionAction: vi.fn(),
  suggestRationalesAction: vi.fn(),
}));

vi.mock("@/components/knowledge/memories/memory-promotion-queue", () => ({
  MemoryPromotionQueue: ({
    initialCandidates,
    loadError,
  }: {
    initialCandidates: unknown[];
    loadError: string | null;
  }) => (
    <div
      data-testid="promotion-queue"
      data-count={initialCandidates.length}
      data-error={loadError ?? ""}
    />
  ),
}));

import { PromotionQueueSection } from "./promotion-queue-section";

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

describe("PromotionQueueSection", () => {
  it("invokes list_memory_promotions with the capped limit and passes candidates down", async () => {
    mockInvoke.mockResolvedValue({
      candidates: [{ id: "mem-1" }, { id: "mem-2" }],
    });
    const element = await PromotionQueueSection(BASE);
    render(element);

    expect(mockInvoke).toHaveBeenCalledWith(
      "list_memory_promotions",
      { limit: 25 },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    const el = screen.getByTestId("promotion-queue");
    expect(el).toHaveAttribute("data-count", "2");
    expect(el).toHaveAttribute("data-error", "");
  });

  it("fails open: an invoke error becomes loadError instead of throwing", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j down"));
    const element = await PromotionQueueSection(BASE);
    render(element);

    const el = screen.getByTestId("promotion-queue");
    expect(el).toHaveAttribute("data-count", "0");
    expect(el).toHaveAttribute("data-error", "neo4j down");
  });
});
