// @vitest-environment jsdom
// This period and the four tiles (this-period.tsx, summary.tsx) over a
// statement whose every line is recorded. The page hands statementFor a null
// discount until the onboarding offer has a store (#3845), so billing.test.tsx
// only ever sees the "not recorded" total. These tests pin what the table and
// the Due tile print on the day that store lands: the discount as money, the
// total with its currency, and the tile equal to the line. They also draw the
// governed-action basis for a purchase that is not whole blocks, the one
// ChargeBasis kind the page tests never assert. Every test ends in an axe
// check (INV-26).
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Money } from "@/data/contracts/money";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  contractRate,
  evidenceRetention,
  prepaidBucket,
  SUBSCRIPTION,
} from "./billing.builders";
import { type Statement, statementFor } from "./statement";
import { SummaryTiles } from "./summary";
import { ThisPeriod } from "./this-period";

const usd = (micros: string): Money => ({ micros, currency: "USD" });

/** 159 blocks of 10,000 at $32.10 a block: $5,103.90 on the first line. */
const BLOCKS = prepaidBucket({
  includedGau: 250_000,
  purchasedGau: 1_590_000,
  carriedGau: 0,
  usedGau: 1_837_838,
  remainingGau: 2_162,
});

function renderStatement(statement: Statement) {
  const retention = evidenceRetention();
  render(
    <IntlProvider>
      <SummaryTiles
        plan={{ subscription: SUBSCRIPTION }}
        rate={contractRate({ tier: "build" })}
        retention={retention}
        statement={statement}
        periodEnd={BLOCKS.period.end}
      />
      <ThisPeriod statement={statement} retention={retention} />
    </IntlProvider>,
  );
}

const line = (name: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-line="${name}"]`);
  if (found === null) throw new Error(`no ${name} line`);
  return found;
};
const tile = (name: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-tile="${name}"]`);
  if (found === null) throw new Error(`no ${name} tile`);
  return found;
};

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("a statement whose every line is recorded", () => {
  it("prints the discount as money and the total with its currency, and nothing as not recorded", () => {
    renderStatement(
      statementFor({
        bucket: BLOCKS,
        rate: contractRate(),
        retention: evidenceRetention(),
        discount: usd("-500000000"),
      }),
    );
    expect(line("discount")).toHaveTextContent(/-\$500\.00$/);
    // $5,103.90 - $500.00 = $4,603.90, rounded once.
    expect(line("total")).toHaveTextContent(/\$4,603\.90 USD$/);
    expect(
      document.querySelector("[data-line] [data-recorded=false]"),
    ).toBeNull();
  });

  it("prints on the Due tile the same total the Total line prints", () => {
    renderStatement(
      statementFor({
        bucket: BLOCKS,
        rate: contractRate(),
        retention: evidenceRetention(),
        discount: usd("0"),
      }),
    );
    const due = tile("due").querySelector("dd")?.textContent;
    expect(due).toBe("$5,103.90");
    expect(line("total")).toHaveTextContent(`${due ?? "missing"} USD`);
    expect(tile("due").querySelector("[data-recorded=false]")).toBeNull();
    expect(tile("due")).toHaveTextContent(
      "USD · after the onboarding discount",
    );
  });

  it("still says the total is not recorded when only retention is unrecorded (negative)", () => {
    renderStatement(
      statementFor({
        bucket: BLOCKS,
        rate: contractRate(),
        retention: evidenceRetention({ extendedRetentionEnabled: true }),
        discount: usd("0"),
      }),
    );
    expect(line("discount")).toHaveTextContent(/\$0\.00$/);
    expect(line("total")).toHaveTextContent(/not recorded$/);
    expect(tile("due")).toHaveTextContent("not recorded");
  });
});

describe("a purchase that is not whole blocks", () => {
  it("prices the line at the per-action rate, and the tile prints the count the line is labelled with", () => {
    renderStatement(
      statementFor({
        bucket: prepaidBucket({ purchasedGau: 5_000 }),
        rate: contractRate(),
        retention: evidenceRetention(),
        discount: null,
      }),
    );
    // 5,000 at $0.00321 = $16.05.
    expect(line("governed")).toHaveTextContent(
      "Governed actions 1 – 5,0005,000 bought at $0.00321 each · 50,000 included$16.05",
    );
    expect(tile("governed").querySelector("dd")).toHaveTextContent(/^5,000$/);
    expect(tile("governed")).toHaveTextContent(
      "5,000 bought at $0.00321 each · 50,000 included",
    );
  });
});
