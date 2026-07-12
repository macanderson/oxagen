// @vitest-environment jsdom
/**
 * trigger-form-dialog.test.tsx — unit tests for the shared create/edit
 * trigger form validation and submit wiring.
 *
 * Base UI primitives (Dialog, Select) are mocked to plain controlled elements
 * — same convention as automations/workflows/_components/launch-workflow-
 * dialog.test.tsx — so the test exercises real component state/validation
 * logic without depending on Base UI portals/floating-ui positioning in
 * jsdom. Checkbox is left real (no portal, a plain Base UI button with
 * role="checkbox").
 *
 * Covers:
 *   - Create mode renders the Agent picker; defaults to the first agent.
 *   - Create: empty agent list shows the "no agents" hint.
 *   - Schedule type with no cron → inline error, no action call.
 *   - Event type missing source/type → inline error, no action call.
 *   - Create: a valid manual trigger submits createTriggerAction with the
 *     contract-shaped payload and calls onCreated.
 *   - Create: switching the agent picker changes the submitted agentId.
 *   - Create: a valid schedule trigger submits the cron + enabled flag.
 *   - Edit mode shows the fixed agent name (no picker) and prefills fields
 *     from `initial`; submits updateTriggerAction with triggerId + trigger
 *     and calls onSaved.
 *   - The capability's own ok:false error renders inline; onCreated/onSaved
 *     is not called.
 */
import * as React from "react";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAddToast, mockCreateTriggerAction, mockUpdateTriggerAction } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockCreateTriggerAction: vi.fn(),
  mockUpdateTriggerAction: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("../actions", () => ({
  createTriggerAction: (...args: unknown[]) => mockCreateTriggerAction(...args),
  updateTriggerAction: (...args: unknown[]) => mockUpdateTriggerAction(...args),
}));

// Dialog primitives → plain divs (skip Base UI portals/animation in jsdom).
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogPopup: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...rest}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Select → items render as plain clickable buttons carrying the option's
// value via a shared context, mirroring the MenuItem-as-button convention
// used elsewhere in this codebase (e.g. conversation-export-menu.test.tsx).
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

import { TriggerFormDialog } from "./trigger-form-dialog";

const AGENTS = [
  { agentId: "a1", publicId: "agt_1", name: "Agent One", agentType: "custom" },
  { agentId: "a2", publicId: "agt_2", name: "Agent Two", agentType: "custom" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTriggerAction.mockResolvedValue({
    ok: true,
    trigger: { triggerId: "t1", publicId: "atr_1", triggerType: "manual", enabled: false },
  });
  mockUpdateTriggerAction.mockResolvedValue({
    ok: true,
    trigger: { triggerId: "t1", triggerType: "manual", enabled: false },
  });
});

afterEach(() => cleanup());

