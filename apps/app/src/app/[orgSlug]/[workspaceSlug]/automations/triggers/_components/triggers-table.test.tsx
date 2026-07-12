// @vitest-environment jsdom
/**
 * triggers-table.test.tsx — unit tests for the Triggers board table.
 *
 * The interactive Base UI chrome (Menu popups, Select popups) is mocked to
 * plain clickable elements — same convention as conversation-export-menu.
 * test.tsx and launch-workflow-dialog.test.tsx — so this exercises the real
 * filter/toggle/delete wiring without depending on floating-ui portals in
 * jsdom. The child dialogs (TriggerFormDialog, DeleteTriggerDialog) are
 * stubbed to simple controlled markers — their own logic is covered by
 * trigger-form-dialog.test.tsx; here we only prove the table wires the right
 * row into them and reacts correctly to their callbacks.
 *
 * Covers:
 *   - True empty state (no rows, no failures) renders the empty-state copy.
 *   - All-agents-failed (no rows, failedAgents > 0) renders only the
 *     partial-failure banner, not the empty state or the table.
 *   - Partial failure with some rows renders the banner AND the table.
 *   - canManage=false hides the Actions column entirely.
 *   - Search filters rows by agent name; a no-match state renders inline.
 *   - Enable/Disable calls toggleTriggerAction with the flipped `enabled`
 *     and the row's full binding config, then refreshes.
 *   - Delete confirmation calls deleteTriggerAction with the triggerId, then
 *     refreshes.
 */
import * as React from "react";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkspaceTriggerRow } from "@/lib/automations/triggers";

const { mockRefresh, mockAddToast, mockToggleTriggerAction, mockDeleteTriggerAction } = vi.hoisted(
  () => ({
    mockRefresh: vi.fn(),
    mockAddToast: vi.fn(),
    mockToggleTriggerAction: vi.fn(),
    mockDeleteTriggerAction: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("../actions", () => ({
  toggleTriggerAction: (...args: unknown[]) => mockToggleTriggerAction(...args),
  deleteTriggerAction: (...args: unknown[]) => mockDeleteTriggerAction(...args),
}));

// Menu → items render as plain clickable buttons, popup always "open".
vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement;
  }) => React.cloneElement(render, undefined, children),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div role="menu">{children}</div>,
  MenuItem: ({
    children,
    onClick,
    disabled,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled} data-testid={testId}>
      {children}
    </button>
  ),
}));

// Select → inert display; only default values are exercised (search input
// covers the interesting filter behavior without needing to change type).
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("./trigger-form-dialog", () => ({
  TriggerFormDialog: ({ agentName, triggerId }: { agentName: string; triggerId: string }) => (
    <div data-testid="edit-dialog-stub">
      editing {agentName} / {triggerId}
    </div>
  ),
}));

vi.mock("./delete-trigger-dialog", () => ({
  DeleteTriggerDialog: ({
    open,
    onConfirm,
    agentName,
  }: {
    open: boolean;
    onConfirm: () => Promise<void>;
    agentName: string;
  }) =>
    open ? (
      <div data-testid="delete-dialog-stub">
        <span>deleting {agentName}</span>
        <button type="button" onClick={() => void onConfirm()} data-testid="confirm-delete-stub">
          confirm
        </button>
      </div>
    ) : null,
}));

import { TriggersTable } from "./triggers-table";

function row(overrides: Partial<WorkspaceTriggerRow> = {}): WorkspaceTriggerRow {
  return {
    agentId: "a1",
    agentPublicId: "agt_1",
    agentName: "Agent One",
    triggerId: "atr_1",
    triggerType: "manual",
    bindingSummary: "Manual — run on demand",
    enabled: true,
    schedule: null,
    eventSource: null,
    eventType: null,
    connectionId: null,
    filter: {},
    ...overrides,
  };
}

