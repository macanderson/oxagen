// @vitest-environment jsdom
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi } from "vitest";
import { MappingsStep } from "./mappings-step";
import type { MappingDraft } from "./wizard-types";

afterEach(cleanup);

const DRAFTS: MappingDraft[] = [
  {
    sourceRecordType: "custom",
    oxagenEntityType: "task",
    propertyMappings: { id: "externalId" },
    confidence: 0.82,
    reasoning: "Looks like a task record based on status/title fields.",
  },
];

describe("MappingsStep", () => {
  it("renders a loading indicator while suggestions are fetching", () => {
    render(
      <MappingsStep
        loading
        error={null}
        drafts={[]}
        onChangeDraft={vi.fn()}
        onRetry={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByTestId("mappings-loading")).toBeInTheDocument();
  });

  it("renders an error state with retry on failure", () => {
    const onRetry = vi.fn();
    render(
      <MappingsStep
        loading={false}
        error="LLM suggestion service unavailable"
        drafts={[]}
        onChangeDraft={vi.fn()}
        onRetry={onRetry}
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByText("LLM suggestion service unavailable"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("renders an empty state when there are no drafts", () => {
    render(
      <MappingsStep
        loading={false}
        error={null}
        drafts={[]}
        onChangeDraft={vi.fn()}
        onRetry={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("No mappings to review")).toBeInTheDocument();
  });

  it("renders editable mapping rows with confidence and reasoning", () => {
    render(
      <MappingsStep
        loading={false}
        error={null}
        drafts={DRAFTS}
        onChangeDraft={vi.fn()}
        onRetry={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByTestId("mapping-row-custom")).toBeInTheDocument();
    expect(screen.getByDisplayValue("task")).toBeInTheDocument();
    expect(screen.getByText("82% confidence")).toBeInTheDocument();
    expect(screen.getByText(/Looks like a task record/)).toBeInTheDocument();
  });

  it("calls onChangeDraft when the entity type is edited", async () => {
    const onChangeDraft = vi.fn();
    render(
      <MappingsStep
        loading={false}
        error={null}
        drafts={DRAFTS}
        onChangeDraft={onChangeDraft}
        onRetry={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Entity type");
    await userEvent.clear(input);
    await userEvent.type(input, "ticket");
    expect(onChangeDraft).toHaveBeenCalled();
    expect(onChangeDraft.mock.calls.at(-1)?.[0]).toBe(0);
  });

  it("disables Next when an entity type is blank", () => {
    render(
      <MappingsStep
        loading={false}
        error={null}
        drafts={[{ ...DRAFTS[0]!, oxagenEntityType: "" }]}
        onChangeDraft={vi.fn()}
        onRetry={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByTestId("mappings-next-btn")).toBeDisabled();
  });

  it("calls onNext and onBack", () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    render(
      <MappingsStep
        loading={false}
        error={null}
        drafts={DRAFTS}
        onChangeDraft={vi.fn()}
        onRetry={vi.fn()}
        onNext={onNext}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByTestId("mappings-next-btn"));
    expect(onNext).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
