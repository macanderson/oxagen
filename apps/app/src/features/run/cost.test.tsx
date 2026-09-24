// @vitest-environment jsdom
// The Cost tab (cost.tsx): the run's rollup with its per-model and per-tool
// breakdown. The rule every case here holds is the file's own: a figure the
// rollup did not measure reads as "not recorded", never as a zero, and a
// section with nothing in it says so in words rather than drawing an empty
// table.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunCost, RunCostRollup } from "@/data/contracts/run";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { CostSection } from "./cost";
import { runCost, runTranscript } from "./run.builders";

afterEach(cleanup);

function renderCost(read: Read<RunCost>) {
  return render(
    <IntlProvider>
      <CostSection
        read={read}
        turns={readOk(runTranscript({ zoom: "turns" }))}
        steps={readOk(runTranscript())}
      />
    </IntlProvider>,
  );
}

/** The builder's rollup, with the given fields replaced. */
function rollup(overrides: Partial<RunCostRollup>): Read<RunCost> {
  const base = runCost().rollup;
  if (base === null) throw new Error("the builder carries a rollup");
  return readOk({ rollup: { ...base, ...overrides } });
}

function costPanel(): HTMLElement {
  return screen.getByRole("region", { name: "Cost" });
}

/** The value a fact in the Cost panel shows, found by its label. */
function fact(label: string): HTMLElement {
  const term = within(costPanel()).getByText(label, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`${label} has a value`);
  return value;
}

describe("CostSection", () => {
  it("draws the measured rollup: total and basis, figures, price entries, model and tool rows", async () => {
    const { container } = renderCost(readOk(runCost()));
    expect(fact("Total")).toHaveTextContent("gateway_observed");
    expect(fact("Cache hit rate")).not.toHaveTextContent("not recorded");
    expect(fact("Retries")).toHaveTextContent(/^2$/);
    expect(fact("Priced with")).toHaveTextContent("prc_01k4qj9e");
    const model = screen.getByTestId("cost-model-row");
    expect(model).toHaveTextContent("claude-opus-5");
    expect(model).toHaveTextContent("anthropic");
    expect(model).not.toHaveTextContent("not recorded");
    expect(screen.getByTestId("cost-tool-row")).toHaveTextContent(
      "create_release",
    );
    await expectNoAxe(container);
  });

  it("reads every figure the rollup did not measure as not recorded, never as a zero (negative)", async () => {
    const { container } = renderCost(
      rollup({
        cost: null,
        cacheHitRate: null,
        turns: null,
        retries: null,
        productiveRatio: null,
        priceEntryIds: [],
      }),
    );
    for (const label of [
      "Total",
      "Cache hit rate",
      "Turns",
      "Retries",
      "Productive ratio",
      "Priced with",
    ])
      expect(fact(label)).toHaveTextContent(/^not recorded$/);
    expect(fact("Steps")).toHaveTextContent(/^96$/);
    await expectNoAxe(container);
  });

  it("names a total whose basis was not recorded rather than leaving the basis blank", () => {
    renderCost(
      rollup({ cost: { micros: "4131265", currency: "USD", basis: null } }),
    );
    expect(fact("Total")).toHaveTextContent("basis not recorded");
  });

  it("draws a model row with no provider and no priced cost as not recorded (negative)", () => {
    renderCost(
      rollup({
        byModel: [
          {
            model: "local-llama",
            provider: null,
            calls: 3,
            cost: null,
            tokens: {
              inputUncached: 1,
              cacheRead: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              output: 1,
              reasoning: 0,
            },
          },
        ],
      }),
    );
    const row = screen.getByTestId("cost-model-row");
    expect(row).toHaveTextContent("local-llama");
    expect(row).not.toHaveTextContent("anthropic");
    expect(row).toHaveTextContent("not recorded");
  });

  it("says no model call was priced and no tool was called instead of drawing empty tables (negative)", async () => {
    const { container } = renderCost(rollup({ byModel: [], byTool: [] }));
    const panel = costPanel();
    expect(panel).toHaveTextContent("No model call in this run was priced.");
    expect(panel).toHaveTextContent("This run called no tool.");
    expect(screen.queryByTestId("cost-model-row")).toBeNull();
    expect(screen.queryByTestId("cost-tool-row")).toBeNull();
    expect(within(panel).queryByRole("table")).toBeNull();
    await expectNoAxe(container);
  });

  it("says the rollup has not run rather than printing zeros (negative)", () => {
    renderCost(readOk({ rollup: null }));
    expect(screen.getByTestId("cost-not-rolled-up")).toHaveTextContent(
      "A zero here would be a measurement",
    );
    expect(within(costPanel()).queryByText("Total")).toBeNull();
  });

  it("replaces the panel body with the failure the read answered, keeping the waterfall (negative)", async () => {
    const { container } = renderCost(readError("cost_store_unreachable", 503));
    const panel = costPanel();
    expect(panel).toHaveTextContent("cost_store_unreachable");
    expect(within(panel).queryByText("Total")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Run waterfall" }),
    ).toBeInTheDocument();
    await expectNoAxe(container);
  });

  it("names the permission a denied read needed (negative)", () => {
    renderCost({ ok: false, reason: "denied", permission: "runs.read" });
    expect(costPanel()).toHaveTextContent("runs.read");
  });
});
