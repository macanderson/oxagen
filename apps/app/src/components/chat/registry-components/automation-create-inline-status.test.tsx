// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CreatedState, EnabledState } from "./automation-create-inline-status";

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

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", () => ({
  CheckCircle2: () => <span data-testid="icon-check" />,
}));

afterEach(cleanup);

// Full shape matching AutomationCreateOutput (all required fields)
type MinimalAutomationOutput = {
  automation_id: string;
  playbook_id: string;
  name: string;
  status: string;
  triggerType: string;
  enabled: boolean;
};

function makeAutomation(
  overrides: Partial<MinimalAutomationOutput> = {},
): MinimalAutomationOutput {
  return {
    automation_id: "auto-123",
    playbook_id: "pb-123",
    name: "Test Automation",
    status: "created",
    triggerType: "event",
    enabled: false,
    ...overrides,
  };
}

describe("CreatedState", () => {
  const baseProps = {
    createdAutomation: null as MinimalAutomationOutput | null,
    fallbackName: "My Automation",
    enableError: null as string | null,
    isEnabling: false,
    onEnable: vi.fn(),
  };

  it("renders 'Created — disabled' heading", () => {
    render(<CreatedState {...baseProps} />);
    expect(screen.getByText("Created — disabled")).toBeInTheDocument();
  });

  it("shows automation name from createdAutomation.name", () => {
    render(
      <CreatedState
        {...baseProps}
        createdAutomation={makeAutomation({
          automation_id: "auto-123",
          name: "Notify on merge",
        })}
      />,
    );
    expect(screen.getByText(/Notify on merge/)).toBeInTheDocument();
  });

  it("shows automation_id when present", () => {
    render(
      <CreatedState
        {...baseProps}
        createdAutomation={makeAutomation({
          automation_id: "auto-abc",
          name: "Notify",
        })}
      />,
    );
    expect(screen.getByText(/auto-abc/)).toBeInTheDocument();
  });

  it("shows fallbackName when createdAutomation is null", () => {
    render(<CreatedState {...baseProps} createdAutomation={null} />);
    expect(screen.getByText("My Automation")).toBeInTheDocument();
  });

  it("shows a muted 'Disabled' status", () => {
    render(<CreatedState {...baseProps} />);
    const status = screen.getByText("Disabled");
    expect(status).toBeInTheDocument();
    expect(status.className).toContain("text-muted-foreground");
  });

  it("calls onEnable when enable button is clicked", () => {
    const onEnable = vi.fn();
    render(<CreatedState {...baseProps} onEnable={onEnable} />);
    fireEvent.click(screen.getByTestId("enable-automation-btn"));
    expect(onEnable).toHaveBeenCalledOnce();
  });

  it("shows enableError when present", () => {
    render(
      <CreatedState
        {...baseProps}
        enableError="Something went wrong enabling the automation"
      />,
    );
    expect(
      screen.getByText("Something went wrong enabling the automation"),
    ).toBeInTheDocument();
  });

  it("shows 'Enabling…' text on the button when isEnabling=true", () => {
    render(<CreatedState {...baseProps} isEnabling={true} />);
    expect(screen.getByTestId("enable-automation-btn")).toHaveTextContent(
      "Enabling…",
    );
  });

  it("disables enable button when isEnabling=true", () => {
    render(<CreatedState {...baseProps} isEnabling={true} />);
    expect(screen.getByTestId("enable-automation-btn")).toBeDisabled();
  });

  it("renders 'Leave disabled' button with correct aria-label", () => {
    render(<CreatedState {...baseProps} />);
    const leaveBtn = screen.getByTestId("leave-disabled-btn");
    expect(leaveBtn).toBeInTheDocument();
    expect(leaveBtn).toHaveAttribute("aria-label", "Leave automation disabled");
  });
});

describe("EnabledState", () => {
  const baseProps = {
    createdAutomation: null as MinimalAutomationOutput | null,
    fallbackName: "Fallback Automation",
  };

  it("renders 'Automation enabled' heading", () => {
    render(<EnabledState {...baseProps} />);
    expect(screen.getByText("Automation enabled")).toBeInTheDocument();
  });

  it("shows a success-toned 'Active' status", () => {
    render(<EnabledState {...baseProps} />);
    const status = screen.getByText("Active");
    expect(status).toBeInTheDocument();
    expect(status.className).toContain("text-success");
  });

  it("shows automation name when createdAutomation has name", () => {
    render(
      <EnabledState
        {...baseProps}
        createdAutomation={makeAutomation({
          automation_id: "auto-xyz",
          name: "Deploy notifier",
        })}
      />,
    );
    expect(screen.getByText(/Deploy notifier is now live/)).toBeInTheDocument();
  });

  it("shows fallbackName when createdAutomation is null", () => {
    render(<EnabledState {...baseProps} createdAutomation={null} />);
    expect(
      screen.getByText(/Fallback Automation is now live/),
    ).toBeInTheDocument();
  });

  it("shows '{name} is now live' text", () => {
    render(
      <EnabledState
        {...baseProps}
        createdAutomation={makeAutomation({
          automation_id: "auto-1",
          name: "My Bot",
        })}
      />,
    );
    expect(screen.getByText("My Bot is now live")).toBeInTheDocument();
  });
});
