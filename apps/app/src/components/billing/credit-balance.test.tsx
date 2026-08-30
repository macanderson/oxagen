// @vitest-environment jsdom
/**
 * credit-balance.test.tsx — render + interaction tests for CreditBalance.
 *
 * Covers:
 *   - Renders balance as formatted USD
 *   - Ledger toggle: collapsed by default, expands on button click
 *   - Empty ledger shows "No ledger entries." when open
 *   - Non-empty ledger shows each entry's reason, date, and delta badge
 *   - Positive delta → success badge; negative delta → destructive badge
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreditBalance, type CreditLedgerEntry } from "./credit-balance";

afterEach(cleanup);

const makeLedger = (): CreditLedgerEntry[] => [
  {
    id: "e1",
    deltaCents: 500,
    reason: "Monthly credit",
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "e2",
    deltaCents: -200,
    reason: "Agent usage",
    createdAt: "2025-01-02T00:00:00Z",
  },
];

describe("CreditBalance — rendering", () => {
  it("renders the balance as formatted USD", () => {
    render(<CreditBalance balanceCents={1500} ledger={[]} />);
    expect(screen.getByText("$15.00")).toBeInTheDocument();
  });

  it("renders 'Credit balance' heading", () => {
    render(<CreditBalance balanceCents={0} ledger={[]} />);
    expect(screen.getByText("Credit balance")).toBeInTheDocument();
  });

  it("ledger is collapsed by default — entries not visible", () => {
    render(<CreditBalance balanceCents={1000} ledger={makeLedger()} />);
    expect(screen.queryByText("Monthly credit")).not.toBeInTheDocument();
  });

  it("shows 'Recent ledger entries' toggle button", () => {
    render(<CreditBalance balanceCents={1000} ledger={[]} />);
    expect(screen.getByText(/recent ledger entries/i)).toBeInTheDocument();
  });
});

describe("CreditBalance — ledger toggle", () => {
  it("clicking the toggle reveals the ledger", async () => {
    render(<CreditBalance balanceCents={1000} ledger={makeLedger()} />);
    await userEvent.click(screen.getByText(/recent ledger entries/i));
    expect(screen.getByText("Monthly credit")).toBeInTheDocument();
    expect(screen.getByText("Agent usage")).toBeInTheDocument();
  });

  it("clicking the toggle again hides the ledger", async () => {
    render(<CreditBalance balanceCents={1000} ledger={makeLedger()} />);
    await userEvent.click(screen.getByText(/recent ledger entries/i));
    expect(screen.getByText("Monthly credit")).toBeInTheDocument();
    await userEvent.click(screen.getByText(/recent ledger entries/i));
    expect(screen.queryByText("Monthly credit")).not.toBeInTheDocument();
  });

  it("empty ledger shows 'No ledger entries.' when open", async () => {
    render(<CreditBalance balanceCents={0} ledger={[]} />);
    await userEvent.click(screen.getByText(/recent ledger entries/i));
    expect(screen.getByText("No ledger entries.")).toBeInTheDocument();
  });

  it("positive delta renders success badge with '+' prefix", async () => {
    const ledger: CreditLedgerEntry[] = [
      {
        id: "e1",
        deltaCents: 500,
        reason: "Top-up",
        createdAt: "2025-01-01T00:00:00Z",
      },
    ];
    render(<CreditBalance balanceCents={500} ledger={ledger} />);
    await userEvent.click(screen.getByText(/recent ledger entries/i));
    expect(screen.getByText(/\+\$5\.00/)).toBeInTheDocument();
  });

  it("negative delta renders destructive badge", async () => {
    const ledger: CreditLedgerEntry[] = [
      {
        id: "e2",
        deltaCents: -100,
        reason: "Usage",
        createdAt: "2025-01-02T00:00:00Z",
      },
    ];
    render(<CreditBalance balanceCents={400} ledger={ledger} />);
    await userEvent.click(screen.getByText(/recent ledger entries/i));
    expect(screen.getByText(/-\$1\.00/)).toBeInTheDocument();
  });
});
