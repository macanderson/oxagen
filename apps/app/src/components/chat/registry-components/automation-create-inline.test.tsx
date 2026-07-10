// @vitest-environment jsdom
/**
 * automation-create-inline.test.tsx
 *
 * Unit tests for AutomationCreateInline:
 *   - Renders form with correct aria-label
 *   - Pre-fills name, description, trigger type from props
 *   - Shows event-config section for 'event' trigger type
 *   - Shows schedule-config section for 'schedule' trigger type
 *   - Renders pre-filled property conditions
 *   - Editing a property-condition property/value updates state
 *   - Adding / removing a condition row
 *   - Adding / removing a step row
 *   - Submit button is disabled when name is empty
 *   - Submit calls createAutomationInlineAction and shows created state
 *   - Enable button calls enableAutomationInlineAction and shows enabled state
 *   - Shows error when createAutomationInlineAction fails
 *   - Shows error when enableAutomationInlineAction fails
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/app/actions/automation-inline.action", () => ({
  createAutomationInlineAction: vi.fn(),
  enableAutomationInlineAction: vi.fn(),
}));

vi.mock("@oxagen/oxagen/contracts/automation.create", () => ({}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    "aria-busy": ariaBusy,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: string;
    "aria-busy"?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-busy={ariaBusy}
      data-testid={testId}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
    className,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
    className?: string;
  }) => (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement> & { "data-testid"?: string }) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (
    props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { "data-testid"?: string },
  ) => <textarea {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    name?: string;
    items?: Array<{ value: string; label: string }>;
  }) => (
    <div data-value={value} data-disabled={disabled}>
      {/* Provide a native select so userEvent can interact with it */}
      <select
        value={value ?? ""}
        onChange={(e) => onValueChange?.(e.target.value)}
        disabled={disabled}
        aria-label="select-mock"
      >
        {children}
      </select>
    </div>
  ),
  SelectTrigger: ({
    children,
    id,
    "aria-label": ariaLabel,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    id?: string;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <span id={id} aria-label={ariaLabel} data-testid={testId}>
      {children}
    </span>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Zap: vi.fn(() => <span />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
    Plus: vi.fn(() => <span data-testid="icon-plus" />),
    Trash2: vi.fn(() => <span data-testid="icon-trash" />),
    Calendar: vi.fn(() => <span />),
    GitBranch: vi.fn(() => <span />),
    Webhook: vi.fn(() => <span />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AutomationCreateInline", () => {
  it("renders form with aria-label 'Create automation'", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(<AutomationCreateInline />);
    expect(screen.getByRole("form", { name: "Create automation" })).toBeInTheDocument();
  });

  it("pre-fills name from suggestedName prop", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(<AutomationCreateInline suggestedName="Notify on commit" />);
    const nameInput = screen.getByTestId("automation-name-input") as HTMLInputElement;
    expect(nameInput.value).toBe("Notify on commit");
  });

  it("submit button is disabled when name is empty", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(<AutomationCreateInline />);
    expect(screen.getByTestId("create-automation-submit")).toBeDisabled();
  });

  it("shows event-config section when triggerType is 'event'", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        triggerType="event"
        entityType="Commit"
      />,
    );
    expect(screen.getByTestId("entity-type-input")).toBeInTheDocument();
    const entityInput = screen.getByTestId("entity-type-input") as HTMLInputElement;
    expect(entityInput.value).toBe("Commit");
  });

  it("shows schedule-config section when triggerType is 'schedule'", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        triggerType="schedule"
        cronExpression="0 9 * * 1"
        timezone="America/New_York"
      />,
    );
    const cronInput = screen.getByTestId("cron-expression-input") as HTMLInputElement;
    expect(cronInput.value).toBe("0 9 * * 1");
    const tzInput = screen.getByTestId("timezone-input") as HTMLInputElement;
    expect(tzInput.value).toBe("America/New_York");
  });

  it("renders pre-filled property conditions", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        triggerType="event"
        propertyConditions={[
          { property: "git_branch", operator: "eq", toValue: "main" },
        ]}
      />,
    );
    const propInput = screen.getByTestId("condition-property-0") as HTMLInputElement;
    expect(propInput.value).toBe("git_branch");
    const valInput = screen.getByTestId("condition-value-0") as HTMLInputElement;
    expect(valInput.value).toBe("main");
  });

  it("editing a condition property input updates state", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        triggerType="event"
        propertyConditions={[{ property: "status", operator: "eq", toValue: "open" }]}
      />,
    );
    const propInput = screen.getByTestId("condition-property-0") as HTMLInputElement;
    await userEvent.clear(propInput);
    await userEvent.type(propInput, "priority");
    expect(propInput.value).toBe("priority");
  });

  it("adds a new condition row when Add condition is clicked", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(<AutomationCreateInline triggerType="event" />);
    const addBtn = screen.getByTestId("add-condition-btn");
    await userEvent.click(addBtn);
    expect(screen.getByTestId("condition-property-0")).toBeInTheDocument();
  });

  it("removes a condition row when remove button is clicked", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        triggerType="event"
        propertyConditions={[{ property: "status", operator: "eq", toValue: "open" }]}
      />,
    );
    expect(screen.getByTestId("condition-property-0")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("condition-remove-0"));
    expect(screen.queryByTestId("condition-property-0")).not.toBeInTheDocument();
  });

  it("adds a new step row when Add step is clicked", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(<AutomationCreateInline suggestedName="My Automation" />);
    const addStepBtn = screen.getByTestId("add-step-btn");
    await userEvent.click(addStepBtn);
    expect(screen.getByTestId("step-row-0")).toBeInTheDocument();
  });

  it("removes a step row when remove button is clicked", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        suggestedName="My Automation"
        steps={[{ name: "Run agent", stepType: "agent", config: {} }]}
      />,
    );
    expect(screen.getByTestId("step-row-0")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("step-remove-0"));
    expect(screen.queryByTestId("step-row-0")).not.toBeInTheDocument();
  });

  it("submit calls createAutomationInlineAction and shows created/disabled state", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: true,
      automation: {
        automation_id: "aut_123",
        playbook_id: "pb_456",
        name: "Test Automation",
        status: "paused",
        triggerType: "event",
        enabled: false,
      },
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        suggestedName="Test Automation"
        orgSlug="my-org"
        workspaceSlug="default"
      />,
    );

    await userEvent.click(screen.getByTestId("create-automation-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("automation-created-state")).toBeInTheDocument();
    });
    expect(screen.getByText("Created — disabled")).toBeInTheDocument();
    expect(screen.getByTestId("enable-automation-btn")).toBeInTheDocument();
    expect(screen.getByTestId("leave-disabled-btn")).toBeInTheDocument();
    expect(createAutomationInlineAction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Test Automation",
        orgSlug: "my-org",
        workspaceSlug: "default",
      }),
    );
  });

  it("shows error when createAutomationInlineAction fails", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "Permission denied",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        suggestedName="Bad Automation"
        orgSlug="my-org"
        workspaceSlug="default"
      />,
    );

    await userEvent.click(screen.getByTestId("create-automation-submit"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
    });
  });

  it("enable button calls enableAutomationInlineAction and shows enabled state", async () => {
    const { createAutomationInlineAction, enableAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: true,
      automation: {
        automation_id: "aut_789",
        playbook_id: "pb_012",
        name: "Enable Me",
        status: "paused",
        triggerType: "event",
        enabled: false,
      },
    });
    vi.mocked(enableAutomationInlineAction).mockResolvedValue({
      ok: true,
      result: {
        automation_id: "aut_789",
        enabled: true,
        status: "active",
      },
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        suggestedName="Enable Me"
        orgSlug="my-org"
        workspaceSlug="default"
      />,
    );

    // Create first
    await userEvent.click(screen.getByTestId("create-automation-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("enable-automation-btn")).toBeInTheDocument();
    });

    // Then enable
    await userEvent.click(screen.getByTestId("enable-automation-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("automation-enabled-state")).toBeInTheDocument();
    });
    expect(screen.getByText("Automation enabled")).toBeInTheDocument();
    expect(enableAutomationInlineAction).toHaveBeenCalledWith(
      expect.objectContaining({
        automation_id: "aut_789",
        orgSlug: "my-org",
        workspaceSlug: "default",
      }),
    );
  });

  it("shows error when enableAutomationInlineAction fails", async () => {
    const { createAutomationInlineAction, enableAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: true,
      automation: {
        automation_id: "aut_fail",
        playbook_id: "pb_fail",
        name: "Fail Enable",
        status: "paused",
        triggerType: "event",
        enabled: false,
      },
    });
    vi.mocked(enableAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "Enable failed — access denied",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        suggestedName="Fail Enable"
        orgSlug="my-org"
        workspaceSlug="default"
      />,
    );

    await userEvent.click(screen.getByTestId("create-automation-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("enable-automation-btn")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("enable-automation-btn"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Enable failed — access denied",
      );
    });
    // Should stay in created state (not enabled)
    expect(screen.getByTestId("automation-created-state")).toBeInTheDocument();
  });

  it("pre-fills steps from steps prop", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: false,
      error: "noop",
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        suggestedName="With Steps"
        steps={[
          { name: "Run QA", stepType: "agent", config: { agentSlug: "qa-chat" } },
        ]}
      />,
    );

    expect(screen.getByTestId("step-row-0")).toBeInTheDocument();
    const stepName = screen.getByTestId("step-name-0") as HTMLInputElement;
    expect(stepName.value).toBe("Run QA");
    const agentSlug = screen.getByTestId("step-agent-slug-0") as HTMLInputElement;
    expect(agentSlug.value).toBe("qa-chat");
  });

  it("shows leave-disabled affordance in created state", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: true,
      automation: {
        automation_id: "aut_leave",
        playbook_id: "pb_leave",
        name: "Leave Disabled",
        status: "paused",
        triggerType: "api",
        enabled: false,
      },
    });

    const { default: AutomationCreateInline } = await import(
      "./automation-create-inline"
    );
    render(
      <AutomationCreateInline
        suggestedName="Leave Disabled"
        orgSlug="my-org"
        workspaceSlug="default"
      />,
    );

    await userEvent.click(screen.getByTestId("create-automation-submit"));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Leave automation disabled" }),
      ).toBeInTheDocument();
    });
  });
});

// ── within import ─────────────────────────────────────────────────────────────
// Suppress unused import warning — `within` may be needed by extended tests.
void within;
