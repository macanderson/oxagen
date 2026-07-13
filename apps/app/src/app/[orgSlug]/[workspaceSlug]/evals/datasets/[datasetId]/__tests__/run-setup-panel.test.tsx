// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * run-setup-panel.test.tsx — component tests for the eval-run launcher.
 *
 * Proves the panel wires the provider→model dropdown selections through to
 * startEvalRunAction: the target model picker feeds `target.model`, the judge
 * picker feeds `judgeModel`, and a null pick (default tier) omits the field.
 * The ProviderModelPicker is mocked to a pair of buttons that fire its
 * onChange — its own cascade logic is covered by its own tests; here we only
 * assert the panel maps picker values → the action payload.
 *
 * Covers:
 *   (a) Submitting with default-tier pickers → target {kind:"model"} with NO
 *       model, and judgeModel undefined.
 *   (b) Picking a target model + judge model → both flow into the payload.
 *   (c) Switching target to Agent hides the target model picker and sends
 *       {kind:"agent", agentSlug}.
 *   (d) Agent kind with an empty slug blocks submit with an inline error.
 *   (e) Success → router.refresh() + onRunStarted fire, "View results" link
 *       points at the run detail.
 *   (f) Error path → inline error, no refresh.
 *
 * Mock seam: ../../actions, next/navigation, @/components/ui/toast,
 * @/components/ui/segmented-control, @/components/ai (ProviderModelPicker).
 */

import * as React from "react";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { workspace } from "@/lib/routes";

const {
  mockStartEvalRunAction,
  mockGetEvalRunStatusAction,
  mockAddToast,
  mockRefresh,
} = vi.hoisted(() => ({
  mockStartEvalRunAction: vi.fn(),
  mockGetEvalRunStatusAction: vi.fn(),
  mockAddToast: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("../../../actions", () => ({
  startEvalRunAction: (...args: unknown[]) => mockStartEvalRunAction(...args),
  getEvalRunStatusAction: (...args: unknown[]) =>
    mockGetEvalRunStatusAction(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <div role="group" data-value={value}>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        const { value: itemValue, children: itemChildren } = child.props as {
          value: string;
          children: React.ReactNode;
        };
        return (
          <button
            type="button"
            role="radio"
            aria-checked={value === itemValue}
            onClick={() => onValueChange(itemValue)}
          >
            {itemChildren}
          </button>
        );
      })}
    </div>
  ),
  SegmentedControlItem: ({
    children,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <>{children}</>,
}));

// ProviderModelPicker → a button per instance (keyed by idPrefix) that fires
// onChange with a canned model id, plus a "clear" button that fires null.
vi.mock("@/components/ai", () => ({
  ProviderModelPicker: ({
    idPrefix,
    onChange,
  }: {
    idPrefix: string;
    onChange: (id: string | null) => void;
  }) => (
    <div data-testid={`picker-${idPrefix}`}>
      <button
        type="button"
        data-testid={`pick-${idPrefix}`}
        onClick={() => onChange(`${idPrefix}/picked-model`)}
      >
        pick {idPrefix}
      </button>
      <button
        type="button"
        data-testid={`clear-${idPrefix}`}
        onClick={() => onChange(null)}
      >
        clear {idPrefix}
      </button>
    </div>
  ),
}));

import { RunSetupPanel } from "../run-setup-panel";

const PROPS = {
  orgSlug: "acme",
  workspaceSlug: "research",
  datasetPublicId: "evd_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStartEvalRunAction.mockResolvedValue({
    ok: true,
    runId: "evr_1",
    itemCount: 5,
  });
  mockGetEvalRunStatusAction.mockResolvedValue({
    ok: true,
    status: {
      status: "running",
      itemCount: 5,
      completedCount: 1,
      failedCount: 0,
      avgScore: null,
    },
  });
});

afterEach(() => cleanup());

