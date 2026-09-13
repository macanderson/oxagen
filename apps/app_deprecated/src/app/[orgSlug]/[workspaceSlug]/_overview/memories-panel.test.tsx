// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { AgentMemoryRecord } from "@oxagen/oxagen/contracts/agent.memory.list";

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
vi.mock("@oxagen/agent/register", () => ({}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}));

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));

import { MemoriesPanel } from "./memories-panel";

const PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

function memory(overrides: Partial<AgentMemoryRecord> = {}): AgentMemoryRecord {
  return {
    id: "mem_1",
    publicId: "amem_1",
    nodeRef: "node:1",
    memoryClass: "OBSERVATION",
    memoryKind: "PERFORMANCE",
    lesson: "The daily digest automation reliably completes under 2 minutes.",
    source: "agent",
    confidenceScore: 80,
    enforcementScore: null,
    status: "ACTIVE",
    subjectHint: "automation",
    halfLifeDays: 30,
    decayFloor: 10,
    lastEvidenceAt: null,
    citationCount: 0,
    influenceCount: 0,
    violationCount: 0,
    createdByKind: "AGENT",
    createdById: null,
    confirmedByKind: null,
    confirmedById: null,
    createdAt: new Date().toISOString(),
    lastReinforcedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemoriesPanel", () => {
  it("renders the last-7-days headline, delta chip, and recent memory rows", async () => {
    const now = Date.now();
    const memories = [
      memory({
        id: "mem_1",
        lesson: "Recent memory one",
        createdAt: new Date(now - 1000).toISOString(),
      }),
      memory({
        id: "mem_2",
        lesson: "Recent memory two",
        createdAt: new Date(now - 2 * 86_400_000).toISOString(),
        citationCount: 3,
      }),
      memory({
        id: "mem_3",
        lesson: "Older memory",
        createdAt: new Date(now - 10 * 86_400_000).toISOString(),
      }),
    ];
    mockInvoke.mockResolvedValue({ memories, total: memories.length });

    const element = await MemoriesPanel(PROPS);
    render(element);

    expect(screen.getByTestId("overview-memories-panel")).toBeInTheDocument();
    expect(screen.getByText("Recent memory one")).toBeInTheDocument();
    expect(screen.getByText("Recent memory two")).toBeInTheDocument();
    expect(screen.getByText(/3 citations/i)).toBeInTheDocument();
    expect(screen.getByTestId("delta-chip")).toBeInTheDocument();
    // No raw UUID/publicId rendered anywhere in the panel.
    expect(screen.queryByText("mem_1")).not.toBeInTheDocument();
    expect(screen.queryByText("amem_1")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /review memory/i }),
    ).toHaveAttribute("href", "/acme/prod/knowledge/memory");
  });

  it("renders a zero-state when no memories have been captured", async () => {
    mockInvoke.mockResolvedValue({ memories: [], total: 0 });

    const element = await MemoriesPanel(PROPS);
    render(element);

    expect(screen.getByText(/no memories captured yet/i)).toBeInTheDocument();
  });

  it("renders a degraded error state when list_memories fails", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j unavailable"));

    const element = await MemoriesPanel(PROPS);
    render(element);

    expect(screen.getByText(/memory unavailable/i)).toBeInTheDocument();
  });
});