describe("TriggerFormDialog — create mode", () => {
  it("renders the agent picker with every eligible agent", () => {
    render(
      <TriggerFormDialog
        mode="create"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agents={AGENTS}
      />,
    );
    expect(screen.getByText("Agent One")).toBeTruthy();
    expect(screen.getByText("Agent Two")).toBeTruthy();
  });

  it("shows a hint when there are no eligible agents", () => {
    render(
      <TriggerFormDialog
        mode="create"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agents={[]}
      />,
    );
    expect(screen.getByText(/No agents available/i)).toBeTruthy();
  });

  it("schedule type with no cron shows an inline error and never calls the action", async () => {
    render(
      <TriggerFormDialog
        mode="create"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agents={AGENTS}
      />,
    );
    fireEvent.click(screen.getByText("Schedule"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("trigger-form-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("trigger-form-error").textContent).toBe(
        "Schedule triggers need a cron expression.",
      );
    });
    expect(mockCreateTriggerAction).not.toHaveBeenCalled();
  });

  it("event type missing source/type shows an inline error and never calls the action", async () => {
    render(
      <TriggerFormDialog
        mode="create"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agents={AGENTS}
      />,
    );
    fireEvent.click(screen.getByText("Event"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("trigger-form-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("trigger-form-error").textContent).toBe(
        "Event triggers need both an event source and an event type.",
      );
    });
    expect(mockCreateTriggerAction).not.toHaveBeenCalled();
  });

  it("submits a valid manual trigger for the default (first) agent and calls onCreated", async () => {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TriggerFormDialog
        mode="create"
        open={true}
        onOpenChange={onOpenChange}
        orgSlug="acme"
        workspaceSlug="main"
        agents={AGENTS}
        onCreated={onCreated}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("trigger-form-submit"));
    });
    await waitFor(() => expect(mockCreateTriggerAction).toHaveBeenCalled());
    expect(mockCreateTriggerAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      agentId: "a1",
      trigger: {
        type: "manual",
        eventSource: undefined,
        eventType: undefined,
        connectionId: undefined,
        filter: undefined,
        schedule: undefined,
        enabled: false,
      },
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("switching the agent picker changes the submitted agentId", async () => {
    render(
      <TriggerFormDialog
        mode="create"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agents={AGENTS}
      />,
    );
    fireEvent.click(screen.getByText("Agent Two"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("trigger-form-submit"));
    });
    await waitFor(() => expect(mockCreateTriggerAction).toHaveBeenCalled());
    expect(mockCreateTriggerAction.mock.calls[0]?.[0]).toMatchObject({ agentId: "a2" });
  });

  it("submits a valid schedule trigger with the cron string and enabled flag", async () => {
    render(
      <TriggerFormDialog
        mode="create"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agents={AGENTS}
      />,
    );
    fireEvent.click(screen.getByText("Schedule"));
    fireEvent.change(screen.getByTestId("trigger-cron-input"), {
      target: { value: "0 9 * * 1" },
    });
    fireEvent.click(screen.getByTestId("trigger-enabled"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("trigger-form-submit"));
    });
    await waitFor(() => expect(mockCreateTriggerAction).toHaveBeenCalled());
    expect(mockCreateTriggerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({
          type: "schedule",
          schedule: "0 9 * * 1",
          enabled: true,
        }),
      }),
    );
  });

  it("renders the capability's own error inline on failure and never calls onCreated", async () => {
    mockCreateTriggerAction.mockResolvedValue({ ok: false, error: "Only owners can do that." });
    const onCreated = vi.fn();
    render(
      <TriggerFormDialog
        mode="create"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agents={AGENTS}
        onCreated={onCreated}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("trigger-form-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("trigger-form-error").textContent).toBe("Only owners can do that.");
    });
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("TriggerFormDialog — edit mode", () => {
  it("shows the fixed agent name (no picker) and prefills event fields from `initial`", () => {
    render(
      <TriggerFormDialog
        mode="edit"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agentName="Agent One"
        triggerId="atr_1"
        initial={{
          type: "event",
          eventSource: "github_repo",
          eventType: "push",
          connectionId: "conn_1",
          filter: { branches: ["main"], pathGlobs: ["src/**"] },
          enabled: true,
        }}
      />,
    );
    expect(screen.getByText("Agent One")).toBeTruthy();
    expect(screen.queryByText("Agent Two")).toBeNull();
    expect((screen.getByTestId("trigger-event-source") as HTMLInputElement).value).toBe(
      "github_repo",
    );
    expect((screen.getByTestId("trigger-event-type") as HTMLInputElement).value).toBe("push");
    expect((screen.getByTestId("trigger-branches") as HTMLInputElement).value).toBe("main");
    expect((screen.getByTestId("trigger-path-globs") as HTMLInputElement).value).toBe("src/**");
  });

  it("submits updateTriggerAction with the triggerId and edited trigger, then calls onSaved", async () => {
    const onSaved = vi.fn();
    render(
      <TriggerFormDialog
        mode="edit"
        open={true}
        onOpenChange={vi.fn()}
        orgSlug="acme"
        workspaceSlug="main"
        agentName="Agent One"
        triggerId="atr_1"
        initial={{ type: "manual", enabled: false }}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger-enabled"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("trigger-form-submit"));
    });
    await waitFor(() => expect(mockUpdateTriggerAction).toHaveBeenCalled());
    expect(mockUpdateTriggerAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      triggerId: "atr_1",
      trigger: {
        type: "manual",
        eventSource: undefined,
        eventType: undefined,
        connectionId: undefined,
        filter: undefined,
        schedule: undefined,
        enabled: true,
      },
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
