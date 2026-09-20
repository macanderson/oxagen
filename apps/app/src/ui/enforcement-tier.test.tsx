// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { EnforcementTierBadge } from "./enforcement-tier";

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("EnforcementTierBadge", () => {
  it.each([
    ["gateway", "observed at the gateway"],
    ["harness", "observed at the harness"],
    ["observe", "observed from the side"],
  ] as const)("draws the recorded %s tier as its own word", (tier, word) => {
    render(
      <IntlProvider>
        <EnforcementTierBadge tier={tier} />
      </IntlProvider>,
    );
    const badge = screen.getByText(word);
    expect(badge).toHaveAttribute("data-tier", tier);
  });

  it("carries the caller's test id, and none when the caller names none (negative)", () => {
    const { rerender } = render(
      <IntlProvider>
        <EnforcementTierBadge tier="observe" testId="run-tier" />
      </IntlProvider>,
    );
    expect(screen.getByTestId("run-tier")).toHaveTextContent(
      "observed from the side",
    );
    rerender(
      <IntlProvider>
        <EnforcementTierBadge tier="observe" />
      </IntlProvider>,
    );
    expect(screen.queryByTestId("run-tier")).toBeNull();
  });
});
