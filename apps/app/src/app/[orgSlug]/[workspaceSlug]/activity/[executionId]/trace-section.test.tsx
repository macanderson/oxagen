// @vitest-environment jsdom
/**
 * trace-section.test.tsx — covers the Debug-panel conditional added to
 * TraceSection: a "failed" trace renders <DebugSection> (inside its own
 * Suspense) ABOVE the span tree; any other status renders the span tree only.
 *
 * TraceSection is an async RSC — following the pattern in
 * `_shared/conversation-page.test.tsx`, we await it directly to obtain its
 * element tree, then render that tree in jsdom. DebugSection and SpanTree are
 * stubbed (real DebugSection is itself an async RSC, which the client
 * `render()` in jsdom cannot resolve) so this test isolates TraceSection's
 * own branching logic.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentTraceGetOutput } from "@oxagen/oxagen/contracts/agent.trace.get";

afterEach(cleanup);

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/oxagen", () => ({
  invoke: invokeMock,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/components/activity/span-tree", () => ({
  SpanTree: () => <div data-testid="span-tree-stub" />,
}));

const debugSectionSpy = vi.hoisted(
  () => ({ props: null as Record<string, unknown> | null }),
);
vi.mock("./debug-section", () => ({
  DebugSection: (props: Record<string, unknown>) => {
    debugSectionSpy.props = props;
    return <div data-testid="debug-section-stub" />;
  },
}));

import { TraceSection } from "./trace-section";

function trace(overrides: Partial<AgentTraceGetOutput> = {}): AgentTraceGetOutput {
  return {
    executionId: "aex_root",
    status: "completed",
    originType: "chat",
    originId: "00000000-0000-4000-8000-000000000001",
    agentId: null,
    failureReason: null,
    startedAt: "2026-06-16T00:00:00.000Z",
    completedAt: "2026-06-16T00:00:04.000Z",
    latencyMs: 4000,
    inputTokens: 120,
    outputTokens: 60,
    estimatedCostUsd: "0.012000",
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:04.000Z",
    steps: [],
    children: [],
    ...overrides,
  };
}

async function renderSection(status: AgentTraceGetOutput["status"]) {
  invokeMock.mockResolvedValueOnce(trace({ status }));
  const element = await TraceSection({
    orgId: "org-1",
    workspaceId: "ws-1",
    userId: "user-1",
    executionId: "aex_root",
  });
  return render(element);
}

describe("TraceSection — Debug panel conditional", () => {
  afterEach(() => {
    debugSectionSpy.props = null;
  });

  it("renders DebugSection above the span tree when the trace status is failed", async () => {
    await renderSection("failed");
    expect(screen.getByTestId("debug-section-stub")).toBeInTheDocument();
    expect(screen.getByTestId("span-tree-stub")).toBeInTheDocument();
    // DebugSection got the resolved trace's executionId + tenant scope.
    expect(debugSectionSpy.props).toEqual({
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      executionId: "aex_root",
    });
  });

  it("does not render DebugSection when the trace status is completed", async () => {
    await renderSection("completed");
    expect(screen.queryByTestId("debug-section-stub")).not.toBeInTheDocument();
    expect(screen.getByTestId("span-tree-stub")).toBeInTheDocument();
  });

  it("does not render DebugSection when the trace status is running", async () => {
    await renderSection("running");
    expect(screen.queryByTestId("debug-section-stub")).not.toBeInTheDocument();
    expect(screen.getByTestId("span-tree-stub")).toBeInTheDocument();
  });
});
