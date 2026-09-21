// @vitest-environment jsdom
// The run badge in each state the row can hold. Shared by the Run header and
// the Fleet runs table, so it is pinned here rather than through either page.
//
// The badge read `sealed` for every run that ended, which is the reading this
// pins against: a run that finished, a run that failed, a run an operator
// cancelled, a run whose harness died, and a run whose harness stopped
// reporting all showed the same word.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunOutcome, RunStatus } from "@/data/contracts/runs";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { StatusBadge } from "./status-badge";

afterEach(cleanup);

const draw = (status: RunStatus, outcome: RunOutcome) => {
  const { container } = render(
    <IntlProvider>
      <StatusBadge status={status} outcome={outcome} />
    </IntlProvider>,
  );
  const badge = container.querySelector<HTMLElement>("[data-status]");
  if (badge === null) throw new Error("StatusBadge rendered no badge");
  return badge;
};

describe("StatusBadge", () => {
  it("names each terminal state, not one word for all five", () => {
    const words = (
      [
        ["sealed", "completed"],
        ["sealed", "failed"],
        ["halted", "cancelled"],
        ["sealed", "crashed"],
        ["sealed", "unknown"],
      ] as const
    ).map(([status, outcome]) => {
      cleanup();
      return draw(status, outcome).textContent;
    });
    expect(new Set(words).size).toBe(5);
    expect(words).toEqual([
      "completed",
      "failed",
      "cancelled",
      "crashed",
      // A run the record cannot account for says so, rather than borrowing a
      // word from a run that finished.
      "outcome not recorded",
    ]);
  });

  it("reads live while the run is open, whatever the outcome column holds", () => {
    expect(draw("live", "running").textContent).toBe("live");
  });

  it("carries both readings as data, so a caller can style or assert on either", () => {
    const badge = draw("halted", "cancelled");
    expect(badge).toHaveAttribute("data-status", "halted");
    expect(badge).toHaveAttribute("data-outcome", "cancelled");
  });

  it("keeps the hue on the dot and the word on the ink, so it survives greyscale", async () => {
    const badge = draw("sealed", "failed");
    const dot = badge.querySelector("span[aria-hidden='true']");
    expect(dot).toHaveClass("bg-destructive");
    expect(badge.className).not.toMatch(/text-(destructive|success|warning)/);
    await expectNoAxe(badge);
  });
});
