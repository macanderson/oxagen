// @vitest-environment jsdom
/**
 * triggers-panel.test.tsx — component tests for TriggersPanel.
 *
 * Covers: empty state, listing existing triggers, adding a manual trigger,
 * adding an event (GitHub repo source change) trigger, validation rejection of
 * an incomplete event trigger, editing, and deleting.
 */
import * as React from "react";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreate, mockUpdate, mockDelete, mockRefresh, mockAddToast } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockRefresh: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock("../agent-actions", () => ({
  createTriggerAction: mockCreate,
  updateTriggerAction: mockUpdate,
  deleteTriggerAction: mockDelete,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

// Auto-stub every icon: a hardcoded subset breaks whenever a component in the
// render tree adds an icon (this test previously failed on a missing `Minus`).
vi.mock("lucide-react", () => new Proxy({} as Record<string | symbol, unknown>, {
  get: (_t, prop) => (prop === "then" ? undefined : () => <svg aria-hidden="true" data-icon={String(prop)} />),
  has: (_t, prop) => prop !== "then",
}));

import { TriggersPanel } from "./triggers-panel";
import type { AgentTriggerListOutput } from "../agent-actions";

type Trigger = AgentTriggerListOutput["triggers"][number];

const baseProps = {
  agentId: "agt_1",
  canEdit: true,
  orgSlug: "acme",
  workspaceSlug: "prod",
};

const existing: Trigger[] = [
  {
    triggerId: "atr_1",
    publicId: "atr_1",
    triggerType: "event",
    eventSource: "github_repo",
    eventType: "push",
    connectionId: null,
    filter: { branches: ["main"], pathGlobs: ["src/**"] },
    schedule: null,
    enabled: true,
  },
];

describe("TriggersPanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("renders an empty state with no triggers", () => {
    render(<TriggersPanel {...baseProps} triggers={[]} />);
    expect(screen.getByText(/no triggers/i)).toBeInTheDocument();
  });

  it("lists existing triggers with a summary", () => {
    render(<TriggersPanel {...baseProps} triggers={existing} />);
    expect(screen.getByText(/github_repo · push/i)).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("adds a manual trigger via createTriggerAction", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: {} });
    render(<TriggersPanel {...baseProps} triggers={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /add trigger/i }));
    fireEvent.click(screen.getByRole("button", { name: /save trigger/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as { trigger: { type: string } };
    expect(arg.trigger.type).toBe("manual");
  });

  it("adds an event trigger (github repo source change) with filter", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: {} });
    render(<TriggersPanel {...baseProps} triggers={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /add trigger/i }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "event" } });
    fireEvent.change(screen.getByLabelText("Event source"), { target: { value: "github_repo" } });
    fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "push" } });
    fireEvent.change(screen.getByLabelText("Branches (comma-separated)"), {
      target: { value: "main, release/*" },
    });
    fireEvent.change(screen.getByLabelText("Path globs (comma-separated)"), {
      target: { value: "src/**" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save trigger/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as {
      trigger: {
        type: string;
        eventSource: string;
        eventType: string;
        filter?: { branches?: string[]; pathGlobs?: string[] };
      };
    };
    expect(arg.trigger.type).toBe("event");
    expect(arg.trigger.eventSource).toBe("github_repo");
    expect(arg.trigger.eventType).toBe("push");
    expect(arg.trigger.filter?.branches).toEqual(["main", "release/*"]);
    expect(arg.trigger.filter?.pathGlobs).toEqual(["src/**"]);
  });

  it("rejects an incomplete event trigger without calling the action", async () => {
    render(<TriggersPanel {...baseProps} triggers={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /add trigger/i }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "event" } });
    // No eventSource/eventType → schema rejects.
    fireEvent.click(screen.getByRole("button", { name: /save trigger/i }));

    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Invalid trigger" }),
      ),
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("deletes a trigger via deleteTriggerAction", async () => {
    mockDelete.mockResolvedValue({ ok: true, data: {} });
    render(<TriggersPanel {...baseProps} triggers={existing} />);
    fireEvent.click(screen.getByRole("button", { name: /delete trigger atr_1/i }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledOnce());
    expect((mockDelete.mock.calls[0]![0] as { triggerId: string }).triggerId).toBe("atr_1");
  });

  it("edits a trigger via updateTriggerAction", async () => {
    mockUpdate.mockResolvedValue({ ok: true, data: {} });
    render(<TriggersPanel {...baseProps} triggers={existing} />);
    fireEvent.click(screen.getByRole("button", { name: /edit trigger atr_1/i }));
    // Editor is seeded; save with the existing (valid) event trigger.
    fireEvent.click(screen.getByRole("button", { name: /save trigger/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledOnce());
    expect((mockUpdate.mock.calls[0]![0] as { triggerId: string }).triggerId).toBe("atr_1");
  });

  it("hides edit/add/delete affordances when canEdit is false but still shows the trigger list", () => {
    render(<TriggersPanel {...baseProps} canEdit={false} triggers={existing} />);
    // Mutation affordances hidden
    expect(screen.queryByRole("button", { name: /add trigger/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete trigger/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit trigger/i })).not.toBeInTheDocument();
    // Trigger list still renders in read-only mode
    expect(screen.getByText(/github_repo · push/i)).toBeInTheDocument();
  });
});
