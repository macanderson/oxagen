// @vitest-environment jsdom
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { PreviewStep } from "./preview-step";
import type { PreviewRecordType } from "./wizard-types";

afterEach(cleanup);

const RECORD_TYPES: PreviewRecordType[] = [
  {
    sourceRecordType: "custom",
    displayName: "Custom Records",
    description: "Rows returned by the configured query.",
    sampleCount: 2,
    sampleFields: ["id", "name"],
    sampleRecords: [
      { id: "1", name: "Widget" },
      { id: "2", name: "Gadget" },
    ],
  },
];

describe("PreviewStep", () => {
  it("renders a loading indicator while fetching", () => {
    render(
      <PreviewStep
        loading
        error={null}
        recordTypes={[]}
        onRetry={vi.fn()}
        onNext={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("preview-loading")).toBeInTheDocument();
  });

  it("renders the raw connector error with a retry action on failure", () => {
    const onRetry = vi.fn();
    render(
      <PreviewStep
        loading={false}
        error="ECONNREFUSED: connection refused at 10.0.0.1:5432"
        recordTypes={[]}
        onRetry={onRetry}
        onNext={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText("ECONNREFUSED: connection refused at 10.0.0.1:5432"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("renders an empty state when there are no record types", () => {
    render(
      <PreviewStep
        loading={false}
        error={null}
        recordTypes={[]}
        onRetry={vi.fn()}
        onNext={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("No records found")).toBeInTheDocument();
  });

  it("renders sample records and calls onNext/onCancel", () => {
    const onNext = vi.fn();
    const onCancel = vi.fn();
    render(
      <PreviewStep
        loading={false}
        error={null}
        recordTypes={RECORD_TYPES}
        onRetry={vi.fn()}
        onNext={onNext}
        onCancel={onCancel}
      />,
    );
    expect(
      screen.getByTestId("preview-record-type-custom"),
    ).toBeInTheDocument();
    expect(screen.getByText("Widget")).toBeInTheDocument();
    expect(screen.getByText("Gadget")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("preview-next-btn"));
    expect(onNext).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
