// @vitest-environment jsdom
// The Cost tab's rollup panel (#2962, spec §12.6): each figure the rollup
// measured is printed with the basis that says who observed it, and each
// figure it did not record reads "not recorded" rather than zero, whether it
// is a fact, a model row's provider or cost, or a price entry list.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunCost, RunCostRollup } from "@/data/contracts/run";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { CostSection } from "./cost";
import { runCost, runTranscript } from "./run.builders";

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function withRollup(overrides: Partial<RunCostRollup>): RunCost {
  const base = runCost().rollup;
  if (base === null) throw new Error("the default rollup is recorded");
  return { rollup: { ...base, ...overrides } };
}

function renderCost(read: Read<RunCost>) {
  render(
    <IntlProvider>
      <CostSection
        read={read}
        turns={readOk(runTranscript({ zoom: "turns" }))}
        steps={readOk(runTranscript())}
      />
    </IntlProvider>,
  );
  return screen.getByRole("region", { name: "Cost" });
}

/** The value printed against one fact's label. */
function fact(section: HTMLElement, label: string): string | null {
  const term = within(section).getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent ?? null;
}

describe("CostSection", () => {
  it("prints every measured figure, the basis, the provider and the price entries", () => {
    const section = renderCost(readOk(runCost()));
    expect(fact(section, "Total")).toContain("gateway_observed");
    expect(fact(section, "Cache hit rate")).toBe("83%");
    expect(fact(section, "Turns")).toBe("12");
    expect(fact(section, "Steps")).toBe("96");
    expect(fact(section, "Model calls")).toBe("54");
    expect(fact(section, "Tool calls")).toBe("42");
    expect(fact(section, "Retries")).toBe("2");
    expect(fact(section, "Productive ratio")).toBe("71%");
    expect(fact(section, "Priced with")).toBe("prc_01k4qj9e");
    const model = screen.getByTestId("cost-model-row");
    expect(model).toHaveTextContent("claude-opus-5");
    expect(model).toHaveTextContent("anthropic");
    expect(within(model).getByTestId("money")).toBeTruthy();
    const tool = within(screen.getByTestId("cost-tool-row"))
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(tool).toEqual(["create_release", "3"]);
    expect(within(section).queryByText("not recorded")).toBeNull();
  });

  it("says each figure the rollup did not record is not recorded instead of printing a zero (negative)", () => {
    const section = renderCost(
      readOk(
        withRollup({
          cost: null,
          cacheHitRate: null,
          turns: null,
          retries: null,
          productiveRatio: null,
          priceEntryIds: [],
          byModel: [
            {
              model: "gpt-6-mini",
              provider: null,
              calls: 2,
              cost: null,
              tokens: {
                inputUncached: 10,
                cacheRead: 0,
                cacheWrite5m: 0,
                cacheWrite1h: 0,
                output: 4,
                reasoning: 0,
              },
            },
          ],
        }),
      ),
    );
    for (const label of [
      "Total",
      "Cache hit rate",
      "Turns",
      "Retries",
      "Productive ratio",
      "Priced with",
    ])
      expect(fact(section, label)).toBe("not recorded");
    expect(fact(section, "Steps")).toBe("96");
    const model = screen.getByTestId("cost-model-row");
    expect(model).toHaveTextContent("gpt-6-mini");
    expect(within(model).queryByTestId("money")).toBeNull();
    expect(within(model).getByText("not recorded")).toBeTruthy();
    expect(within(section).queryByTestId("money")).toBeNull();
  });

  it("prints a total whose basis was not recorded with that said beside it (negative)", () => {
    const section = renderCost(
      readOk(
        withRollup({
          cost: { micros: "4131265", currency: "USD", basis: null },
        }),
      ),
    );
    const total = fact(section, "Total");
    expect(total).toContain("basis not recorded");
    expect(total).not.toContain("gateway_observed");
  });

  it("says no model call was priced and no tool was called, with no empty tables (negative)", () => {
    const section = renderCost(readOk(withRollup({ byModel: [], byTool: [] })));
    expect(
      within(section).getByText("No model call in this run was priced."),
    ).toBeTruthy();
    expect(within(section).getByText("This run called no tool.")).toBeTruthy();
    expect(screen.queryByTestId("cost-model-row")).toBeNull();
    expect(screen.queryByTestId("cost-tool-row")).toBeNull();
    expect(within(section).queryByRole("table")).toBeNull();
  });

  it("says the rollup has not run rather than printing zeros (negative)", () => {
    const section = renderCost(readOk({ rollup: null }));
    expect(screen.getByTestId("cost-not-rolled-up")).toHaveTextContent(
      "A zero here would be a measurement",
    );
    expect(within(section).queryByText("Total")).toBeNull();
  });

  it("names the code a failed read answered, in place of the rollup (negative)", () => {
    const section = renderCost(readError("clickhouse_unavailable", 503));
    expect(section).toHaveTextContent(
      "Cost could not be loaded: the control plane answered clickhouse_unavailable.",
    );
    expect(screen.queryByTestId("cost-not-rolled-up")).toBeNull();
    expect(within(section).queryByText("Total")).toBeNull();
    expect(screen.getByRole("region", { name: "Run waterfall" })).toBeTruthy();
  });
});
