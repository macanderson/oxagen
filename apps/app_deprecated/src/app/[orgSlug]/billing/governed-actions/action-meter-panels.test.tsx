// @vitest-environment jsdom
/**
 * action-meter-panels.test.tsx — render tests for the governed-action panels.
 *
 * These exist to hold the ADR-052 honesty requirements at the presentation
 * layer, where they are easiest to lose in a redesign:
 *
 *   - shadow mode is stated prominently and never looks like a bill
 *   - a band true-up is shown, described, and attributed to the customer
 *   - the zero model-token row is rendered rather than omitted
 *   - a negotiated allowance reads as negotiated, never as unlimited
 *   - an unmeasured stored volume reads as unmeasured, never as 0 GB
 *   - opt-out retention reads as "nothing accruing"
 *   - a failed read renders as unavailable, never as zeros
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { BillingActionUsageOutput } from "@oxagen/oxagen/contracts/billing.action_usage";
import type { BillingActionRateCardOutput } from "@oxagen/oxagen/contracts/billing.action_rate_card";
import type { BillingEvidenceRetentionOutput } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { ActionUsagePanel, MeterModeBanner } from "./action-usage-panel";
import { RateCardPanel } from "./rate-card-panel";
import { RetentionPanel } from "./retention-panel";
import { PanelUnavailable } from "./panel-unavailable";
import { EstimateResult } from "./estimate-result";
import {
  NEGOTIATED_ALLOWANCE_LABEL,
  NOT_MEASURED_LABEL,
} from "./action-meter-format";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures — shaped exactly like the handlers' return values.
// ---------------------------------------------------------------------------

const usage: BillingActionUsageOutput = {
  period: {
    start: "2026-01-01T00:00:00.000Z",
    end: "2027-01-01T00:00:00.000Z",
  },
  actionsUsed: 1_250_000,
  actionsIncluded: 1_000_000,
  actionsWithinAllowance: 1_000_000,
  actionsCharged: 250_000,
  actionsRemaining: 0,
  band: { id: "1m-5m", usdPer1000: 15 },
  creditsCharged: 500_000,
  creditsAtFinalBand: 375_000,
  bandTrueUpCredits: 125_000,
  meterMode: "charge",
  modelSpend: {
    reportedCostMicros: 4_200_000,
    chargedCredits: 0,
    assistantTokenCredits: 0,
  },
  byCapability: [],
};

const rateCard: BillingActionRateCardOutput = {
  unit: "governed_action",
  summary:
    "Oxagen bills one governed action per top-level capability invocation.",
  bands: [
    {
      id: "0-1m",
      minAnnualActions: 0,
      maxAnnualActions: 1_000_000,
      usdPer1000: 20,
    },
    {
      id: "1m-5m",
      minAnnualActions: 1_000_000,
      maxAnnualActions: 5_000_000,
      usdPer1000: 15,
    },
    {
      id: "5m+",
      minAnnualActions: 5_000_000,
      maxAnnualActions: null,
      usdPer1000: 10,
    },
  ],
  tiers: [
    { tier: "free", includedActionsAnnual: 1_000, retentionMonths: 1 },
    { tier: "build", includedActionsAnnual: 100_000, retentionMonths: 12 },
    { tier: "scale", includedActionsAnnual: 1_000_000, retentionMonths: 12 },
    // The one that must never read as "unlimited".
    { tier: "enterprise", includedActionsAnnual: null, retentionMonths: 12 },
  ],
  retention: { includedMonths: 12, usdPerGbMonth: 0.08, optIn: true },
  modelTokens: {
    usdPerToken: 0,
    explanation:
      "Model token spend is reported in full and charged at zero. The zero is a line on your invoice, not an omission from it.",
  },
  yourTier: "scale",
  yourIncludedActionsAnnual: 1_000_000,
};

const retention: BillingEvidenceRetentionOutput = {
  includedMonths: 12,
  effectiveRetentionDays: null,
  extendedRetentionEnabled: false,
  usdPerGbMonth: 0.08,
  storedGbBeyondIncluded: null,
  storedGbMeasured: false,
  creditsChargedThisPeriod: 0,
};

// ---------------------------------------------------------------------------
// Shadow mode
// ---------------------------------------------------------------------------

describe("MeterModeBanner — shadow mode is stated, not implied", () => {
  it("renders nothing when the meter is charging", () => {
    const { container } = render(<MeterModeBanner mode="charge" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a prominent banner saying it is counting, not charging", () => {
    render(<MeterModeBanner mode="shadow" />);
    const banner = screen.getByTestId("meter-mode-shadow");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/counting, not charging/i);
    expect(banner).toHaveTextContent(/Nothing here is on an invoice today/i);
  });
});

describe("ActionUsagePanel — shadow mode changes what the figures mean", () => {
  it("badges the panel as not charging and says so in the charged row", () => {
    render(<ActionUsagePanel usage={{ ...usage, meterMode: "shadow" }} />);
    expect(screen.getByText(/Shadow — not charging/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Shadow mode raises no charge/i),
    ).toBeInTheDocument();
  });

  it("badges the panel as charging when the meter is live", () => {
    render(<ActionUsagePanel usage={usage} />);
    expect(screen.getByText("Charging")).toBeInTheDocument();
    expect(
      screen.getByText(/Read back from the credit ledger/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Band true-up
// ---------------------------------------------------------------------------

describe("ActionUsagePanel — the band true-up is money owed back", () => {
  it("surfaces a non-zero true-up with a plain-language explanation", () => {
    render(<ActionUsagePanel usage={usage} />);
    const trueUp = screen.getByTestId("band-true-up");
    expect(trueUp).toHaveTextContent(/True-up owed to you: \$1,250\.00/);
    expect(trueUp).toHaveTextContent(/credited back to you at reconciliation/i);
    expect(trueUp).toHaveTextContent(/before the invoice, not after/i);
  });

  it("omits the callout when nothing is owed, but keeps the ledger row", () => {
    render(
      <ActionUsagePanel
        usage={{
          ...usage,
          creditsCharged: 375_000,
          bandTrueUpCredits: 0,
        }}
      />,
    );
    expect(screen.queryByTestId("band-true-up")).not.toBeInTheDocument();
    expect(screen.getByText("Band true-up")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The zero model-token row
// ---------------------------------------------------------------------------

describe("ActionUsagePanel — the zero token charge is the message", () => {
  it("renders the charged-at-zero row with its explanation", () => {
    render(<ActionUsagePanel usage={usage} />);
    const row = screen.getByTestId("model-tokens-zero-row");
    expect(within(row).getByText("Model tokens charged")).toBeInTheDocument();
    expect(within(row).getByText("$0.00")).toBeInTheDocument();
    expect(row).toHaveTextContent(/Zero, deliberately/i);
    expect(row).toHaveTextContent(/charging twice for one call/i);
  });

  it("still reports the full token cost beside the zero charge", () => {
    render(<ActionUsagePanel usage={usage} />);
    expect(screen.getByText("Model tokens reported")).toBeInTheDocument();
    expect(screen.getByText("$4.20")).toBeInTheDocument();
  });
});

describe("ActionUsagePanel — empty state", () => {
  it("teaches what a governed action is when nothing has been recorded", () => {
    render(
      <ActionUsagePanel
        usage={{
          ...usage,
          actionsUsed: 0,
          actionsWithinAllowance: 0,
          actionsCharged: 0,
          actionsRemaining: 1_000_000,
          creditsCharged: 0,
          creditsAtFinalBand: 0,
          bandTrueUpCredits: 0,
        }}
      />,
    );
    const empty = screen.getByTestId("usage-empty-state");
    expect(empty).toHaveTextContent(/No governed actions have been recorded/i);
    expect(empty).toHaveTextContent(/passed its gates and completed/i);
  });

  it("hides the empty state once there is activity", () => {
    render(<ActionUsagePanel usage={usage} />);
    expect(screen.queryByTestId("usage-empty-state")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Rate card
// ---------------------------------------------------------------------------

describe("RateCardPanel — negotiated is not unlimited", () => {
  it("renders the enterprise allowance as negotiated, never as ∞ or blank", () => {
    render(<RateCardPanel rateCard={rateCard} />);
    const row = screen.getByTestId("rate-card-tier-enterprise");
    expect(
      within(row).getByText(NEGOTIATED_ALLOWANCE_LABEL),
    ).toBeInTheDocument();
    expect(row.textContent ?? "").not.toContain("∞");
    expect((row.textContent ?? "").toLowerCase()).not.toContain("unlimited");
  });

  it("renders concrete allowances for the tiers that publish one", () => {
    render(<RateCardPanel rateCard={rateCard} />);
    const row = screen.getByTestId("rate-card-tier-scale");
    expect(within(row).getByText("1,000,000 actions")).toBeInTheDocument();
  });

  it("marks the caller's own tier with text, not only a tint", () => {
    render(<RateCardPanel rateCard={rateCard} />);
    const row = screen.getByTestId("rate-card-tier-scale");
    expect(within(row).getByText("(your tier)")).toBeInTheDocument();
  });
});

describe("RateCardPanel — the zero token rate is a published price", () => {
  it("renders the model-token row with its price and explanation", () => {
    render(<RateCardPanel rateCard={rateCard} />);
    const row = screen.getByTestId("rate-card-model-tokens");
    expect(row).toHaveTextContent("$0.00 per token");
    expect(row).toHaveTextContent(/not an omission from it/i);
  });

  it("states that retention beyond the included window is opt-in", () => {
    render(<RateCardPanel rateCard={rateCard} />);
    expect(
      screen.getByText(/never starts accruing on its own/i),
    ).toBeInTheDocument();
  });

  it("renders every volume band as a row with its range and price", () => {
    render(<RateCardPanel rateCard={rateCard} />);
    expect(screen.getByText("1,000,000 – 4,999,999")).toBeInTheDocument();
    expect(screen.getByText("5,000,000+")).toBeInTheDocument();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe("RetentionPanel — unmeasured is not zero, opt-out is not accruing", () => {
  it("renders an unmeasured stored volume as 'not measured yet'", () => {
    render(<RetentionPanel retention={retention} />);
    expect(screen.getAllByText(NOT_MEASURED_LABEL).length).toBeGreaterThan(0);
    expect(screen.queryByText("0 GB")).not.toBeInTheDocument();
    expect(screen.getByText(/is not the same as zero/i)).toBeInTheDocument();
  });

  it("says nothing is accruing when extended retention is off", () => {
    render(<RetentionPanel retention={retention} />);
    const alert = screen.getByTestId("retention-opt-in-off");
    expect(alert).toHaveTextContent(/Nothing is accruing/i);
    expect(alert).toHaveTextContent(/no retention charge can accrue/i);
    expect(screen.queryByTestId("retention-opt-in-on")).not.toBeInTheDocument();
  });

  it("warns that the meter is live when extended retention is opted into", () => {
    render(
      <RetentionPanel
        retention={{
          ...retention,
          extendedRetentionEnabled: true,
          storedGbBeyondIncluded: 40,
          storedGbMeasured: true,
          creditsChargedThisPeriod: 320,
        }}
      />,
    );
    const alert = screen.getByTestId("retention-opt-in-on");
    expect(alert).toHaveTextContent(/Extended retention is switched on/i);
    expect(alert).toHaveTextContent(/\$0\.08 per GB-month/);
    expect(screen.getByText("40 GB")).toBeInTheDocument();
    expect(screen.getByText("$3.20")).toBeInTheDocument();
    expect(screen.queryByText(NOT_MEASURED_LABEL)).not.toBeInTheDocument();
  });

  it("explains that no pinned policy is not 'kept forever'", () => {
    render(<RetentionPanel retention={retention} />);
    expect(
      screen.getByText(/not that evidence is kept forever/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Partial state
// ---------------------------------------------------------------------------

describe("PanelUnavailable — a failed read is not a zero", () => {
  it("says what could not be read and why no number is shown", () => {
    render(
      <PanelUnavailable
        title="Rate card"
        what="The published rate card"
        detail="ECONNREFUSED"
      />,
    );
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(
      screen.getByText(/a zero would be a claim about your account/i),
    ).toBeInTheDocument();
    expect(screen.getByText("ECONNREFUSED")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Calculator result
// ---------------------------------------------------------------------------

describe("EstimateResult — the ratio is shown before the price", () => {
  it("renders the published ratio and names it as published", () => {
    render(
      <EstimateResult
        estimate={{
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
        }}
      />,
    );
    const assumptions = screen.getByTestId("calc-assumptions");
    expect(assumptions).toHaveTextContent("100,000 runs");
    expect(assumptions).toHaveTextContent("15 actions per run");
    expect(assumptions).toHaveTextContent(
      /the published ratio for this run class/i,
    );
    expect(assumptions).toHaveTextContent(/Standard task/);
    expect(screen.getByText("$7,500.00 / year")).toBeInTheDocument();
  });

  it("names a caller-supplied ratio as the customer's own measurement", () => {
    render(
      <EstimateResult
        estimate={{
          assumptions: {
            runsPerYear: 10_000,
            actionsPerRun: 42,
            actionsPerRunSource: "caller_supplied",
            runClass: "standard_task",
            tier: "build",
          },
          actionsPerYear: 420_000,
          includedActionsAnnual: 100_000,
          overageActions: 320_000,
          band: { id: "0-1m", usdPer1000: 20 },
          overageUsd: 6_400,
          excludes: "This estimate covers governed-action overage only.",
        }}
      />,
    );
    expect(screen.getByTestId("calc-assumptions")).toHaveTextContent(
      /your measured ratio/i,
    );
  });

  it("renders a negotiated allowance as negotiated and explains the upper bound", () => {
    render(
      <EstimateResult
        estimate={{
          assumptions: {
            runsPerYear: 50_000,
            actionsPerRun: 55,
            actionsPerRunSource: "run_class",
            runClass: "multi_step",
            tier: "enterprise",
          },
          actionsPerYear: 2_750_000,
          includedActionsAnnual: null,
          overageActions: 2_750_000,
          band: { id: "1m-5m", usdPer1000: 15 },
          overageUsd: 41_250,
          excludes: "This estimate covers governed-action overage only.",
        }}
      />,
    );
    expect(screen.getByTestId("calc-included")).toHaveTextContent(
      NEGOTIATED_ALLOWANCE_LABEL,
    );
    expect(screen.getByTestId("calc-negotiated-note")).toHaveTextContent(
      /upper bound of what you could owe/i,
    );
  });
});
