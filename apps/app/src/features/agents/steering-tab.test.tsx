// @vitest-environment jsdom
// The Steering tab drawn on its own (steering-tab.tsx), for the states the
// page test in agent.test.tsx does not reach: a deliveries read that failed,
// an identity with no agent key, the newest of several manifests, and a
// manifest with a zero budget. Axe runs after every test (INV-26).
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runRow, steeringDeliveries } from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { SteeringSection } = await import("./steering-tab");

type Props = ComponentProps<typeof SteeringSection>;

function renderSteering(overrides: Partial<Props> = {}) {
  const props: Props = {
    deliveries: steeringDeliveries(),
    agentKey: "acme.core.release-bot",
    lastRun: runRow(),
    org: "acme",
    ws: "core-platform",
    ...overrides,
  };
  render(
    <IntlProvider>
      <SteeringSection {...props} />
    </IntlProvider>,
  );
}

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("SteeringSection", () => {
  it("names the failed deliveries read and draws no meter (negative)", () => {
    renderSteering({ deliveries: readError("steering_unavailable", 503) });
    expect(
      screen.getByRole("region", { name: "What reaches this agent" }),
    ).toHaveTextContent(
      "What reaches this agent could not be loaded: the control plane answered steering_unavailable.",
    );
    expect(screen.queryByTestId("steering-budget")).toBeNull();
  });

  it("is the empty state for an identity with no agent key, whatever was delivered (negative)", () => {
    renderSteering({ agentKey: null });
    expect(screen.getByTestId("steering-empty")).toHaveTextContent(
      "No steering is assembled for this agent",
    );
  });

  it("shows the newest of this agent's manifests and ignores another agent's", () => {
    renderSteering({
      deliveries: steeringDeliveries([
        { ts: "2026-09-14T08:00:00.000Z", spentTokens: 1000 },
        {
          ts: "2026-09-16T08:00:00.000Z",
          agentKey: "acme.core.other-bot",
          spentTokens: 9999,
        },
        { ts: "2026-09-15T08:00:00.000Z", spentTokens: 3100 },
      ]),
    });
    expect(screen.getByTestId("steering-budget")).toHaveTextContent(
      "3,100 of 4,000 tok",
    );
  });

  it("draws an empty bar for a manifest with a zero budget rather than dividing by it (negative)", () => {
    renderSteering({
      deliveries: steeringDeliveries([{ budgetTokens: 0, spentTokens: 0 }]),
    });
    expect(screen.getByTestId("steering-budget")).toHaveTextContent(
      "0 of 0 tok",
    );
    const bar = screen
      .getByTestId("steering-budget")
      .closest("section")
      ?.querySelector<HTMLElement>("[aria-hidden] > span");
    expect(bar?.style.width).toBe("0%");
  });
});
