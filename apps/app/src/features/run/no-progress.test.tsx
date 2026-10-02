// @vitest-environment jsdom
// No-progress limit on the Cost tab (spend spec, detector 1; #4490): one line
// per loop that reached the workspace's limit, naming the call, the count,
// the mode, and what became of the run, with the reason an enforced limit
// could not pause it.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunNoProgressHit } from "@/data/contracts/run";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { NoProgressHits } from "./no-progress";

afterEach(cleanup);

function hit(over: Partial<RunNoProgressHit> = {}): RunNoProgressHit {
  return {
    tool: "Bash",
    loop: 1,
    repeats: 24,
    limit: 20,
    atCall: 20,
    mode: "observe",
    outcome: "would_pause",
    pauseBlock: null,
    detectedAt: "2026-10-01T12:00:00.000Z",
    ...over,
  };
}

function renderHits(hits: RunNoProgressHit[]) {
  return render(
    <IntlProvider>
      <NoProgressHits hits={hits} />
    </IntlProvider>,
  );
}

describe("NoProgressHits", () => {
  it("names the call, the count, the limit, and the mode of an observe hit, and says the run went on", async () => {
    const { container } = renderHits([hit()]);
    const panel = screen.getByTestId("no-progress");
    expect(
      within(panel).getByRole("heading", { name: "No-progress limit" }),
    ).toBeInTheDocument();
    const line = within(panel).getByTestId("no-progress-hit");
    expect(line).toHaveTextContent("observe mode");
    expect(line).toHaveTextContent(
      "Bash ran 24 times in a row with an unchanged result. The loop reached the limit of 20 at call 20. Recorded. The run went on.",
    );
    await expectNoAxe(container);
  });

  it("says an enforced hit paused the run at its next checkpoint", () => {
    renderHits([hit({ mode: "enforced", outcome: "paused" })]);
    const line = screen.getByTestId("no-progress-hit");
    expect(line).toHaveTextContent("enforced mode");
    expect(line).toHaveTextContent(
      "Paused. The pause takes hold at the run's next checkpoint.",
    );
  });

  it("names why an enforced limit could not pause a run with no governed call to pause at", () => {
    renderHits([
      hit({
        mode: "enforced",
        outcome: "would_pause",
        pauseBlock: "host_offline",
      }),
      hit({
        loop: 2,
        atCall: 45,
        mode: "enforced",
        outcome: "would_pause",
        pauseBlock: "no_connection_point",
      }),
    ]);
    const [offline, ledger] = screen.getAllByTestId("no-progress-hit");
    expect(offline).toHaveTextContent(
      "Could not pause the run: the run's host had not checked in for five minutes.",
    );
    expect(ledger).toHaveTextContent(
      "Could not pause the run: no host carries commands for this run, so it has no governed call to pause at.",
    );
    expect(ledger).toHaveTextContent("at call 45");
  });

  it("says when the record holds no reason for an enforced hit that did not pause", () => {
    renderHits([hit({ mode: "enforced", outcome: "would_pause" })]);
    expect(screen.getByTestId("no-progress-hit")).toHaveTextContent(
      "Could not pause the run. The record does not say why.",
    );
  });

  it("draws nothing for a run with no loop at the limit (negative)", () => {
    const { container } = renderHits([]);
    expect(screen.queryByTestId("no-progress")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
