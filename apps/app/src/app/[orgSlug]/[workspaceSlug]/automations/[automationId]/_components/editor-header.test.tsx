// @vitest-environment jsdom
/**
 * editor-header.test.tsx — unit tests for the automation editor header:
 * inline name/description edit, the human-gated enable switch, direct
 * disable, and trigger-now.
 *
 * EnableConfirmDialog + TriggerNowDialog are stubbed to simple controlled
 * markers that expose their callback props — same convention as
 * automations-table.test.tsx (they own the real dialogs; here we only prove
 * this header wires the right automation into them).
 *
 * Switch is mocked to a plain native `<button role="switch">` forwarding
 * checked/disabled/onCheckedChange. The real Base UI Switch renders a
 * `<span>` + hidden `<input>` and drives its click via a synthesized
 * `PointerEvent` dispatched at the hidden input (see @base-ui/react/switch's
 * SwitchRoot) rather than a plain onClick — nothing else in this codebase
 * fires a click at a Base UI Switch and asserts on the resulting callback, so
 * that interaction path is unproven in this jsdom setup. Mocking it (like
 * Dialog/Menu/Select are mocked elsewhere) keeps the test asserting
 * EditorHeader's own state/wiring, not Base UI's DOM internals.
 *
 * Covers:
 *   - Inline edit: opens the name/description inputs prefilled from the
 *     automation; Save calls updateAutomationAction and closes editing;
 *     Cancel discards the edit without calling the action.
 *   - An empty trimmed name shows an error toast and never calls the action.
 *   - Enabling (switch off → on) opens EnableConfirmDialog and does NOT call
 *     enableAutomationAction directly; confirming it does, then refreshes.
 *   - Disabling (switch on → off) calls disableAutomationAction directly, no
 *     confirm dialog.
 *   - Trigger now opens TriggerNowDialog wired to triggerAutomationAction.
 *   - canManage=false hides the edit pencil and Trigger-now button and
 *     disables the switch.
 */
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AutomationGetOutput } from "@oxagen/oxagen/contracts/automation.get";

const {
  mockRefresh,
  mockAddToast,
  mockUpdateAutomationAction,
  mockEnableAutomationAction,
  mockDisableAutomationAction,
  mockTriggerAutomationAction,
} = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockAddToast: vi.fn(),
  mockUpdateAutomationAction: vi.fn(),
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

vi.mock("../../actions", () => ({
  updateAutomationAction: (...args: unknown[]) =>
    mockUpdateAutomationAction(...args),
  enableAutomationAction: (...args: unknown[]) =>
    mockEnableAutomationAction(...args),
  disableAutomationAction: (...args: unknown[]) =>
    mockDisableAutomationAction(...args),
  triggerAutomationAction: (...args: unknown[]) =>
    mockTriggerAutomationAction(...args),
}));

vi.mock("../../_components/enable-confirm-dialog", () => ({
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

vi.mock("../../_components/trigger-now-dialog", () => ({
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

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    "data-testid": testId,
    "aria-label": ariaLabel,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange?: (next: boolean) => void;
    "data-testid"?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      data-testid={testId}
    />
  ),
}));

import { EditorHeader } from "./editor-header";

function automation(
  overrides: Partial<AutomationGetOutput> = {},
): AutomationGetOutput {
  return {
    automation_id: "plt_1",
    playbook_id: "pb_1",
    name: "Notify on high-value deal",
    description: "Sends a Slack ping.",
    status: "active",
    triggerType: "event",
    enabled: true,
    triggerConfig: {},
    steps: [],
    runs: [],
    ...overrides,
  };
}

const BASE_PROPS = { orgSlug: "acme", workspaceSlug: "main" };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateAutomationAction.mockResolvedValue({
    ok: true,
    result: {
      automation_id: "plt_1",
      name: "Notify on high-value deal",
      description: null,
      status: "active",
      triggerType: "event",
      enabled: true,
    },
  });
  mockEnableAutomationAction.mockResolvedValue({
    ok: true,
    result: { automation_id: "plt_1", enabled: true, status: "active" },
  });
  mockDisableAutomationAction.mockResolvedValue({
    ok: true,
    result: { automation_id: "plt_1", enabled: false, status: "paused" },
  });
  mockTriggerAutomationAction.mockResolvedValue({
    ok: true,
    result: { execution_id: "aex_1", status: "running" },
  });
});

