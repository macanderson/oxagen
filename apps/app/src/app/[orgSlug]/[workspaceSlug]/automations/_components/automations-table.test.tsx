// @vitest-environment jsdom
/**
 * automations-table.test.tsx — unit tests for the Automations list table.
 *
 * Base UI popover primitives (Menu, Select) are mocked to plain controlled
 * elements — same convention as triggers-table.test.tsx and launch-workflow-
 * dialog.test.tsx — so tests exercise the real filter/gating/dispatch logic
 * without depending on floating-ui portals in jsdom. The child dialogs
 * (EnableConfirmDialog, TriggerNowDialog) are stubbed to simple controlled
 * markers that expose their callback props — their own logic is covered by
 * enable-confirm-dialog.test.tsx and trigger-now-dialog.test.tsx; here we only
 * prove the table wires the right row into them and reacts correctly to their
 * callbacks (per the module doc: enable is a human-gated action that goes
 * through the confirm dialog, never a direct call).
 *
 * Covers:
 *   - True empty state (no automations at all) renders "No automations yet".
 *   - Search / trigger-type / enabled-state filters narrow the visible rows.
 *   - A no-match filter combination renders the inline "No automations match
 *     your filters." row instead of the true empty state.
 *   - canManage=false hides Trigger now / Enable / Disable but keeps Edit.
 *   - Edit renders a real link to the automation's editor route.
 *   - Enable opens EnableConfirmDialog (never calls enableAutomationAction
 *     directly); confirming it calls enableAutomationAction and refreshes.
 *   - Enable failure shows an error toast and still closes the dialog.
 *   - Disable calls disableAutomationAction directly (no confirm dialog).
 *   - Trigger now opens TriggerNowDialog wired to triggerAutomationAction,
 *     for both the ok and error outcomes.
 */
import * as React from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AutomationListOutput } from "@oxagen/oxagen/contracts/automation.list";
import { workspace } from "@/lib/routes";

const {
  mockRefresh,
  mockAddToast,
  mockEnableAutomationAction,
  mockDisableAutomationAction,
  mockTriggerAutomationAction,
} = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockAddToast: vi.fn(),
  mockEnableAutomationAction: vi.fn(),
  mockDisableAutomationAction: vi.fn(),
  mockTriggerAutomationAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("../actions", () => ({
  enableAutomationAction: (...args: unknown[]) =>
    mockEnableAutomationAction(...args),
  disableAutomationAction: (...args: unknown[]) =>
    mockDisableAutomationAction(...args),
  triggerAutomationAction: (...args: unknown[]) =>
    mockTriggerAutomationAction(...args),
}));

// Menu → items render as plain elements; MenuItem supports the Base UI
// `render` prop used for the Edit link (clones the target element, same
// Slot-style merge Base UI performs).
vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement;
  }) => React.cloneElement(render, undefined, children),
  MenuPopup: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  MenuItem: ({
    children,
    onClick,
    disabled,
    render,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    render?: React.ReactElement;
    "data-testid"?: string;
  }) => {
    if (render) {
      return React.cloneElement(
        render,
        { "data-testid": testId } as Record<string, unknown>,
        children,
      );
    }
    return (
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        disabled={disabled}
        data-testid={testId}
      >
        {children}
      </button>
    );
  },
}));

