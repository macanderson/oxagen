// @vitest-environment jsdom
/**
 * cost-calculator.test.tsx — the calculator's five states and its one rule.
 *
 * The rule: whatever ratio the handler used is shown with the quote. Everything
 * else here is state coverage — idle, busy, error, permission-denied, loaded —
 * plus the input contract the form promises the action (an omitted override is
 * omitted, not sent as a zero).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { BillingActionEstimateOutput } from "@oxagen/oxagen/contracts/billing.action_estimate";

const { previewActionCostAction } = vi.hoisted(() => ({
  previewActionCostAction: vi.fn(),
}));

vi.mock("./actions", () => ({ previewActionCostAction }));

import { CostCalculator } from "./cost-calculator";

const estimate: BillingActionEstimateOutput = {
  assumptions: {
    runsPerYear: 100_000,
    actionsPerRun: 15,
    actionsPerRunSource: "run_class",
    runClass: "standard_task",
    tier: "scale",
  },
  actionsPerYear: 1_500_000,
  includedActionsAnnual: 1_000_000,
  overageActions: 500_000,
  band: { id: "1m-5m", usdPer1000: 15 },
  overageUsd: 7_500,
  excludes: "This estimate covers governed-action overage only.",
};

beforeEach(() => {
  previewActionCostAction.mockReset();
});
afterEach(cleanup);

function submit() {
  fireEvent.submit(
    screen.getByRole("form", { name: /governed action cost estimate/i }),
  );
}

describe("CostCalculator — idle state", () => {
  it("teaches that no estimate has been run yet", () => {
    render(<CostCalculator orgSlug="acme" />);
    expect(screen.getByText(/No estimate yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("calc-result")).not.toBeInTheDocument();
  });

  it("labels every input and binds the label to its control", () => {
    render(<CostCalculator orgSlug="acme" />);
    expect(screen.getByLabelText("Runs per year")).toHaveAttribute(
      "id",
      "calc-runs-per-year",
    );
    expect(screen.getByLabelText("Run class")).toHaveAttribute(
      "id",
      "calc-run-class",
    );
    expect(screen.getByLabelText("Actions per run (optional)")).toHaveAttribute(
      "id",
      "calc-actions-per-run",
    );
    expect(screen.getByLabelText("Tier")).toHaveAttribute("id", "calc-tier");
  });

  it("defaults the tier to the caller's own", () => {
    render(<CostCalculator orgSlug="acme" defaultTier="enterprise" />);
    expect(screen.getByLabelText("Tier")).toHaveValue("enterprise");
  });
});

describe("CostCalculator — loaded state", () => {
  it("renders the quote with the assumptions the handler reported", async () => {
    previewActionCostAction.mockResolvedValue({ ok: true, data: estimate });
    render(<CostCalculator orgSlug="acme" />);
    submit();

    await waitFor(() =>
      expect(screen.getByTestId("calc-result")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("calc-assumptions")).toHaveTextContent(
      "15 actions per run",
    );
    expect(screen.getByTestId("calc-assumptions")).toHaveTextContent(
      /the published ratio for this run class/i,
    );
    expect(screen.getByText("$7,500.00 / year")).toBeInTheDocument();
  });

  it("omits the override entirely when the field is blank", async () => {
    previewActionCostAction.mockResolvedValue({ ok: true, data: estimate });
    render(<CostCalculator orgSlug="acme" />);
    fireEvent.change(screen.getByLabelText("Runs per year"), {
      target: { value: "250000" },
    });
    fireEvent.change(screen.getByLabelText("Run class"), {
      target: { value: "multi_step" },
    });
    submit();

    await waitFor(() => expect(previewActionCostAction).toHaveBeenCalled());
    const input = previewActionCostAction.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      orgSlug: "acme",
      runsPerYear: 250_000,
      runClass: "multi_step",
      tier: "scale",
    });
    // Not `actionsPerRun: undefined` — "present" is how the contract decides a
    // measured ratio was supplied.
    expect(Object.hasOwn(input as object, "actionsPerRun")).toBe(false);
  });

  it("passes a measured override through when one is entered", async () => {
    previewActionCostAction.mockResolvedValue({
      ok: true,
      data: {
        ...estimate,
        assumptions: {
          ...estimate.assumptions,
          actionsPerRun: 42,
          actionsPerRunSource: "caller_supplied",
        },
      },
    });
    render(<CostCalculator orgSlug="acme" />);
    fireEvent.change(screen.getByLabelText("Actions per run (optional)"), {
      target: { value: "42" },
    });
    submit();

    await waitFor(() => expect(previewActionCostAction).toHaveBeenCalled());
    expect(previewActionCostAction.mock.calls[0]?.[0]).toMatchObject({
      actionsPerRun: 42,
    });
    await waitFor(() =>
      expect(screen.getByTestId("calc-assumptions")).toHaveTextContent(
        /your measured ratio/i,
      ),
    );
  });
});

describe("CostCalculator — error states", () => {
  it("rejects a runs value below one without calling the server", async () => {
    render(<CostCalculator orgSlug="acme" />);
    fireEvent.change(screen.getByLabelText("Runs per year"), {
      target: { value: "0" },
    });
    submit();

    await waitFor(() =>
      expect(screen.getByTestId("calc-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("calc-error")).toHaveTextContent(/1 or more/i);
    expect(previewActionCostAction).not.toHaveBeenCalled();
  });

  it("rejects a non-positive override without calling the server", async () => {
    render(<CostCalculator orgSlug="acme" />);
    fireEvent.change(screen.getByLabelText("Actions per run (optional)"), {
      target: { value: "0" },
    });
    submit();

    await waitFor(() =>
      expect(screen.getByTestId("calc-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("calc-error")).toHaveTextContent(
      /must be a positive number/i,
    );
    expect(previewActionCostAction).not.toHaveBeenCalled();
  });

  it("renders the server's permission message rather than a bare failure", async () => {
    previewActionCostAction.mockResolvedValue({
      ok: false,
      error: "You don't have permission to read billing for this organization.",
    });
    render(<CostCalculator orgSlug="acme" />);
    submit();

    await waitFor(() =>
      expect(screen.getByTestId("calc-error")).toHaveTextContent(
        /don't have permission to read billing/i,
      ),
    );
    expect(screen.queryByTestId("calc-result")).not.toBeInTheDocument();
  });
});

describe("CostCalculator — busy state", () => {
  it("disables the form and announces that it is calculating", async () => {
    let release: (v: { ok: true; data: BillingActionEstimateOutput }) => void =
      () => {};
    previewActionCostAction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<CostCalculator orgSlug="acme" />);
    submit();

    await waitFor(() =>
      expect(screen.getByTestId("calc-submit")).toBeDisabled(),
    );
    expect(screen.getByText(/Calculating the estimate/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Runs per year")).toBeDisabled();

    release({ ok: true, data: estimate });
    await waitFor(() =>
      expect(screen.getByTestId("calc-submit")).not.toBeDisabled(),
    );
  });
});
