// @vitest-environment jsdom
/**
 * new-automation-dialog.test.tsx — unit tests for the no-chat automation
 * create form's validation, trigger-type switching, and submit wiring.
 *
 * Dialog primitives are mocked to plain controlled elements — same
 * convention as trigger-form-dialog.test.tsx and launch-workflow-dialog.
 * test.tsx. Select is mocked to the interactive controlled-context pattern
 * used by trigger-form-dialog.test.tsx so trigger-type/event-type/step-type
 * switching can be driven by a real click. The shared option constants
 * (TRIGGER_TYPE_OPTIONS, EVENT_TYPE_OPTIONS, STEP_TYPE_OPTIONS, emptyStep)
 * are pure data/factories imported from the chat registry module and are
 * left real (not mocked).
 *
 * Covers:
 *   - Empty name → inline "Name is required." error, no action call.
 *   - Event trigger (default) with no entity type → inline error.
 *   - Schedule trigger with no cron → inline error.
 *   - Switching trigger type swaps the visible fields (event / schedule /
 *     api read-only note).
 *   - A valid event-trigger submission calls createAutomationAction with the
 *     contract-shaped payload, then routes to the editor and refreshes.
 *   - A valid schedule-trigger submission submits cronExpression + timezone.
 *   - Steps: adding a step with a blank name is filtered out of the
 *     submitted `steps` array; a named step is included with its stepType.
 *   - The capability's own ok:false error renders inline; no navigation.
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
import { workspace } from "@/lib/routes";

const { mockPush, mockRefresh, mockAddToast, mockCreateAutomationAction } =
  vi.hoisted(() => ({
    mockPush: vi.fn(),
    mockRefresh: vi.fn(),
    mockAddToast: vi.fn(),
    mockCreateAutomationAction: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("../actions", () => ({
  createAutomationAction: (...args: unknown[]) =>
    mockCreateAutomationAction(...args),
}));

// Dialog primitives → plain divs (skip Base UI portals/animation in jsdom).
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogPopup: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...rest}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Select → interactive controlled-context mock, same convention as
// trigger-form-dialog.test.tsx. Each <Select> instance gets its own
// Provider, so multiple concurrently-rendered selects (trigger type, event
// type, per-step type) don't cross-wire.
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

import { NewAutomationDialog } from "./new-automation-dialog";

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  orgSlug: "acme",
  workspaceSlug: "main",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateAutomationAction.mockResolvedValue({
    ok: true,
    automation: {
      automation_id: "plt_1",
      playbook_id: "pb_1",
      name: "Notify on high-value deal",
      status: "draft",
      triggerType: "event",
      enabled: false,
    },
  });
});

afterEach(() => cleanup());

describe("NewAutomationDialog — validation", () => {
  it("shows an inline error for an empty name and never calls the action", async () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("entity-type"), {
      target: { value: "Contact" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-automation"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("create-error").textContent).toBe(
        "Name is required.",
      );
    });
    expect(mockCreateAutomationAction).not.toHaveBeenCalled();
  });

  it("event trigger (default) with no entity type shows an inline error", async () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("automation-name"), {
      target: { value: "Alpha" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-automation"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("create-error").textContent).toBe(
        "Graph-event triggers need an entity type to watch.",
      );
    });
    expect(mockCreateAutomationAction).not.toHaveBeenCalled();
  });

  it("schedule trigger with no cron shows an inline error", async () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("automation-name"), {
      target: { value: "Alpha" },
    });
    fireEvent.click(screen.getByText("Schedule (cron)"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-automation"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("create-error").textContent).toBe(
        "Schedule triggers need a cron expression.",
      );
    });
    expect(mockCreateAutomationAction).not.toHaveBeenCalled();
  });

  it("an api trigger needs neither entity type nor cron", async () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("automation-name"), {
      target: { value: "Alpha" },
    });
    fireEvent.click(screen.getByText("API / manual"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-automation"));
    });
    await waitFor(() => expect(mockCreateAutomationAction).toHaveBeenCalled());
    expect(mockCreateAutomationAction.mock.calls[0]?.[0]).toMatchObject({
      triggerType: "api",
      triggerConfig: {},
    });
  });
});

describe("NewAutomationDialog — trigger-type field switching", () => {
  it("shows entity-type + event fields for the (default) event trigger", () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    expect(screen.getByTestId("entity-type")).toBeTruthy();
    expect(screen.queryByTestId("cron")).toBeNull();
  });

  it("shows cron + timezone fields after switching to Schedule", () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.click(screen.getByText("Schedule (cron)"));
    expect(screen.getByTestId("cron")).toBeTruthy();
    expect(screen.queryByTestId("entity-type")).toBeNull();
  });

  it("shows the read-only note after switching to API / manual", () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.click(screen.getByText("API / manual"));
    expect(screen.getByText(/only fires when you use/i)).toBeTruthy();
    expect(screen.queryByTestId("entity-type")).toBeNull();
    expect(screen.queryByTestId("cron")).toBeNull();
  });
});

describe("NewAutomationDialog — submit wiring", () => {
  it("submits a valid event trigger with the contract-shaped payload and routes to the editor", async () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("automation-name"), {
      target: { value: "Notify on high-value deal" },
    });
    fireEvent.change(screen.getByTestId("entity-type"), {
      target: { value: "Contact" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-automation"));
    });
    await waitFor(() => expect(mockCreateAutomationAction).toHaveBeenCalled());
    expect(mockCreateAutomationAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      name: "Notify on high-value deal",
      description: undefined,
      triggerType: "event",
      triggerConfig: { entityType: "Contact", eventType: "node.created" },
      steps: [],
    });
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        workspace.automations.automation(
          { orgSlug: "acme", workspaceSlug: "main" },
          "plt_1",
        ),
      ),
    );
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("submits a valid schedule trigger with cronExpression + timezone", async () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("automation-name"), {
      target: { value: "Weekly digest" },
    });
    fireEvent.click(screen.getByText("Schedule (cron)"));
    fireEvent.change(screen.getByTestId("cron"), {
      target: { value: "0 9 * * 1" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-automation"));
    });
    await waitFor(() => expect(mockCreateAutomationAction).toHaveBeenCalled());
    expect(mockCreateAutomationAction.mock.calls[0]?.[0]).toMatchObject({
      triggerType: "schedule",
      triggerConfig: { cronExpression: "0 9 * * 1", timezone: "UTC" },
    });
  });

  it("filters out a step with a blank name and includes a named step's stepType", async () => {
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("automation-name"), {
      target: { value: "Alpha" },
    });
    fireEvent.change(screen.getByTestId("entity-type"), {
      target: { value: "Contact" },
    });

    // Add two steps: one left blank, one named.
    fireEvent.click(screen.getByText("Add step"));
    fireEvent.click(screen.getByText("Add step"));
    const nameInputs = screen.getAllByPlaceholderText("Step name");
    fireEvent.change(nameInputs[1]!, { target: { value: "Notify Slack" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-automation"));
    });
    await waitFor(() => expect(mockCreateAutomationAction).toHaveBeenCalled());
    expect(mockCreateAutomationAction.mock.calls[0]?.[0]).toMatchObject({
      steps: [{ name: "Notify Slack", stepType: "agent", config: {} }],
    });
  });

  it("renders the capability's own error inline on failure and does not navigate", async () => {
    mockCreateAutomationAction.mockResolvedValue({
      ok: false,
      error: "Only owners can do that.",
    });
    render(<NewAutomationDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("automation-name"), {
      target: { value: "Alpha" },
    });
    fireEvent.change(screen.getByTestId("entity-type"), {
      target: { value: "Contact" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-automation"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("create-error").textContent).toBe(
        "Only owners can do that.",
      );
    });
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
