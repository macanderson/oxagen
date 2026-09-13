// @vitest-environment jsdom
import { render, cleanup, screen } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { WizardProgress } from "./wizard-progress";

afterEach(cleanup);

describe("WizardProgress", () => {
  it("renders 5 step dots and highlights the current step", () => {
    render(<WizardProgress currentStep="preview" />);
    expect(screen.getByTestId("wizard-progress-dot-pick")).toBeInTheDocument();
    expect(
      screen.getByTestId("wizard-progress-dot-credentials"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("wizard-progress-dot-preview"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("wizard-progress-dot-mappings"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("wizard-progress-dot-confirm"),
    ).toBeInTheDocument();
    expect(screen.getByText("Step 3 of 5")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("shows step 1 of 5 for the pick step", () => {
    render(<WizardProgress currentStep="pick" />);
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
    expect(screen.getByText("Connector")).toBeInTheDocument();
  });

  it("shows step 5 of 5 for the confirm step", () => {
    render(<WizardProgress currentStep="confirm" />);
    expect(screen.getByText("Step 5 of 5")).toBeInTheDocument();
    expect(screen.getByText("Confirm")).toBeInTheDocument();
  });
});
