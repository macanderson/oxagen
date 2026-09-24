// @vitest-environment jsdom
// The shared scope cell in each state the view model produces: a list of
// patterns, the unrestricted `*`, and the empty list the contract admits.
// Shared by the Tools ledger and the Agents table, so it is pinned here rather
// than through either page.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { MandateScope } from "./mandate-scope";

afterEach(cleanup);

const draw = (tools: string[], inline = false) =>
  render(
    <IntlProvider>
      <MandateScope tools={tools} inline={inline} />
    </IntlProvider>,
  );

describe("MandateScope", () => {
  it("lists the patterns a mandate was granted over", async () => {
    const { container } = draw(["payments.read@*", "payments.list@2"]);
    expect(screen.getByText("payments.read@*")).toBeInTheDocument();
    expect(screen.getByText("payments.list@2")).toBeInTheDocument();
    expect(screen.queryByText("every tool")).toBeNull();
    await expectNoAxe(container);
  });

  // One character is the difference between an agent that may call a single
  // tool and one that may call everything, and a reader reviewing what they
  // granted should not have to notice it among a list of patterns.
  it("names an unrestricted mandate rather than printing the asterisk", async () => {
    const { container } = draw(["*"]);
    expect(screen.getByText("every tool")).toHaveAttribute(
      "data-scope",
      "every-tool",
    );
    expect(screen.queryByText("*")).toBeNull();
    await expectNoAxe(container);
  });

  // `*` anywhere in the list is unrestricted, whatever else it carries: a
  // narrower pattern beside it narrows nothing.
  it("is unrestricted when the asterisk sits beside a narrower pattern", () => {
    draw(["payments.read@*", "*"]);
    expect(screen.getByText("every tool")).toBeInTheDocument();
    expect(screen.queryByText("payments.read@*")).toBeNull();
  });

  // An empty cell is ambiguous between "covers nothing" and "not shown". The
  // view model admits the empty list, so the cell says which it is.
  it("says a mandate covers no tool rather than rendering an empty cell", async () => {
    const { container } = draw([]);
    expect(screen.getByText("covers no tool")).toHaveAttribute(
      "data-scope",
      "no-tool",
    );
    await expectNoAxe(container);
  });

  // The Grant panel prints the patterns on one line, joined as the design
  // joins them, and still names an unrestricted mandate.
  it("joins the patterns with commas on one line when inline", async () => {
    const { container } = draw(["payments.read@*", "payments.list@2"], true);
    expect(
      screen.getByText("payments.read@*, payments.list@2"),
    ).toHaveAttribute("data-scope", "patterns");
    expect(container.querySelector("ul")).toBeNull();
    await expectNoAxe(container);
  });

  it("names an unrestricted mandate when inline too", () => {
    draw(["*"], true);
    expect(screen.getByText("every tool")).toBeInTheDocument();
  });
});
