// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { StepsEditor } from "./automation-create-inline-steps";
import type { AutomationStep } from "./automation-create-inline-types";

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
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    items?: unknown[];
  }) => (
    <select
      value={value ?? ""}
      onChange={(e) => onValueChange?.(e.target.value)}
      disabled={disabled}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => <>{children}</>,
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

vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus" />,
  Trash2: () => <span data-testid="icon-trash" />,
}));

afterEach(cleanup);

const defaultProps = {
  steps: [] as AutomationStep[],
  onAddStep: vi.fn(),
  onRemoveStep: vi.fn(),
  onUpdateStep: vi.fn(),
  onUpdateStepConfig: vi.fn(),
  disabled: false,
};

describe("StepsEditor", () => {
  it("renders 'Steps' heading", () => {
    render(<StepsEditor {...defaultProps} />);
    expect(screen.getByText("Steps")).toBeInTheDocument();
  });

  it("shows 'No steps yet' message when steps array is empty", () => {
    render(<StepsEditor {...defaultProps} steps={[]} />);
    expect(screen.getByText(/No steps yet/)).toBeInTheDocument();
  });

  it("renders the correct number of step rows", () => {
    const steps: AutomationStep[] = [
      { name: "Step A", stepType: "agent", config: {} },
      { name: "Step B", stepType: "tool", config: {} },
    ];
    render(<StepsEditor {...defaultProps} steps={steps} />);
    expect(screen.getByTestId("step-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("step-row-1")).toBeInTheDocument();
    expect(screen.queryByTestId("step-row-2")).not.toBeInTheDocument();
  });

  it("calls onAddStep when add step button is clicked", () => {
    const onAddStep = vi.fn();
    render(<StepsEditor {...defaultProps} onAddStep={onAddStep} />);
    fireEvent.click(screen.getByTestId("add-step-btn"));
    expect(onAddStep).toHaveBeenCalledOnce();
  });

  it("calls onRemoveStep with correct index when remove button is clicked", () => {
    const onRemoveStep = vi.fn();
    const steps: AutomationStep[] = [
      { name: "A", stepType: "agent", config: {} },
      { name: "B", stepType: "tool", config: {} },
    ];
    render(
      <StepsEditor
        {...defaultProps}
        steps={steps}
        onRemoveStep={onRemoveStep}
      />,
    );
    fireEvent.click(screen.getByTestId("step-remove-1"));
    expect(onRemoveStep).toHaveBeenCalledWith(1);
  });

  it("shows agent-slug input for agent step type", () => {
    const steps: AutomationStep[] = [
      { name: "My agent", stepType: "agent", config: {} },
    ];
    render(<StepsEditor {...defaultProps} steps={steps} />);
    expect(screen.getByTestId("step-agent-slug-0")).toBeInTheDocument();
    expect(screen.queryByTestId("step-config-0")).not.toBeInTheDocument();
  });

  it("shows JSON config textarea for non-agent step types", () => {
    const steps: AutomationStep[] = [
      { name: "My webhook", stepType: "webhook", config: {} },
    ];
    render(<StepsEditor {...defaultProps} steps={steps} />);
    expect(screen.getByTestId("step-config-0")).toBeInTheDocument();
    expect(screen.queryByTestId("step-agent-slug-0")).not.toBeInTheDocument();
  });

  it("calls onUpdateStep when step name input changes", () => {
    const onUpdateStep = vi.fn();
    const steps: AutomationStep[] = [
      { name: "", stepType: "agent", config: {} },
    ];
    render(
      <StepsEditor
        {...defaultProps}
        steps={steps}
        onUpdateStep={onUpdateStep}
      />,
    );
    fireEvent.change(screen.getByTestId("step-name-0"), {
      target: { value: "Send notification" },
    });
    expect(onUpdateStep).toHaveBeenCalledWith(0, { name: "Send notification" });
  });

  it("disables add and remove buttons when disabled=true", () => {
    const steps: AutomationStep[] = [
      { name: "X", stepType: "agent", config: {} },
    ];
    render(<StepsEditor {...defaultProps} steps={steps} disabled={true} />);
    expect(screen.getByTestId("add-step-btn")).toBeDisabled();
    expect(screen.getByTestId("step-remove-0")).toBeDisabled();
    expect(screen.getByTestId("step-name-0")).toBeDisabled();
    expect(screen.getByTestId("step-agent-slug-0")).toBeDisabled();
  });

  it("renders multiple step types coexisting correctly", () => {
    const steps: AutomationStep[] = [
      { name: "Agent step", stepType: "agent", config: {} },
      { name: "Tool step", stepType: "tool", config: {} },
      { name: "Webhook step", stepType: "webhook", config: {} },
    ];
    render(<StepsEditor {...defaultProps} steps={steps} />);
    // Agent step has agent-slug input
    expect(screen.getByTestId("step-agent-slug-0")).toBeInTheDocument();
    // Tool and webhook steps have JSON config textarea
    expect(screen.getByTestId("step-config-1")).toBeInTheDocument();
    expect(screen.getByTestId("step-config-2")).toBeInTheDocument();
    // All 3 rows present
    expect(screen.getByTestId("step-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("step-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("step-row-2")).toBeInTheDocument();
  });
});
