// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ScheduleTriggerConfig } from "./automation-create-inline-schedule-config";

vi.mock("@/components/ui/input", () => ({
  Input: (
    props: React.InputHTMLAttributes<HTMLInputElement> & {
      "data-testid"?: string;
    },
  ) => <input {...props} />,
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

afterEach(cleanup);

const defaultProps = {
  cronExpression: "",
  onCronExpressionChange: vi.fn(),
  cronId: "cron-id",
  timezone: "",
  onTimezoneChange: vi.fn(),
  timezoneId: "timezone-id",
  disabled: false,
};

describe("ScheduleTriggerConfig", () => {
  it("renders 'Schedule configuration' header", () => {
    render(<ScheduleTriggerConfig {...defaultProps} />);
    expect(screen.getByText("Schedule configuration")).toBeInTheDocument();
  });

  it("renders cronExpression input with initial value", () => {
    render(
      <ScheduleTriggerConfig {...defaultProps} cronExpression="0 9 * * 1" />,
    );
    expect(screen.getByTestId("cron-expression-input")).toHaveValue(
      "0 9 * * 1",
    );
  });

  it("renders timezone input with initial value", () => {
    render(
      <ScheduleTriggerConfig {...defaultProps} timezone="America/New_York" />,
    );
    expect(screen.getByTestId("timezone-input")).toHaveValue(
      "America/New_York",
    );
  });

  it("calls onCronExpressionChange when cron input changes", () => {
    const onCronExpressionChange = vi.fn();
    render(
      <ScheduleTriggerConfig
        {...defaultProps}
        onCronExpressionChange={onCronExpressionChange}
      />,
    );
    fireEvent.change(screen.getByTestId("cron-expression-input"), {
      target: { value: "0 0 * * *" },
    });
    expect(onCronExpressionChange).toHaveBeenCalledWith("0 0 * * *");
  });

  it("calls onTimezoneChange when timezone input changes", () => {
    const onTimezoneChange = vi.fn();
    render(
      <ScheduleTriggerConfig
        {...defaultProps}
        onTimezoneChange={onTimezoneChange}
      />,
    );
    fireEvent.change(screen.getByTestId("timezone-input"), {
      target: { value: "Europe/London" },
    });
    expect(onTimezoneChange).toHaveBeenCalledWith("Europe/London");
  });

  it("shows hint text 'POSIX cron — min hr dom mon dow'", () => {
    render(<ScheduleTriggerConfig {...defaultProps} />);
    expect(
      screen.getByText("POSIX cron — min hr dom mon dow"),
    ).toBeInTheDocument();
  });

  it("disables both inputs when disabled=true", () => {
    render(<ScheduleTriggerConfig {...defaultProps} disabled={true} />);
    expect(screen.getByTestId("cron-expression-input")).toBeDisabled();
    expect(screen.getByTestId("timezone-input")).toBeDisabled();
  });
});