// Select → items render as plain clickable buttons carrying the option's
// value via a shared context — same convention as trigger-form-dialog.
// test.tsx. Query select items by role="button" to disambiguate from row
// Badges that render the same label text ("Enabled"/"Schedule"/etc) as plain
// spans.
const SelectMockCtx = React.createContext<{
  onValueChange?: (v: string) => void;
}>({});
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => (
    <SelectMockCtx.Provider value={{ onValueChange }}>
      {children}
    </SelectMockCtx.Provider>
  ),
  SelectTrigger: ({
    children,
    ...rest
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <div {...rest}>{children}</div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const ctx = React.useContext(SelectMockCtx);
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

vi.mock("./enable-confirm-dialog", () => ({
  EnableConfirmDialog: ({
    open,
    automationName,
    onConfirm,
  }: {
    open: boolean;
    automationName: string;
    onConfirm: () => Promise<void>;
  }) =>
    open ? (
      <div data-testid="enable-dialog-stub">
        <span>enabling {automationName}</span>
        <button
          type="button"
          onClick={() => void onConfirm()}
          data-testid="confirm-enable-stub"
        >
          confirm
        </button>
      </div>
    ) : null,
}));

vi.mock("./trigger-now-dialog", () => ({
  TriggerNowDialog: ({
    open,
    automationName,
    onTrigger,
  }: {
    open: boolean;
    automationName: string;
    onTrigger: (payload: Record<string, unknown> | undefined) => Promise<{
      ok: boolean;
      executionId?: string;
      status?: string;
      error?: string;
    }>;
  }) =>
    open ? (
      <div data-testid="trigger-now-dialog-stub">
        <span>triggering {automationName}</span>
        <button
          type="button"
          onClick={() => void onTrigger(undefined)}
          data-testid="fire-trigger-stub"
        >
          fire
        </button>
      </div>
    ) : null,
}));

// new-automation-button owns the create dialog; the table only wires it into
// the empty state. Stub it so this file asserts the wiring (button present when
// canManage) without pulling in the full create-dialog subtree — that's covered
// by new-automation-button.test.tsx.
vi.mock("./new-automation-button", () => ({
  NewAutomationButton: ({
    orgSlug,
    workspaceSlug,
  }: {
    orgSlug: string;
    workspaceSlug: string;
  }) => (
    <button
      type="button"
      data-testid="new-automation"
      data-org={orgSlug}
      data-ws={workspaceSlug}
    >
      New automation
    </button>
  ),
}));

import { AutomationsTable } from "./automations-table";

type Row = AutomationListOutput[number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "auto_1",
    name: "Notify on high-value deal",
    status: "active",
    triggerType: "event",
    triggers: [],
    ...overrides,
  };
}

const BASE_PROPS = {
  orgSlug: "acme",
  workspaceSlug: "main",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnableAutomationAction.mockResolvedValue({
    ok: true,
    result: { enabled: true },
  });
  mockDisableAutomationAction.mockResolvedValue({
    ok: true,
    result: { enabled: false },
  });
  mockTriggerAutomationAction.mockResolvedValue({
    ok: true,
    result: { execution_id: "aex_1", status: "running" },
  });
});

afterEach(() => cleanup());

describe("AutomationsTable — empty state", () => {
  it("renders the true empty state when there are no automations at all", () => {
    render(
      <AutomationsTable automations={[]} canManage={true} {...BASE_PROPS} />,
    );
    expect(screen.getByText("No automations yet")).toBeTruthy();
    expect(screen.queryByTestId("automations-table")).toBeNull();
  });

  it("offers a create action inside the empty state when the user can manage", () => {
    render(
      <AutomationsTable automations={[]} canManage={true} {...BASE_PROPS} />,
    );
    expect(screen.getByTestId("new-automation")).toBeTruthy();
  });

  it("omits the create action from the empty state for read-only members", () => {
    render(
      <AutomationsTable automations={[]} canManage={false} {...BASE_PROPS} />,
    );
    expect(screen.getByText("No automations yet")).toBeTruthy();
    expect(screen.queryByTestId("new-automation")).toBeNull();
  });
});

