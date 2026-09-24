// @vitest-environment jsdom
// The Cost tab's section on its own: the rollup's figures, its two breakdowns
// and the read's refusal, each drawn from a `Read<RunCost>` with no page
// around it.
//
// The rule these hold is the file's own: a figure the rollup did not carry
// reads "not recorded", never a zero, because a zero is a figure the rollup
// measured and a missing one is not. The Run page's own tests
// (`run.test.tsx`) prove the tab reads the rollup once and draws the happy
// path; these prove every null the contract allows is said in words.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunCost, RunCostRollup } from "@/data/contracts/run";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { CostSection } from "./cost";
import { runCost, runTranscript } from "./run.builders";

afterEach(cleanup);

/** The default rollup with some of its fields replaced. */
function rollup(overrides: Partial<RunCostRollup>): RunCost {
  const base = runCost().rollup;
  if (base === null) throw new Error("the builder's default rollup is null");
  return { rollup: { ...base, ...overrides } };
}

function renderCost(read: Read<RunCost>) {
  return render(
    <IntlProvider>
      <CostSection
        read={read}
        turns={readOk(runTranscript({ zoom: "turns" }))}
        steps={readOk(runTranscript({ zoom: "steps" }))}
      />
    </IntlProvider>,
  );
}

/** The `<dd>` a fact's label introduces. */
function fact(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) {
    throw new Error(`no value follows the fact "${label}"`);
  }
  return value;
}

describe("CostSection", () => {
  it("says not recorded for every figure the rollup did not carry, rather than printing a zero", async () => {
    const { container } = renderCost(
      readOk(
        rollup({
          cost: null,
          cacheHitRate: null,
          turns: null,
          retries: null,
          productiveRatio: null,
          priceEntryIds: [],
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
    ]) {
      expect(fact(label)).toHaveTextContent(/^not recorded$/);
    }
    // The counts the contract always carries are still printed as counts.
    expect(fact("Steps")).toHaveTextContent(/^96$/);
    expect(fact("Model calls")).toHaveTextContent(/^54$/);
    expect(fact("Tool calls")).toHaveTextContent(/^42$/);
    const section = screen.getByRole("region", { name: "Cost" });
    expect(section).not.toHaveTextContent("$0");
    expect(section).not.toHaveTextContent("0%");
    await expectNoAxe(container);
  });

  it("prints each carried figure with its own formatting and every price entry the frames used", () => {
    renderCost(
      readOk(
        rollup({
          priceEntryIds: ["prc_01k4qj9e", "prc_01k4qjb2"],
          retries: 0,
        }),
      ),
    );
    expect(fact("Total")).toHaveTextContent("gateway_observed");
    expect(fact("Cache hit rate")).toHaveTextContent(/^83%$/);
    expect(fact("Productive ratio")).toHaveTextContent(/^71%$/);
    expect(fact("Turns")).toHaveTextContent(/^12$/);
    // A zero the rollup measured is a figure, and prints as one.
    expect(fact("Retries")).toHaveTextContent(/^0$/);
    expect(fact("Priced with")).toHaveTextContent(
      /^prc_01k4qj9e, prc_01k4qjb2$/,
    );
  });

  it("says the basis was not recorded when the total carries none", () => {
    renderCost(
      readOk(
        rollup({ cost: { micros: "4131265", currency: "USD", basis: null } }),
      ),
    );
    const total = fact("Total");
    // The figure itself was carried, so it prints; only its basis is missing.
    expect(total).toHaveTextContent(/^\$4\.13\d*\s*basis not recorded$/);
    expect(total).not.toHaveTextContent("gateway_observed");
  });

  it("says no model call was priced and no tool was called when both breakdowns are empty", async () => {
    const { container } = renderCost(
      readOk(rollup({ byModel: [], byTool: [] })),
    );
    expect(
      screen.getByText("No model call in this run was priced."),
    ).toBeInTheDocument();
    expect(screen.getByText("This run called no tool.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "By model" })).toBeNull();
    expect(screen.queryByRole("table", { name: "By tool" })).toBeNull();
    expect(screen.queryByTestId("cost-model-row")).toBeNull();
    expect(screen.queryByTestId("cost-tool-row")).toBeNull();
    await expectNoAxe(container);
  });

  it("leaves out a model's provider it was not told and says not recorded for a model call it could not price", async () => {
    const base = runCost().rollup;
    if (base === null) throw new Error("the builder's default rollup is null");
    const { container } = renderCost(
      readOk(
        rollup({
          byModel: [
            {
              model: "gpt-5.1-mini",
              provider: null,
              calls: 7,
              cost: null,
              tokens: base.tokens,
            },
          ],
        }),
      ),
    );
    const row = screen.getByTestId("cost-model-row");
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent(/^gpt-5\.1-mini$/);
    expect(cells[1]).toHaveTextContent(/^7$/);
    expect(cells[2]).toHaveTextContent(/^not recorded$/);
    expect(row).not.toHaveTextContent("anthropic");
    expect(row).not.toHaveTextContent("$");
    await expectNoAxe(container);
  });

  it("names the provider under the model and prints what the model's calls cost", () => {
    renderCost(readOk(runCost()));
    const cells = within(screen.getByTestId("cost-model-row")).getAllByRole(
      "cell",
    );
    expect(cells[0]).toHaveTextContent("claude-opus-5");
    expect(cells[0]).toHaveTextContent("anthropic");
    expect(cells[2]).toHaveTextContent("$4.13");
  });

  it("says the rollup has not been built yet, with no figure and no breakdown, before the run seals", async () => {
    const { container } = renderCost(readOk({ rollup: null }));
    expect(screen.getByTestId("cost-not-rolled-up")).toHaveTextContent(
      "The rollup has not rebuilt this run yet.",
    );
    expect(screen.queryByText("Total", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("By model")).toBeNull();
    await expectNoAxe(container);
  });

  it.each<[string, Read<RunCost>, RegExp]>([
    [
      "denied",
      { ok: false, reason: "denied", permission: "run.read" },
      /You cannot see Cost in this workspace.*run\.read/,
    ],
    [
      "pending_approval",
      { ok: false, reason: "pending_approval", accessRequestId: "arq_42" },
      /Access to Cost is waiting for approval, request arq_42/,
    ],
    [
      "error",
      readError("cost_rollup_unreachable", 502),
      /Cost could not be loaded: the control plane answered cost_rollup_unreachable/,
    ],
  ])(
    "replaces the rollup with the %s refusal and still draws the waterfall (negative)",
    async (reason, read, sentence) => {
      const { container } = renderCost(read);
      const section = screen.getByRole("region", { name: "Cost" });
      const failure = section.querySelector(`[data-reason="${reason}"]`);
      expect(failure).not.toBeNull();
      expect(failure).toHaveTextContent(sentence);
      expect(within(section).queryByText("Total")).toBeNull();
      expect(screen.queryByTestId("cost-not-rolled-up")).toBeNull();
      expect(
        screen.getByRole("region", { name: "Run waterfall" }),
      ).toBeInTheDocument();
      await expectNoAxe(container);
    },
  );
});