describe("RunSetupPanel — default tier", () => {
  it("submits target {kind:'model'} with NO model and no judgeModel when nothing is picked", async () => {
    render(<RunSetupPanel {...PROPS} />);

    fireEvent.submit(screen.getByLabelText("Run eval"));

    await waitFor(() => expect(mockStartEvalRunAction).toHaveBeenCalledOnce());
    const arg = mockStartEvalRunAction.mock.calls[0][0];
    expect(arg.target).toEqual({ kind: "model" });
    expect(arg.judgeModel).toBeUndefined();
    expect(arg).toMatchObject({
      orgSlug: "acme",
      workspaceSlug: "research",
      datasetPublicId: "evd_1",
      passThreshold: 0.7,
    });
  });
});

describe("RunSetupPanel — picked models", () => {
  it("feeds the picked target model and judge model into the payload", async () => {
    render(<RunSetupPanel {...PROPS} />);

    fireEvent.click(screen.getByTestId("pick-target"));
    fireEvent.click(screen.getByTestId("pick-judge"));
    fireEvent.submit(screen.getByLabelText("Run eval"));

    await waitFor(() => expect(mockStartEvalRunAction).toHaveBeenCalledOnce());
    const arg = mockStartEvalRunAction.mock.calls[0][0];
    expect(arg.target).toEqual({
      kind: "model",
      model: "target/picked-model",
    });
    expect(arg.judgeModel).toBe("judge/picked-model");
  });

  it("clearing the target picker back to default tier drops the model again", async () => {
    render(<RunSetupPanel {...PROPS} />);

    fireEvent.click(screen.getByTestId("pick-target"));
    fireEvent.click(screen.getByTestId("clear-target"));
    fireEvent.submit(screen.getByLabelText("Run eval"));

    await waitFor(() => expect(mockStartEvalRunAction).toHaveBeenCalledOnce());
    expect(mockStartEvalRunAction.mock.calls[0][0].target).toEqual({
      kind: "model",
    });
  });
});

describe("RunSetupPanel — agent target", () => {
  it("switching to Agent hides the target model picker and sends {kind:'agent', agentSlug}", async () => {
    render(<RunSetupPanel {...PROPS} />);

    fireEvent.click(screen.getByRole("radio", { name: "Agent" }));
    // Target model picker gone; judge picker remains.
    expect(screen.queryByTestId("picker-target")).not.toBeInTheDocument();
    expect(screen.getByTestId("picker-judge")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Agent slug"), {
      target: { value: "support-bot" },
    });
    fireEvent.submit(screen.getByLabelText("Run eval"));

    await waitFor(() => expect(mockStartEvalRunAction).toHaveBeenCalledOnce());
    expect(mockStartEvalRunAction.mock.calls[0][0].target).toEqual({
      kind: "agent",
      agentSlug: "support-bot",
    });
  });

  it("blocks submit with an inline error when the agent slug is empty", async () => {
    render(<RunSetupPanel {...PROPS} />);

    fireEvent.click(screen.getByRole("radio", { name: "Agent" }));
    fireEvent.submit(screen.getByLabelText("Run eval"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /agent slug is required/i,
    );
    expect(mockStartEvalRunAction).not.toHaveBeenCalled();
  });
});

describe("RunSetupPanel — outcomes", () => {
  it("on success refreshes, fires onRunStarted, and links to the run detail", async () => {
    const onRunStarted = vi.fn();
    render(<RunSetupPanel {...PROPS} onRunStarted={onRunStarted} />);

    fireEvent.submit(screen.getByLabelText("Run eval"));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());
    expect(onRunStarted).toHaveBeenCalledOnce();

    const link = await screen.findByTestId("evals-view-run");
    expect(link.getAttribute("href")).toBe(
      workspace.evals.run(
        { orgSlug: "acme", workspaceSlug: "research" },
        "evr_1",
      ),
    );
  });

  it("on error shows an inline error and does not refresh", async () => {
    mockStartEvalRunAction.mockResolvedValue({
      ok: false,
      error: "No items in dataset.",
    });
    render(<RunSetupPanel {...PROPS} />);

    fireEvent.submit(screen.getByLabelText("Run eval"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No items in dataset.",
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
