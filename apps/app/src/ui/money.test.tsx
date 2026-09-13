// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Money } from "./money";
import { InvalidMoneyError } from "./money-format";
import { renderWithIntl } from "./testing/render-with-intl";

afterEach(() => {
  cleanup();
});

describe("<Money>", () => {
  it("formats micros and shows the basis beside an inline figure", () => {
    renderWithIntl(
      <Money
        value={{
          micros: "2450000000",
          currency: "USD",
          basis: "gateway_observed",
        }}
      />,
    );
    const money = screen.getByTestId("money");
    expect(money).toHaveTextContent("$2,450.00");
    expect(money).toHaveTextContent("gateway_observed");
    expect(money).toHaveAttribute("data-basis", "gateway_observed");
  });

  it("says the basis was not recorded rather than implying one", () => {
    renderWithIntl(<Money value={{ micros: "-1500000", currency: "USD" }} />);
    const money = screen.getByTestId("money");
    expect(money).toHaveTextContent("-$1.50");
    expect(money).toHaveTextContent("basis not recorded");
  });

  it("can omit the basis where a header states it once", () => {
    renderWithIntl(
      <Money
        showBasis={false}
        value={{ micros: "41265", currency: "USD", basis: "estimated" }}
        precision="exact"
      />,
    );
    expect(screen.getByTestId("money")).toHaveTextContent(/^\$0\.041265$/);
  });

  it("formats in the viewer's locale and currency", () => {
    renderWithIntl(
      <Money
        value={{ micros: "2450000000", currency: "EUR", basis: "mixed" }}
      />,
      { locale: "de" },
    );
    expect(screen.getByTestId("money")).toHaveTextContent("2.450,00 €");
  });

  it("throws on a display string instead of rendering a silent zero", () => {
    expect(() =>
      renderWithIntl(<Money value={{ micros: "2,450.00", currency: "USD" }} />),
    ).toThrow(InvalidMoneyError);
  });

  it("opens the basis dialog from the large figure with the exact amount", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <Money
        variant="large"
        value={{ micros: "4131265", currency: "USD", basis: "client_attested" }}
      />,
    );
    expect(screen.getByTestId("money")).toHaveTextContent("$4.13");
    await user.click(
      screen.getByRole("button", {
        name: "client_attested: how $4.13 was measured",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "How this figure was measured",
    });
    expect(dialog).toHaveTextContent("$4.131265 (USD)");
    const current = dialog.querySelector("[data-current]");
    expect(current).not.toBeNull();
    expect(
      within(current as HTMLElement).getByText("client_attested"),
    ).toBeVisible();
    expect(dialog.querySelectorAll("li")).toHaveLength(4);
  });

  it("marks an unrecorded basis as the current one in the dialog", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <Money variant="large" value={{ micros: "0", currency: "USD" }} />,
    );
    // Label in Name: the visible basis text starts the accessible name.
    await user.click(
      screen.getByRole("button", { name: /^basis not recorded: how / }),
    );
    const dialog = await screen.findByRole("dialog");
    const current = dialog.querySelectorAll("[data-current]");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(
      "No basis was recorded for this figure.",
    );
  });

  it("starts the trigger's accessible name with the visible basis label", () => {
    renderWithIntl(
      <Money
        variant="large"
        value={{
          micros: "2450000000",
          currency: "USD",
          basis: "gateway_observed",
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: /gateway_observed/ });
    expect(trigger).toHaveTextContent("gateway_observed");
    expect(trigger).toHaveAccessibleName(
      "gateway_observed: how $2,450.00 was measured",
    );
  });

  it("renders the large figure without a dialog when the basis is hidden", () => {
    renderWithIntl(
      <Money
        variant="large"
        showBasis={false}
        value={{ micros: "1000000", currency: "USD", basis: "estimated" }}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
