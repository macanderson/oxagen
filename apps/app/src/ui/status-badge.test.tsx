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

const draw = (status: RunStatus, outcome: RunOutcome): HTMLElement => {
  const { container } = render(
    <IntlProvider>
      <StatusBadge status={status} outcome={outcome} />
    </IntlProvider>,
  );
  const badge = container.querySelector<HTMLElement>("span[data-status]");
  if (!badge) throw new Error("the badge did not render");
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

  it("draws the shared state pill, and gives a failure its own hue", async () => {
    // ADR-132: the badge is the mockup's `.b` recipe, so the hue sits on the
    // ink, the border and the dot together. Greyscale is carried by the word,
    // which is why the word had to stop being `sealed` for all five.
    const failed = draw("sealed", "failed");
    const completed = draw("sealed", "completed");
    expect(failed.querySelector("span[aria-hidden='true']")).toBeTruthy();
    expect(failed.className).not.toBe(completed.className);
    expect(failed.className).toMatch(/error/);
    await expectNoAxe(failed);
  });

  it("prints the lifecycle word on Fleet and keeps the outcome on hover", () => {
    const { container } = render(
      <IntlProvider>
        <StatusBadge status="sealed" outcome="failed" vocabulary="lifecycle" />
        <StatusBadge
          status="halted"
          outcome="cancelled"
          vocabulary="lifecycle"
        />
        <StatusBadge status="live" outcome="running" vocabulary="lifecycle" />
      </IntlProvider>,
    );
    const badges = [
      ...container.querySelectorAll<HTMLElement>("span[data-status]"),
    ];
    expect(badges.map((b) => b.textContent)).toEqual([
      "sealed",
      "halted",
      "live",
    ]);
    expect(badges[0]).toHaveAttribute("title", "failed");
    expect(badges[1]).toHaveAttribute("title", "cancelled");
    // An open run has no outcome yet, so there is nothing to hover.
    expect(badges[2]).not.toHaveAttribute("title");
  });
});