describe("AutomationsTable — filters", () => {
  it("filters rows by name via search", () => {
    render(
      <AutomationsTable
        automations={[
          row({ id: "a1", name: "Alpha" }),
          row({ id: "a2", name: "Beta" }),
        ]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.change(screen.getByTestId("automations-search"), {
      target: { value: "Beta" },
    });
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("filters rows by trigger type", () => {
    render(
      <AutomationsTable
        automations={[
          row({ id: "a1", name: "Alpha", triggerType: "event" }),
          row({ id: "a2", name: "Beta", triggerType: "schedule" }),
        ]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("filters rows by enabled state", () => {
    render(
      <AutomationsTable
        automations={[
          row({ id: "a1", name: "Alpha", status: "active" }),
          row({ id: "a2", name: "Beta", status: "disabled" }),
        ]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("shows a no-match message (not the true empty state) when filters exclude every row", () => {
    render(
      <AutomationsTable
        automations={[row({ id: "a1", name: "Alpha" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.change(screen.getByTestId("automations-search"), {
      target: { value: "nope" },
    });
    expect(screen.getByText("No automations match your filters.")).toBeTruthy();
    expect(screen.queryByText("No automations yet")).toBeNull();
  });
});

describe("AutomationsTable — permissions", () => {
  it("hides Trigger now / Enable / Disable but keeps Edit when canManage is false", () => {
    render(
      <AutomationsTable
        automations={[row({ id: "a1", status: "active" })]}
        canManage={false}
        {...BASE_PROPS}
      />,
    );
    expect(screen.queryByTestId("trigger-a1")).toBeNull();
    expect(screen.queryByTestId("enable-a1")).toBeNull();
    expect(screen.queryByTestId("disable-a1")).toBeNull();
    expect(screen.getByRole("link", { name: /Edit/i })).toBeTruthy();
  });

  it("Edit links to the automation's editor route", () => {
    render(
      <AutomationsTable
        automations={[row({ id: "a1" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    const editLink = screen.getByRole("link", { name: /Edit/i });
    expect(editLink.getAttribute("href")).toBe(
      workspace.automations.automation(
        { orgSlug: "acme", workspaceSlug: "main" },
        "a1",
      ),
    );
  });
});

describe("AutomationsTable — enable (human gate)", () => {
  it("Enable opens the confirm dialog and never calls enableAutomationAction directly", () => {
    render(
      <AutomationsTable
        automations={[row({ id: "a1", name: "Alpha", status: "disabled" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("enable-a1"));
    expect(screen.getByTestId("enable-dialog-stub").textContent).toContain(
      "Alpha",
    );
    expect(mockEnableAutomationAction).not.toHaveBeenCalled();
  });

  it("confirming the enable dialog calls enableAutomationAction and refreshes", async () => {
    render(
      <AutomationsTable
        automations={[row({ id: "a1", name: "Alpha", status: "disabled" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("enable-a1"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-enable-stub"));
    });
    await waitFor(() =>
      expect(mockEnableAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "a1",
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
    expect(screen.queryByTestId("enable-dialog-stub")).toBeNull();
  });

  it("a failed enable shows an error toast, does not refresh, and closes the dialog", async () => {
    mockEnableAutomationAction.mockResolvedValue({
      ok: false,
      error: "Only owners can enable.",
    });
    render(
      <AutomationsTable
        automations={[row({ id: "a1", name: "Alpha", status: "disabled" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("enable-a1"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-enable-stub"));
    });
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          description: "Only owners can enable.",
        }),
      ),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId("enable-dialog-stub")).toBeNull();
  });
});

describe("AutomationsTable — disable (direct)", () => {
  it("Disable calls disableAutomationAction directly (no confirm dialog) and refreshes", async () => {
    render(
      <AutomationsTable
        automations={[row({ id: "a1", name: "Alpha", status: "active" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("disable-a1"));
    });
    expect(screen.queryByTestId("enable-dialog-stub")).toBeNull();
    await waitFor(() =>
      expect(mockDisableAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "a1",
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("a failed disable shows an error toast and does not refresh", async () => {
    mockDisableAutomationAction.mockResolvedValue({
      ok: false,
      error: "Nope.",
    });
    render(
      <AutomationsTable
        automations={[row({ id: "a1", name: "Alpha", status: "active" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("disable-a1"));
    });
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", description: "Nope." }),
      ),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("AutomationsTable — trigger now", () => {
  it("Trigger now opens the dialog wired to triggerAutomationAction and refreshes on success", async () => {
    render(
      <AutomationsTable
        automations={[row({ id: "a1", name: "Alpha" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger-a1"));
    expect(screen.getByTestId("trigger-now-dialog-stub").textContent).toContain(
      "Alpha",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("fire-trigger-stub"));
    });
    await waitFor(() =>
      expect(mockTriggerAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "a1",
        payload: undefined,
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it("a failed trigger surfaces the capability error without refreshing", async () => {
    mockTriggerAutomationAction.mockResolvedValue({
      ok: false,
      error: "Rate limited.",
    });
    render(
      <AutomationsTable
        automations={[row({ id: "a1", name: "Alpha" })]}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger-a1"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("fire-trigger-stub"));
    });
    await waitFor(() => expect(mockTriggerAutomationAction).toHaveBeenCalled());
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
