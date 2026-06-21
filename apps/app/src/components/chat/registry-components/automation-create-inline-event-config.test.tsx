// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { EventTriggerConfig } from "./automation-create-inline-event-config";
import type { PropertyCondition } from "./automation-create-inline-types";

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement> & { "data-testid"?: string }) => (
    <input {...props} />
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
    id?: string;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
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
  entityType: "",
  onEntityTypeChange: vi.fn(),
  entityTypeId: "entity-type-id",
  eventType: "" as const,
  onEventTypeChange: vi.fn(),
  eventTypeId: "event-type-id",
  conditions: [] as PropertyCondition[],
  onAddCondition: vi.fn(),
  onRemoveCondition: vi.fn(),
  onUpdateCondition: vi.fn(),
  disabled: false,
};

describe("EventTriggerConfig", () => {
  it("renders 'Event configuration' section header", () => {
    render(<EventTriggerConfig {...defaultProps} />);
    expect(screen.getByText("Event configuration")).toBeInTheDocument();
  });

  it("renders entityType input with correct initial value", () => {
    render(<EventTriggerConfig {...defaultProps} entityType="Commit" />);
    const input = screen.getByTestId("entity-type-input");
    expect(input).toHaveValue("Commit");
  });

  it("renders condition rows from the conditions prop", () => {
    const conditions: PropertyCondition[] = [
      { property: "status", operator: "eq", toValue: "open" },
    ];
    render(<EventTriggerConfig {...defaultProps} conditions={conditions} />);
    expect(screen.getByTestId("condition-row-0")).toBeInTheDocument();
  });

  it("calls onEntityTypeChange when input changes", () => {
    const onEntityTypeChange = vi.fn();
    render(
      <EventTriggerConfig
        {...defaultProps}
        onEntityTypeChange={onEntityTypeChange}
      />
    );
    const input = screen.getByTestId("entity-type-input");
    fireEvent.change(input, { target: { value: "Issue" } });
    expect(onEntityTypeChange).toHaveBeenCalledWith("Issue");
  });

  it("calls onAddCondition when add condition button is clicked", () => {
    const onAddCondition = vi.fn();
    render(
      <EventTriggerConfig {...defaultProps} onAddCondition={onAddCondition} />
    );
    fireEvent.click(screen.getByTestId("add-condition-btn"));
    expect(onAddCondition).toHaveBeenCalledOnce();
  });

  it("calls onRemoveCondition with correct index when remove button is clicked", () => {
    const onRemoveCondition = vi.fn();
    const conditions: PropertyCondition[] = [
      { property: "a", operator: "eq", toValue: "1" },
      { property: "b", operator: "gt", toValue: "2" },
    ];
    render(
      <EventTriggerConfig
        {...defaultProps}
        conditions={conditions}
        onRemoveCondition={onRemoveCondition}
      />
    );
    fireEvent.click(screen.getByTestId("condition-remove-1"));
    expect(onRemoveCondition).toHaveBeenCalledWith(1);
  });

  it("calls onUpdateCondition when condition property input changes", () => {
    const onUpdateCondition = vi.fn();
    const conditions: PropertyCondition[] = [
      { property: "", operator: "eq", toValue: "" },
    ];
    render(
      <EventTriggerConfig
        {...defaultProps}
        conditions={conditions}
        onUpdateCondition={onUpdateCondition}
      />
    );
    fireEvent.change(screen.getByTestId("condition-property-0"), {
      target: { value: "status" },
    });
    expect(onUpdateCondition).toHaveBeenCalledWith(0, { property: "status" });
  });

  it("renders no condition rows when conditions is empty", () => {
    render(<EventTriggerConfig {...defaultProps} conditions={[]} />);
    expect(screen.queryByTestId("condition-row-0")).not.toBeInTheDocument();
  });

  it("renders all condition rows when multiple conditions are provided", () => {
    const conditions: PropertyCondition[] = [
      { property: "a", operator: "eq", toValue: "1" },
      { property: "b", operator: "gt", toValue: "2" },
      { property: "c", operator: "lt", toValue: "3" },
    ];
    render(<EventTriggerConfig {...defaultProps} conditions={conditions} />);
    expect(screen.getByTestId("condition-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("condition-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("condition-row-2")).toBeInTheDocument();
  });

  it("disables all interactive elements when disabled=true", () => {
    const conditions: PropertyCondition[] = [
      { property: "x", operator: "eq", toValue: "y" },
    ];
    render(
      <EventTriggerConfig
        {...defaultProps}
        conditions={conditions}
        disabled={true}
      />
    );
    expect(screen.getByTestId("entity-type-input")).toBeDisabled();
    expect(screen.getByTestId("add-condition-btn")).toBeDisabled();
    expect(screen.getByTestId("condition-remove-0")).toBeDisabled();
    expect(screen.getByTestId("condition-property-0")).toBeDisabled();
    expect(screen.getByTestId("condition-value-0")).toBeDisabled();
  });
});
