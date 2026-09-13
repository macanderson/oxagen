// @vitest-environment jsdom
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { ConfirmStep } from "./confirm-step";
import type { MappingDraft } from "./wizard-types";

afterEach(cleanup);

const MAPPINGS: MappingDraft[] = [
  {
    sourceRecordType: "custom",
    oxagenEntityType: "task",
    propertyMappings: {},
  },
];

describe("ConfirmStep", () => {
  it("renders a mapping summary and the connection/connector names", () => {
    render(
      <ConfirmStep
        connectorDisplayName="Custom SQL"
        connectionDisplayName="My Database"
        mappings={MAPPINGS}
        submitting={false}
        error={null}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("My Database")).toBeInTheDocument();
    expect(screen.getByText("Custom SQL")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-mapping-summary")).toHaveTextContent(
      "custom",
    );
    expect(screen.getByTestId("confirm-mapping-summary")).toHaveTextContent(
      "task",
    );
  });

  it("calls onConfirm when the activate button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmStep
        connectorDisplayName="Custom SQL"
        connectionDisplayName="My Database"
        mappings={MAPPINGS}
        submitting={false}
        error={null}
        onConfirm={onConfirm}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-activate-btn"));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("shows the error banner and disables actions while submitting", () => {
    render(
      <ConfirmStep
        connectorDisplayName="Custom SQL"
        connectionDisplayName="My Database"
        mappings={MAPPINGS}
        submitting
        error="Failed to save and activate this connection."
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Failed to save and activate this connection."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("confirm-activate-btn")).toBeDisabled();
    expect(screen.getByRole("button", { name: /back/i })).toBeDisabled();
  });

  it("calls onBack", () => {
    const onBack = vi.fn();
    render(
      <ConfirmStep
        connectorDisplayName="Custom SQL"
        connectionDisplayName="My Database"
        mappings={MAPPINGS}
        submitting={false}
        error={null}
        onConfirm={vi.fn()}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