afterEach(() => cleanup());

describe("EditorHeader — inline edit", () => {
  it("opens the edit form prefilled from the automation", () => {
    render(
      <EditorHeader
        automation={automation()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("edit-details"));
    expect((screen.getByTestId("edit-name") as HTMLInputElement).value).toBe(
      "Notify on high-value deal",
    );
  });

  it("Save calls updateAutomationAction with the trimmed edits and closes editing", async () => {
    render(
      <EditorHeader
        automation={automation()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("edit-details"));
    fireEvent.change(screen.getByTestId("edit-name"), {
      target: { value: "  Renamed  " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-details"));
    });
    await waitFor(() =>
      expect(mockUpdateAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "plt_1",
        name: "Renamed",
        description: "Sends a Slack ping.",
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
    expect(screen.queryByTestId("edit-name")).toBeNull();
  });

  it("Cancel discards the edit without calling the action", () => {
    render(
      <EditorHeader
        automation={automation()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("edit-details"));
    fireEvent.change(screen.getByTestId("edit-name"), {
      target: { value: "Discarded" },
    });
    fireEvent.click(screen.getByText("Cancel"));
    expect(mockUpdateAutomationAction).not.toHaveBeenCalled();
    expect(screen.getByText("Notify on high-value deal")).toBeTruthy();
  });

  it("shows an error toast for an empty trimmed name and never calls the action", async () => {
    render(
      <EditorHeader
        automation={automation()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("edit-details"));
    fireEvent.change(screen.getByTestId("edit-name"), {
      target: { value: "   " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-details"));
    });
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Name is required", type: "error" }),
    );
    expect(mockUpdateAutomationAction).not.toHaveBeenCalled();
  });

  it("renders 'No description' when the automation has none", () => {
    render(
      <EditorHeader
        automation={automation({ description: null })}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    expect(screen.getByText("No description")).toBeTruthy();
  });
});

describe("EditorHeader — enable (human gate)", () => {
  it("toggling the switch on opens the confirm dialog without calling enableAutomationAction directly", () => {
    render(
      <EditorHeader
        automation={automation({ enabled: false })}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("enabled-switch"));
    expect(screen.getByTestId("enable-dialog-stub").textContent).toContain(
      "Notify on high-value deal",
    );
    expect(mockEnableAutomationAction).not.toHaveBeenCalled();
  });

  it("confirming enable calls enableAutomationAction and refreshes", async () => {
    render(
      <EditorHeader
        automation={automation({ enabled: false })}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("enabled-switch"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-enable-stub"));
    });
    await waitFor(() =>
      expect(mockEnableAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "plt_1",
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("a failed enable shows an error toast and closes the dialog", async () => {
    mockEnableAutomationAction.mockResolvedValue({ ok: false, error: "Nope." });
    render(
      <EditorHeader
        automation={automation({ enabled: false })}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("enabled-switch"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-enable-stub"));
    });
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      ),
    );
    expect(screen.queryByTestId("enable-dialog-stub")).toBeNull();
  });
});

describe("EditorHeader — disable (direct)", () => {
  it("toggling the switch off calls disableAutomationAction directly and refreshes", async () => {
    render(
      <EditorHeader
        automation={automation({ enabled: true })}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("enabled-switch"));
    });
    expect(screen.queryByTestId("enable-dialog-stub")).toBeNull();
    await waitFor(() =>
      expect(mockDisableAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "plt_1",
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });
});

describe("EditorHeader — trigger now", () => {
  it("Trigger now opens the dialog wired to triggerAutomationAction and refreshes", async () => {
    render(
      <EditorHeader
        automation={automation()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger-now"));
    expect(screen.getByTestId("trigger-now-dialog-stub")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fire-trigger-stub"));
    });
    await waitFor(() =>
      expect(mockTriggerAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "plt_1",
        payload: undefined,
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });
});

describe("EditorHeader — permissions", () => {
  it("hides the edit pencil and Trigger-now button, and disables the switch, when canManage is false", () => {
    render(
      <EditorHeader
        automation={automation()}
        canManage={false}
        {...BASE_PROPS}
      />,
    );
    expect(screen.queryByTestId("edit-details")).toBeNull();
    expect(screen.queryByTestId("trigger-now")).toBeNull();
    expect(screen.getByTestId("enabled-switch")).toBeDisabled();
  });
});
