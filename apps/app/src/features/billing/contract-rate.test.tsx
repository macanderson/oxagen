// @vitest-environment jsdom
// The rate block prints the contract's figures for a negotiated customer and
// for a published-tier one: the rate at exact precision, the block price, the
// block size (also as data-block-size), the currency, the GAUs included each
// month, the effective dates and the source; and a denial or an error in
// place of the figures. Axe runs in every state.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { contractRate, PUBLISHED_BUILD } from "./billing.builders";
import { ContractRateBlock } from "./contract-rate";

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

function renderBlock(element: ReactElement) {
  render(<IntlProvider>{element}</IntlProvider>);
  return screen.getByRole("region", { name: "Your contracted rate" });
}

const fact = (block: HTMLElement, name: string) => {
  const found = block.querySelector(`[data-fact="${name}"] dd`);
  if (found === null) throw new Error(`no ${name} fact`);
  return found;
};

describe("ContractRateBlock", () => {
  it("prints a negotiated agreement's terms", () => {
    const block = renderBlock(
      <ContractRateBlock rate={readOk(contractRate())} />,
    );
    expect(fact(block, "rate")).toHaveTextContent(/^\$0\.00321$/);
    expect(fact(block, "block-price")).toHaveTextContent(/^\$32\.10$/);
    expect(fact(block, "block-size")).toHaveTextContent(/^10,000 GAU$/);
    expect(block).toHaveAttribute("data-block-size", "10000");
    expect(fact(block, "currency")).toHaveTextContent(/^USD$/);
    expect(fact(block, "included")).toHaveTextContent(/^250,000 GAU$/);
    expect(fact(block, "effective")).toHaveTextContent(
      /^Jan 1, 2026 – Jan 1, 2027$/,
    );
    expect(fact(block, "source")).toHaveTextContent(
      /^Negotiated agreement MSA-2026-014$/,
    );
  });

  it("prints a published tier's terms, open-ended", () => {
    const block = renderBlock(
      <ContractRateBlock rate={readOk(PUBLISHED_BUILD)} />,
    );
    expect(fact(block, "rate")).toHaveTextContent(/^\$0\.005$/);
    expect(fact(block, "block-price")).toHaveTextContent(/^\$25\.00$/);
    expect(fact(block, "block-size")).toHaveTextContent(/^5,000 GAU$/);
    expect(block).toHaveAttribute("data-block-size", "5000");
    expect(fact(block, "included")).toHaveTextContent(/^50,000 GAU$/);
    expect(fact(block, "effective")).toHaveTextContent(/^from Sep 1, 2026$/);
    expect(fact(block, "source")).toHaveTextContent(/^Published Build rate$/);
  });

  it("names a negotiated agreement with no reference without inventing one", () => {
    const block = renderBlock(
      <ContractRateBlock rate={readOk(contractRate({ agreementRef: null }))} />,
    );
    expect(fact(block, "source")).toHaveTextContent(/^Negotiated agreement$/);
  });

  it("prints money only in the rate and the block price", () => {
    const block = renderBlock(
      <ContractRateBlock rate={readOk(contractRate())} />,
    );
    expect(
      [...block.querySelectorAll("[data-testid=money]")].map((money) =>
        money.closest("[data-fact]")?.getAttribute("data-fact"),
      ),
    ).toEqual(["rate", "block-price"]);
  });

  it("shows the denial for a Member in place of the figures (negative)", () => {
    const block = renderBlock(
      <ContractRateBlock
        rate={{ ok: false, reason: "denied", permission: "org.billing" }}
      />,
    );
    expect(block.querySelector("[data-reason=denied]")).toHaveTextContent(
      "Your role does not include org.billing",
    );
    expect(block).not.toHaveAttribute("data-block-size");
    expect(screen.queryByTestId("money")).toBeNull();
  });

  it("shows the error code in place of the figures (negative)", () => {
    const block = renderBlock(
      <ContractRateBlock rate={readError("stripe_unreachable", 502)} />,
    );
    expect(block.querySelector("[data-reason=error]")).toHaveTextContent(
      "the billing service answered stripe_unreachable",
    );
    expect(screen.queryByTestId("money")).toBeNull();
  });
});