const BASE_PROPS = {
  orgSlug: "acme",
  workspaceSlug: "main",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockToggleTriggerAction.mockResolvedValue({ ok: true });
  mockDeleteTriggerAction.mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("TriggersTable — empty / failure states", () => {
  it("renders the true empty state when there are no rows and no failures", () => {
    render(<TriggersTable rows={[]} failedAgents={0} canManage={true} {...BASE_PROPS} />);
    expect(screen.getByText("No triggers configured across any agent yet.")).toBeTruthy();
    expect(screen.queryByTestId("triggers-table")).toBeNull();
  });

  it("renders only the partial-failure banner when every agent failed (no rows)", () => {
    render(<TriggersTable rows={[]} failedAgents={2} canManage={true} {...BASE_PROPS} />);
    expect(screen.getByTestId("triggers-partial-failure").textContent).toContain(
      "2 agents failed to load",
    );
    expect(screen.queryByText("No triggers configured across any agent yet.")).toBeNull();
    expect(screen.queryByTestId("triggers-table")).toBeNull();
  });

  it("renders the banner AND the table when some agents succeed and some fail", () => {
    render(
      <TriggersTable rows={[row()]} failedAgents={1} canManage={true} {...BASE_PROPS} />,
    );
    expect(screen.getByTestId("triggers-partial-failure").textContent).toContain(
      "1 agent failed to load",
    );
    expect(screen.getByTestId("triggers-table")).toBeTruthy();
    expect(screen.getByText("Agent One")).toBeTruthy();
  });
});

describe("TriggersTable — permissions and filtering", () => {
  it("hides the Actions column when canManage is false", () => {
    render(
      <TriggersTable rows={[row()]} failedAgents={0} canManage={false} {...BASE_PROPS} />,
    );
    expect(screen.getByTestId("triggers-table")).toBeTruthy();
    expect(screen.queryByText("Actions")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("filters rows by agent name via search", () => {
    render(
      <TriggersTable
        rows={[row({ agentId: "a1", agentName: "Agent One" }), row({ agentId: "a2", agentName: "Agent Two", triggerId: "atr_2" })]}
        failedAgents={0}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.change(screen.getByTestId("triggers-search"), { target: { value: "Two" } });
    expect(screen.queryByText("Agent One")).toBeNull();
    expect(screen.getByText("Agent Two")).toBeTruthy();
  });

  it("shows a no-match message when filters exclude every row", () => {
    render(<TriggersTable rows={[row()]} failedAgents={0} canManage={true} {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("triggers-search"), { target: { value: "nope" } });
    expect(screen.getByText("No triggers match your filters.")).toBeTruthy();
  });
});

describe("TriggersTable — row actions", () => {
  it("Edit opens the form dialog for the selected row", async () => {
    const target = row();
    render(<TriggersTable rows={[target]} failedAgents={0} canManage={true} {...BASE_PROPS} />);
    expect(screen.queryByTestId("edit-dialog-stub")).toBeNull();

    fireEvent.click(screen.getByTestId(`edit-${target.agentId}:${target.triggerId}`));

    const stub = await screen.findByTestId("edit-dialog-stub");
    expect(stub.textContent).toBe(`editing ${target.agentName} / ${target.triggerId}`);
  });

  it("Enable/Disable calls toggleTriggerAction with the flipped enabled flag and refreshes", async () => {
    const enabledRow = row({ enabled: true });
    render(
      <TriggersTable rows={[enabledRow]} failedAgents={0} canManage={true} {...BASE_PROPS} />,
    );
    const disableBtn = screen.getByTestId(`disable-${enabledRow.agentId}:${enabledRow.triggerId}`);
    await act(async () => {
      fireEvent.click(disableBtn);
    });
    await waitFor(() => expect(mockToggleTriggerAction).toHaveBeenCalled());
    expect(mockToggleTriggerAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      triggerId: "atr_1",
      trigger: {
        type: "manual",
        eventSource: undefined,
        eventType: undefined,
        connectionId: undefined,
        filter: {},
        schedule: undefined,
        enabled: false,
      },
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("Delete confirms through the dialog, calls deleteTriggerAction, and refreshes", async () => {
    const target = row();
    render(<TriggersTable rows={[target]} failedAgents={0} canManage={true} {...BASE_PROPS} />);
    const deleteBtn = screen.getByTestId(`delete-${target.agentId}:${target.triggerId}`);
    fireEvent.click(deleteBtn);

    expect(await screen.findByTestId("delete-dialog-stub")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-delete-stub"));
    });
    await waitFor(() =>
      expect(mockDeleteTriggerAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        triggerId: target.triggerId,
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });
});
