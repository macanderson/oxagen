// @vitest-environment jsdom
/**
 * playbook-steps.test.tsx — unit tests for the read-only playbook steps view.
 * Pure presentational component (no client hooks, no mocks needed).
 *
 * Covers:
 *   - Empty state when there are no steps.
 *   - Renders each step's ordinal, name, and a humanized step-type badge.
 *   - Falls back to the raw stepType string for an unrecognized type.
 *   - Always shows the "Read-only" badge and the read-only explanation.
 */
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { PlaybookSteps } from "./playbook-steps";
import type { AutomationGetOutput } from "@oxagen/oxagen/contracts/automation.get";

type Step = AutomationGetOutput["steps"][number];

function step(overrides: Partial<Step> = {}): Step {
  return {
    stepKey: "s1",
    name: "Run agent",
    stepType: "agent",
    config: {},
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("PlaybookSteps", () => {
  it("shows the empty-state copy when there are no steps", () => {
    render(<PlaybookSteps steps={[]} />);
    expect(
      screen.getByText("This automation has no steps configured yet."),
    ).toBeTruthy();
  });

  it("always shows the Read-only badge and explanation", () => {
    render(<PlaybookSteps steps={[]} />);
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByText(/needs a step-editing/i)).toBeTruthy();
  });

  it("renders each step's ordinal, name, and humanized step-type badge", () => {
    render(
      <PlaybookSteps
        steps={[
          step({ stepKey: "s1", name: "Notify Slack", stepType: "webhook" }),
          step({ stepKey: "s2", name: "Summarize deal", stepType: "prompt" }),
        ]}
      />,
    );
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Notify Slack")).toBeTruthy();
    expect(screen.getByText("Webhook")).toBeTruthy();
    expect(screen.getByText("Summarize deal")).toBeTruthy();
    expect(screen.getByText("Prompt")).toBeTruthy();
  });

  it("falls back to the raw stepType string for an unrecognized type", () => {
    render(<PlaybookSteps steps={[step({ stepType: "mystery_step" })]} />);
    expect(screen.getByText("mystery_step")).toBeTruthy();
  });

  it("keys steps by index when stepKey is falsy (does not crash)", () => {
    render(<PlaybookSteps steps={[step({ stepKey: "", name: "First" })]} />);
    expect(screen.getByText("First")).toBeTruthy();
  });
});
