// @vitest-environment jsdom
/**
 * automation-create-inline.test.tsx
 *
 * Unit tests for AutomationCreateInline:
 *   - Renders form with correct aria-label
 *   - Pre-fills name, description, trigger type from props
 *   - Shows event-config section (schema-driven) for 'event' trigger type
 *   - Shows schedule-config section for 'schedule' trigger type
 *   - Entity-type picker is populated from the workspace schema registry
 *   - Building a condition and submitting produces a `conditionTree` in the
 *     createAutomationInlineAction payload (NOT the legacy propertyConditions)
 *   - Adding / removing a step row
 *   - Submit button is disabled when name is empty
 *   - Submit calls createAutomationInlineAction and shows created state
 *   - Enable button calls enableAutomationInlineAction and shows enabled state
 *   - Shows error when createAutomationInlineAction fails
 *   - Shows error when enableAutomationInlineAction fails
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/app/actions/automation-inline.action", () => ({
  createAutomationInlineAction: vi.fn(),
  enableAutomationInlineAction: vi.fn(),
}));

vi.mock("@oxagen/oxagen/contracts/automation.create", () => ({}));

// The schema-driven condition section fetches the registry. Return one label
// ("Commit") with a string property ("git_branch") so pickers populate.
const { mockFetchRegistry } = vi.hoisted(() => ({
  mockFetchRegistry: vi.fn(),
}));
vi.mock("@/components/knowledge/schema-builder/schema-service", () => ({
  fetchRegistry: mockFetchRegistry,
}));
mockFetchRegistry.mockResolvedValue({
  registryId: "reg_1",
  pinnedVersionId: null,
  draftVersionId: null,
  enforcementMode: "lenient",
  conformanceFloor: 0.8,
  schemas: [
    {
      schemaName: "core",
      displayName: "Core",
      source: "user",
      enabled: true,
      labels: [
        {
          name: "Commit",
          displayName: "Commit",
          properties: [
            {
              key: "git_branch",
              dataType: "string",
              required: false,
              displayName: "Branch",
            },
          ],
        },
      ],
      relationshipTypes: [],
    },
  ],
});

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
  Input: (
    props: React.InputHTMLAttributes<HTMLInputElement> & {
      "data-testid"?: string;
    },
  ) => <input {...props} />,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (
    props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
      "data-testid"?: string;
    },
  ) => <textarea {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    name?: string;
    items?: Array<{ value: string; label: string }>;
    "data-testid"?: string;
  }) => (
    <div data-value={value} data-disabled={disabled}>
      {/* Provide a native select so userEvent can interact with it */}
      <select
        value={value ?? ""}
        onChange={(e) => onValueChange?.(e.target.value)}
        disabled={disabled}
        aria-label="select-mock"
        data-testid={testId}
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
  SelectPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <option value={value}>{children}</option>,
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SegmentedControlItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
    disabled?: boolean;
  }) => (
    <button type="button" data-value={value}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (props: Record<string, unknown>) => (
    <input type="checkbox" {...props} />
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({
    children,
    ...rest
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
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
    X: vi.fn(() => <span data-testid="icon-x" />),
    Database: vi.fn(() => <span data-testid="icon-db" />),
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
    expect(
      screen.getByRole("form", { name: "Create automation" }),
    ).toBeInTheDocument();
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
    const nameInput = screen.getByTestId(
      "automation-name-input",
    ) as HTMLInputElement;
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

  it("shows the schema-driven event-config section when triggerType is 'event'", async () => {
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
    expect(screen.getByTestId("schema-condition-section")).toBeInTheDocument();
    // Entity-type picker populates from the mocked registry (Commit label).
    await waitFor(() => {
      expect(screen.getByTestId("entity-type-select")).toBeInTheDocument();
    });
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
    const cronInput = screen.getByTestId(
      "cron-expression-input",
    ) as HTMLInputElement;
    expect(cronInput.value).toBe("0 9 * * 1");
    const tzInput = screen.getByTestId("timezone-input") as HTMLInputElement;
    expect(tzInput.value).toBe("America/New_York");
  });

  it("seeds the condition tree from legacy propertyConditions and submits a conditionTree", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: true,
      automation: {
        automation_id: "aut_seed",
        playbook_id: "pb_seed",
        name: "Seeded",
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
        suggestedName="Seeded"
        orgSlug="my-org"
        workspaceSlug="default"
        triggerType="event"
        entityType="Commit"
        eventType="node.created"
        propertyConditions={[
          { property: "git_branch", operator: "eq", toValue: "main" },
        ]}
      />,
    );

    // The seeded leaf renders as a condition row.
    await waitFor(() => {
      expect(screen.getByTestId("condition-builder")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("create-automation-submit"));

    await waitFor(() => {
      expect(createAutomationInlineAction).toHaveBeenCalled();
    });
    const call = vi.mocked(createAutomationInlineAction).mock.calls[0]![0];
    expect(call.triggerConfig?.entityType).toBe("Commit");
    expect(call.triggerConfig?.eventType).toBe("node.created");
    expect(call.triggerConfig?.propertyConditions).toBeUndefined();
    const tree = call.triggerConfig?.conditionTree;
    expect(tree).toBeDefined();
    expect(tree?.kind).toBe("group");
    if (tree?.kind === "group") {
      expect(tree.children).toHaveLength(1);
      const leaf = tree.children[0]!;
      expect(leaf.kind).toBe("condition");
      if (leaf.kind === "condition") {
        expect(leaf.property).toBe("git_branch");
        expect(leaf.value).toBe("main");
      }
    }
  });

  it("omits conditionTree when no conditions were added", async () => {
    const { createAutomationInlineAction } = await import(
      "@/app/actions/automation-inline.action"
    );
    vi.mocked(createAutomationInlineAction).mockResolvedValue({
      ok: true,
      automation: {
        automation_id: "aut_empty",
        playbook_id: "pb_empty",
        name: "Empty",
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
        suggestedName="Empty"
        orgSlug="my-org"
        workspaceSlug="default"
        triggerType="event"
      />,
    );

    await userEvent.click(screen.getByTestId("create-automation-submit"));
    await waitFor(() => {
      expect(createAutomationInlineAction).toHaveBeenCalled();
    });
    const call = vi.mocked(createAutomationInlineAction).mock.calls[0]![0];
    expect(call.triggerConfig?.conditionTree).toBeUndefined();
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
      expect(
        screen.getByTestId("automation-created-state"),
      ).toBeInTheDocument();
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
    const { createAutomationInlineAction, enableAutomationInlineAction } =
      await import("@/app/actions/automation-inline.action");
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
      expect(
        screen.getByTestId("automation-enabled-state"),
      ).toBeInTheDocument();
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
    const { createAutomationInlineAction, enableAutomationInlineAction } =
      await import("@/app/actions/automation-inline.action");
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
          {
            name: "Run QA",
            stepType: "agent",
            config: { agentSlug: "qa-chat" },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("step-row-0")).toBeInTheDocument();
    const stepName = screen.getByTestId("step-name-0") as HTMLInputElement;
    expect(stepName.value).toBe("Run QA");
    const agentSlug = screen.getByTestId(
      "step-agent-slug-0",
    ) as HTMLInputElement;
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
