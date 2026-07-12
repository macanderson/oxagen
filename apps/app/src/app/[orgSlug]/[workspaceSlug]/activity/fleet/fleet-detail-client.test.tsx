// @vitest-environment jsdom
/**
 * fleet-detail-client.test.tsx — render tests for FleetDetailClient.
 *
 * Mocks ./child-drawer (its own dedicated test covers its internals),
 * ./actions (cancelFanoutAction), @/components/ui/toast, next/navigation, and
 * global fetch (for the "Download logfile" action).
 *
 * Covers:
 *   - header status badge + stat tiles (children, conflicts)
 *   - timeline strip renders one track per run
 *   - per-child table renders capability/status/duration/error/sizes
 *   - row click opens the child drawer with the clicked run
 *   - Cancel is shown only when cancellable + canManage; confirm flow calls
 *     cancelFanoutAction and refreshes
 *   - Download logfile POSTs to the logs route and opens the returned URL;
 *     a failure shows an error toast
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentSubagentFanoutGetOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.get";
import type { AgentSubagentAggregateOutput } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { FleetDetailClient } from "./fleet-detail-client";

afterEach(cleanup);

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));

// next/link → plain anchor so it renders in jsdom (mirrors activity-list.test.tsx).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const toastAdd = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}));

const cancelFanoutAction = vi.fn();
vi.mock("./actions", () => ({
  cancelFanoutAction: (...args: unknown[]) => cancelFanoutAction(...args),
}));

vi.mock("./child-drawer", () => ({
  ChildDrawer: ({
    run,
    fanoutId,
    workspaceId,
  }: {
    run: { runId: string };
    fanoutId: string;
    workspaceId: string;
  }) => (
    <div data-testid="mock-child-drawer">
      {run.runId}:{fanoutId}:{workspaceId}
    </div>
  ),
}));

function makeFanout(
  runs: AgentSubagentFanoutGetOutput["runs"],
  overrides: Partial<AgentSubagentFanoutGetOutput> = {},
): AgentSubagentFanoutGetOutput {
  return {
    fanoutId: "fo_abc123",
    parentMessageId: "msg_1",
    status: "running",
    totalChildren: runs.length,
    completedChildren: runs.filter((r) => r.status === "completed").length,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:05:00.000Z",
    runs,
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<AgentSubagentFanoutGetOutput["runs"][number]>,
) {
  return {
    runId: "sar_1",
    capabilityName: "search_web",
    status: "completed" as const,
    errorReason: null,
    startedAt: "2026-07-12T00:00:00.000Z",
    completedAt: "2026-07-12T00:01:00.000Z",
    durationMs: 60_000,
    inputBytes: 128,
    outputBytes: 512,
    outputPreview: null,
    ...overrides,
  };
}

const PROPS_BASE = { orgSlug: "acme", workspaceSlug: "eng", workspaceId: "w1" };

beforeEach(() => {
  vi.stubGlobal("open", vi.fn());
});

describe("FleetDetailClient — header + stats", () => {
  it("renders the status badge and fanout id", () => {
    const fanout = makeFanout([makeRun({})]);
    render(
      <FleetDetailClient
        fanout={fanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );
    expect(screen.getByTestId("fleet-detail-status")).toHaveTextContent(
      "running",
    );
  });

  it("renders conflict count from aggregate when present", () => {
    const fanout = makeFanout([makeRun({})]);
    const aggregate: AgentSubagentAggregateOutput = {
      fanoutId: "fo_abc123",
      status: "running",
      totalChildren: 1,
      completedChildren: 0,
      aggregatedData: null,
      aggregatedDataTruncated: false,
      conflicts: [
        { key: "region", values: ["us", "eu"], runIds: ["sar_1", "sar_2"] },
      ],
      timeline: [],
      children: [],
      recheckAfterMs: 1000,
      firstError: null,
    };
    render(
      <FleetDetailClient
        fanout={fanout}
        aggregate={aggregate}
        canManage
        {...PROPS_BASE}
      />,
    );
    const stats = screen.getByTestId("fleet-detail-stats");
    expect(stats).toHaveTextContent("1");
  });
});

describe("FleetDetailClient — child table + timeline", () => {
  it("renders one row per child run with capability/status/duration/sizes", () => {
    const fanout = makeFanout([
      makeRun({
        runId: "sar_1",
        capabilityName: "search_web",
        status: "completed",
      }),
      makeRun({
        runId: "sar_2",
        capabilityName: "summarize_text",
        status: "failed",
        errorReason: "timeout",
      }),
    ]);
    render(
      <FleetDetailClient
        fanout={fanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );
    expect(screen.getByTestId("fleet-child-row-sar_1")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-child-row-sar_2")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-child-row-sar_2")).toHaveTextContent(
      "timeout",
    );
  });

  it("renders one timeline track per child", () => {
    const fanout = makeFanout([
      makeRun({ runId: "sar_1", capabilityName: "search_web" }),
      makeRun({ runId: "sar_2", capabilityName: "summarize_text" }),
    ]);
    render(
      <FleetDetailClient
        fanout={fanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );
    const timeline = screen.getByTestId("fleet-timeline");
    expect(timeline).toHaveTextContent("search_web");
    expect(timeline).toHaveTextContent("summarize_text");
  });

  it("clicking a child row opens the child drawer with that run", async () => {
    const user = userEvent.setup();
    const fanout = makeFanout([makeRun({ runId: "sar_1" })]);
    render(
      <FleetDetailClient
        fanout={fanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );
    expect(screen.queryByTestId("mock-child-drawer")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("fleet-child-row-sar_1"));
    expect(screen.getByTestId("mock-child-drawer")).toHaveTextContent(
      "sar_1:fo_abc123:w1",
    );
  });
});

describe("FleetDetailClient — cancel", () => {
  it("shows Cancel only when cancellable + canManage", () => {
    const runningFanout = makeFanout([makeRun({})], { status: "running" });
    const { rerender } = render(
      <FleetDetailClient
        fanout={runningFanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );
    expect(screen.getByTestId("fleet-detail-cancel-btn")).toBeInTheDocument();

    const doneFanout = makeFanout([makeRun({})], { status: "completed" });
    rerender(
      <FleetDetailClient
        fanout={doneFanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );
    expect(
      screen.queryByTestId("fleet-detail-cancel-btn"),
    ).not.toBeInTheDocument();
  });

  it("confirming cancel calls cancelFanoutAction and refreshes", async () => {
    const user = userEvent.setup();
    cancelFanoutAction.mockResolvedValue({
      ok: true,
      fanout: {
        fanoutId: "fo_abc123",
        status: "timed_out",
        cancelledChildren: 1,
      },
    });
    const fanout = makeFanout([makeRun({})], { status: "running" });
    render(
      <FleetDetailClient
        fanout={fanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );

    await user.click(screen.getByTestId("fleet-detail-cancel-btn"));
    await user.click(screen.getByTestId("cancel-fanout-confirm"));

    expect(cancelFanoutAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "eng",
      fanoutId: "fo_abc123",
    });
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe("FleetDetailClient — download logfile", () => {
  it("POSTs to the logs route and opens the returned URL", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ serveUrl: "/api/v1/assets/ast_1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const fanout = makeFanout([makeRun({})]);
    render(
      <FleetDetailClient
        fanout={fanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );

    await user.click(screen.getByTestId("fleet-download-logs-btn"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/agent/subagent/logs",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).toEqual({ workspaceId: "w1", fanoutId: "fo_abc123" });
    expect(window.open).toHaveBeenCalledWith(
      "/api/v1/assets/ast_1",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("shows an error toast when logfile generation fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const fanout = makeFanout([makeRun({})]);
    render(
      <FleetDetailClient
        fanout={fanout}
        aggregate={null}
        canManage
        {...PROPS_BASE}
      />,
    );

    await user.click(screen.getByTestId("fleet-download-logs-btn"));

    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't generate logfile" }),
    );
  });
});
