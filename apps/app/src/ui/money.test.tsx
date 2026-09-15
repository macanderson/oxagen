// @vitest-environment jsdom
// <Money> prints a Money at cents precision by default and at exact precision
// for a sub-cent rate, in the viewer's locale.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { Money } from "./money";

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("<Money>", () => {
  it("rounds to cents by default", () => {
    render(
      <IntlProvider>
        <Money value={{ micros: "4131265", currency: "USD" }} />
      </IntlProvider>,
    );
    expect(screen.getByTestId("money")).toHaveTextContent(/^\$4\.13$/);
  });

  it("prints every recorded micro-unit at exact precision", () => {
    render(
      <IntlProvider>
        <Money value={{ micros: "5000", currency: "USD" }} precision="exact" />
      </IntlProvider>,
    );
    expect(screen.getByTestId("money")).toHaveTextContent(/^\$0\.005$/);
  });
});
