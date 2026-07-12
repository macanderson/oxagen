// @vitest-environment jsdom
/**
 * fleet-list-client.test.tsx — render tests for FleetListClient.
 *
 * Renders the real @/components/ui/* primitives in jsdom (same convention as
 * mcp-server-list.test.tsx / conversation-list.test.tsx). Mocks the
 * cancelFanoutAction server action and next/navigation.
 *
 * Covers:
 *   - empty state when there are no fan-outs
 *   - one row per fan-out, with status badge + child counts
 *   - a "Cancel" button only for cancellable (pending/running) fan-outs, and
 *     only when canManage is true
 *   - clicking Cancel opens the confirm dialog; confirming calls
 *     cancelFanoutAction and shows a success toast
 *   - a failed cancel shows an error toast without navigating away
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentSubagentFanoutListOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.list";
import { FleetListClient } from "./fleet-list-client";

afterEach(cleanup);

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));

// next/link → plain anchor so href assertions work in jsdom (mirrors
// activity-list.test.tsx).
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

type Fanout = AgentSubagentFanoutListOutput["fanouts"][number];

function makeFanout(overrides: Partial<Fanout>): Fanout {
  return {
    fanoutId: "fo_abc12345",
    parentMessageId: "msg_xyz98765",
    status: "running",
    totalChildren: 4,
    completedChildren: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:01:00.000Z",
    ...overrides,
  };
}

const PROPS_BASE = { orgSlug: "acme", workspaceSlug: "eng" };

describe("FleetListClient — empty state", () => {
  it("renders the empty state when there are no fan-outs", () => {
    render(<FleetListClient fanouts={[]} canManage {...PROPS_BASE} />);
    expect(screen.getByTestId("fleet-empty-state")).toBeInTheDocument();
    expect(screen.getByText(/no fan-outs yet/i)).toBeInTheDocument();
  });
});

describe("FleetListClient — rows", () => {
  it("renders one row per fan-out with status + child counts", () => {
    const fanouts = [
      makeFanout({
        fanoutId: "fo_running",
        status: "running",
        totalChildren: 3,
        completedChildren: 1,
      }),
      makeFanout({
        fanoutId: "fo_done",
        status: "completed",
        totalChildren: 2,
        completedChildren: 2,
      }),
    ];
    render(<FleetListClient fanouts={fanouts} canManage {...PROPS_BASE} />);
    expect(screen.getByTestId("fleet-row-fo_running")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-row-fo_done")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("fleet-row-fo_running")).getByText("1/3"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("fleet-row-fo_done")).getByText("2/2"),
    ).toBeInTheDocument();
  });

  it("shows a Cancel action only for cancellable (running/pending) fan-outs when canManage", () => {
    const fanouts = [
      makeFanout({ fanoutId: "fo_running", status: "running" }),
      makeFanout({ fanoutId: "fo_done", status: "completed" }),
    ];
    render(<FleetListClient fanouts={fanouts} canManage {...PROPS_BASE} />);
    expect(
      screen.getByTestId("fleet-cancel-btn-fo_running"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("fleet-cancel-btn-fo_done"),
    ).not.toBeInTheDocument();
  });

  it("hides Cancel entirely when canManage is false, even for a running fan-out", () => {
    const fanouts = [makeFanout({ fanoutId: "fo_running", status: "running" })];
    render(
      <FleetListClient fanouts={fanouts} canManage={false} {...PROPS_BASE} />,
    );
    expect(
      screen.queryByTestId("fleet-cancel-btn-fo_running"),
    ).not.toBeInTheDocument();
  });

  it("links each row to the detail view via ?fanout=<id>", () => {
    const fanouts = [makeFanout({ fanoutId: "fo_running" })];
    render(<FleetListClient fanouts={fanouts} canManage {...PROPS_BASE} />);
    const link = screen.getByTestId("fleet-row-link-fo_running");
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("?fanout=fo_running"),
    );
  });
});

describe("FleetListClient — cancel flow", () => {
  it("confirming cancel calls cancelFanoutAction and shows a success toast", async () => {
    const user = userEvent.setup();
    cancelFanoutAction.mockResolvedValue({
      ok: true,
      fanout: {
        fanoutId: "fo_running",
        status: "timed_out",
        cancelledChildren: 2,
      },
    });
    const fanouts = [makeFanout({ fanoutId: "fo_running", status: "running" })];
    render(<FleetListClient fanouts={fanouts} canManage {...PROPS_BASE} />);

    await user.click(screen.getByTestId("fleet-cancel-btn-fo_running"));
    expect(screen.getByTestId("cancel-fanout-dialog")).toBeInTheDocument();

    await user.click(screen.getByTestId("cancel-fanout-confirm"));

    expect(cancelFanoutAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "eng",
      fanoutId: "fo_running",
    });
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fan-out cancelled", type: "success" }),
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("a failed cancel shows an error toast and keeps the row visible", async () => {
    const user = userEvent.setup();
    cancelFanoutAction.mockResolvedValue({ ok: false, error: "boom" });
    const fanouts = [makeFanout({ fanoutId: "fo_running", status: "running" })];
    render(<FleetListClient fanouts={fanouts} canManage {...PROPS_BASE} />);

    await user.click(screen.getByTestId("fleet-cancel-btn-fo_running"));
    await user.click(screen.getByTestId("cancel-fanout-confirm"));

    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Cancel failed",
        description: "boom",
        type: "error",
      }),
    );
    expect(screen.getByTestId("fleet-row-fo_running")).toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("dismissing the dialog does not call cancelFanoutAction", async () => {
    const user = userEvent.setup();
    const fanouts = [makeFanout({ fanoutId: "fo_running", status: "running" })];
    render(<FleetListClient fanouts={fanouts} canManage {...PROPS_BASE} />);

    await user.click(screen.getByTestId("fleet-cancel-btn-fo_running"));
    await user.click(screen.getByTestId("cancel-fanout-dismiss"));

    expect(cancelFanoutAction).not.toHaveBeenCalled();
  });
});
