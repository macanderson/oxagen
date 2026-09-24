// @vitest-environment jsdom
// Fleet's loading state (fleet.md, States: loading): the shell stays and the
// page body is the skeleton, four tile blocks and a panel of seven rows. No
// figure, no zero and no stale row is drawn while the reads are in flight.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { FleetLoading } from "./loading";

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("FleetLoading", () => {
  it("draws four tile blocks and seven rows, and announces the load", () => {
    render(
      <IntlProvider>
        <FleetLoading />
      </IntlProvider>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading the fleet");
    expect(screen.getAllByTestId("skeleton-tile")).toHaveLength(4);
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(7);
  });

  it("draws no heading, no figure and no table (negative)", () => {
    const { container } = render(
      <IntlProvider>
        <FleetLoading />
      </IntlProvider>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.textContent).toBe("Loading the fleet");
  });
});
