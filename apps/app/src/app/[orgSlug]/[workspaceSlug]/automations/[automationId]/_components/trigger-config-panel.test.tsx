// @vitest-environment jsdom
/**
 * trigger-config-panel.test.tsx — unit tests for the trigger-configuration
 * view/edit panel.
 *
 * Select is mocked to the interactive controlled-context pattern used by
 * trigger-form-dialog.test.tsx so the event-type picker can be driven by a
 * real click. EVENT_TYPE_OPTIONS is real data (not mocked).
 *
 * Covers:
 *   - event type (view mode): renders entity type, event, and any property
 *     conditions.
 *   - schedule type (view mode): renders cron + timezone, defaulting the
 *     timezone display to "UTC" when unset.
 *   - api type: renders the read-only note and never shows an Edit button
 *     (even when canManage is true).
 *   - Edit is hidden entirely when canManage is false.
 *   - event type edit → Save calls updateAutomationAction with the edited
 *     entityType/eventType AND the existing property conditions preserved
 *     byte-for-byte (the panel never authors them).
 *   - schedule type edit → Save submits the edited cron + timezone.
 *   - Cancel discards the edit without calling the action.
 *   - A failed save shows an error toast and stays in edit mode.
 */
import * as React from "react";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockRefresh, mockAddToast, mockUpdateAutomationAction } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockAddToast: vi.fn(),
  mockUpdateAutomationAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("../../actions", () => ({
  updateAutomationAction: (...args: unknown[]) => mockUpdateAutomationAction(...args),
}));

const SelectMockCtx = React.createContext<{ onValueChange?: (v: string) => void }>({});
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => <SelectMockCtx.Provider value={{ onValueChange }}>{children}</SelectMockCtx.Provider>,
  SelectTrigger: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
    <div {...rest}>{children}</div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
    const ctx = React.useContext(SelectMockCtx);
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

import { TriggerConfigPanel } from "./trigger-config-panel";

const BASE_PROPS = { orgSlug: "acme", workspaceSlug: "main", automationId: "plt_1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateAutomationAction.mockResolvedValue({
    ok: true,
    result: {
      automation_id: "plt_1",
      name: "Alpha",
      description: null,
      status: "active",
      triggerType: "event",
      enabled: true,
    },
  });
});

afterEach(() => cleanup());

describe("TriggerConfigPanel — event type (view)", () => {
  it("renders entity type, event, and property conditions", () => {
    render(
      <TriggerConfigPanel
        {...BASE_PROPS}
        triggerType="event"
        triggerConfig={{
          entityType: "Contact",
          eventType: "node.created",
          propertyConditions: [{ property: "status", operator: "eq", toValue: "won" }],
        }}
        canManage={true}
      />,
    );
    expect(screen.getByText("Contact")).toBeTruthy();
    expect(screen.getByText("node.created")).toBeTruthy();
    expect(screen.getByText("status eq won")).toBeTruthy();
  });

  it("renders dashes when entity type / event are unset and hides the Conditions row", () => {
    render(
      <TriggerConfigPanel {...BASE_PROPS} triggerType="event" triggerConfig={{}} canManage={true} />,
    );
    expect(screen.queryByText("Conditions")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("TriggerConfigPanel — schedule type (view)", () => {
  it("renders cron + timezone, defaulting timezone display to UTC", () => {
    render(
      <TriggerConfigPanel
        {...BASE_PROPS}
        triggerType="schedule"
        triggerConfig={{ cronExpression: "0 9 * * 1" }}
        canManage={true}
      />,
    );
    expect(screen.getByText("0 9 * * 1")).toBeTruthy();
    expect(screen.getByText("UTC")).toBeTruthy();
  });
});

describe("TriggerConfigPanel — api type", () => {
  it("renders the read-only note and never an Edit button, even when canManage is true", () => {
    render(
      <TriggerConfigPanel {...BASE_PROPS} triggerType="api" triggerConfig={{}} canManage={true} />,
    );
    expect(screen.getByText(/only fires when you use/i)).toBeTruthy();
    expect(screen.queryByTestId("edit-trigger")).toBeNull();
  });
});

describe("TriggerConfigPanel — permissions", () => {
  it("hides Edit when canManage is false", () => {
    render(
      <TriggerConfigPanel
        {...BASE_PROPS}
        triggerType="event"
        triggerConfig={{ entityType: "Contact" }}
        canManage={false}
      />,
    );
    expect(screen.queryByTestId("edit-trigger")).toBeNull();
  });
});

describe("TriggerConfigPanel — event type edit", () => {
  it("Save preserves existing property conditions unchanged while submitting edited fields", async () => {
    render(
      <TriggerConfigPanel
        {...BASE_PROPS}
        triggerType="event"
        triggerConfig={{
          entityType: "Contact",
          eventType: "node.created",
          propertyConditions: [{ property: "status", operator: "eq", toValue: "won" }],
        }}
        canManage={true}
      />,
    );
    fireEvent.click(screen.getByTestId("edit-trigger"));
    fireEvent.change(screen.getByTestId("cfg-entity"), { target: { value: "Deal" } });
    fireEvent.click(screen.getByText("Node updated"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-trigger"));
    });
    await waitFor(() =>
      expect(mockUpdateAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "plt_1",
        triggerConfig: {
          entityType: "Deal",
          eventType: "node.updated",
          propertyConditions: [{ property: "status", operator: "eq", toValue: "won" }],
        },
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
    expect(screen.queryByTestId("save-trigger")).toBeNull();
  });

  it("Cancel discards the edit without calling the action", () => {
    render(
      <TriggerConfigPanel
        {...BASE_PROPS}
        triggerType="event"
        triggerConfig={{ entityType: "Contact" }}
        canManage={true}
      />,
    );
    fireEvent.click(screen.getByTestId("edit-trigger"));
    fireEvent.change(screen.getByTestId("cfg-entity"), { target: { value: "Discarded" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(mockUpdateAutomationAction).not.toHaveBeenCalled();
    expect(screen.getByText("Contact")).toBeTruthy();
  });
});

describe("TriggerConfigPanel — schedule type edit", () => {
  it("Save submits the edited cron + timezone", async () => {
    render(
      <TriggerConfigPanel
        {...BASE_PROPS}
        triggerType="schedule"
        triggerConfig={{ cronExpression: "0 9 * * 1", timezone: "UTC" }}
        canManage={true}
      />,
    );
    fireEvent.click(screen.getByTestId("edit-trigger"));
    fireEvent.change(screen.getByTestId("cfg-cron"), { target: { value: "0 0 * * *" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-trigger"));
    });
    await waitFor(() =>
      expect(mockUpdateAutomationAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        automationId: "plt_1",
        triggerConfig: { cronExpression: "0 0 * * *", timezone: "UTC" },
      }),
    );
  });

  it("a failed save shows an error toast and stays in edit mode", async () => {
    mockUpdateAutomationAction.mockResolvedValue({ ok: false, error: "Nope." });
    render(
      <TriggerConfigPanel
        {...BASE_PROPS}
        triggerType="schedule"
        triggerConfig={{ cronExpression: "0 9 * * 1" }}
        canManage={true}
      />,
    );
    fireEvent.click(screen.getByTestId("edit-trigger"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-trigger"));
    });
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", description: "Nope." }),
      ),
    );
    expect(screen.getByTestId("save-trigger")).toBeTruthy();
  });
});
