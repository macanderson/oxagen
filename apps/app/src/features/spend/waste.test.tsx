// @vitest-environment jsdom
// The Wasted spend tab when little or nothing is recorded: every tile says
// "not recorded" rather than printing a zero it was not given, a period with
// no waste says so, and a cause recorded against an unknown total draws no
// share bar it cannot compute. Retry loops read from the open findings.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type {
  SpendFinding,
  SpendReport,
  SpendWaste,
} from "@/data/contracts/spend";
import { IntlProvider } from "@/test/intl";
import { WasteSection } from "./waste";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const AT = { org: "acme", ws: "core-platform" };

const MONTH: SpendReport = {
  period: { from: "2026-09-01", to: "2026-09-15" },
  total: {
    cost: null,
    calls: 0,
    runs: 12,
    proven: null,
    accepted: null,
    productiveRatio: null,
  },
  rows: [],
};

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const NOTHING: SpendWaste = {
  wasted: null,
  share: null,
  runsWithWaste: 0,
  largestCause: null,
  causes: [],
};

function waste(value: SpendWaste, findings: SpendFinding[] | null = []) {
  render(
    <IntlProvider>
      <WasteSection
        waste={value}
        findings={findings}
        month={MONTH}
        at={AT}
      />
    </IntlProvider>,
  );
}

function retryLoop(over: Partial<SpendFinding> = {}): SpendFinding {
  return {
    id: "fnd_01k5rn8f3j",
    kind: "retry_loops",
    level: "agent",
    subject: "acme.core.triage",
    saving: { micros: "30000", currency: "USD", basis: "gateway_observed" },
    confidence: "high",
    window: {
      from: "2026-08-16T00:00:00.000Z",
      to: "2026-09-15T00:00:00.000Z",
    },
    why: "On 2 runs, a call failed 3 or more times in a row with the same error.",
    fix: "Tell the agent to read the error before it tries again.",
    runs: 2,
    calls: 3,
    ...over,
  };
}

function retryRow(): Element | null {
  return document.querySelector('li[data-cause="retryLoops"]');
}

describe("Wasted spend", () => {
  it("says not recorded for the amount and share, no cause, and no run with waste", () => {
    waste({
      wasted: null,
      share: null,
      runsWithWaste: 0,
      largestCause: null,
      causes: [],
    });
    expect(
      document.querySelectorAll('[data-recorded="false"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("No waste found")).toBeTruthy();
    expect(
      screen.getByText("No run in this period shows waste in its frames."),
    ).toBeTruthy();
    expect(document.body).not.toHaveTextContent("$0");
  });

  it("draws a recorded cause with an empty share bar when the total wasted is not recorded, and no largest cause it cannot find", () => {
    waste({
      wasted: null,
      share: 0.1,
      runsWithWaste: 1,
      largestCause: "cache_write_never_read",
      causes: [
        {
          cause: "cache_write_never_read",
          wasted: {
            micros: "1000000",
            currency: "USD",
            basis: "gateway_observed",
          },
          runs: 1,
          provingRuns: [{ runId: "arun_01k5rn8f3j", name: null }],
        },
      ],
    });
    const cause = document.querySelector(
      'li[data-cause="cache_write_never_read"]',
    );
    expect(
      cause?.querySelector('[style*="width"]')?.getAttribute("style"),
    ).toContain("width: 0%");
    expect(screen.getByText("arun_01k5rn8f3j", { exact: false })).toBeTruthy();
    expect(screen.getByText("Untitled session")).toBeTruthy();

    cleanup();
    waste({
      wasted: null,
      share: null,
      runsWithWaste: 0,
      largestCause: "cache_write_never_read",
      causes: [],
    });
    expect(screen.getByText("No waste found")).toBeTruthy();
  });

  it("shows retry loops as recorded, from the open retry_loops findings, with a link to them", () => {
    waste(NOTHING, [
      retryLoop(),
      retryLoop({
        id: "fnd_01k5rn8f3k",
        subject: "acme.core.build",
        saving: { micros: "20000", currency: "USD", basis: "gateway_observed" },
        runs: 1,
      }),
      retryLoop({ id: "fnd_01k5rn8f3m", kind: "spin_loops", runs: 9 }),
    ]);
    const row = retryRow();
    expect(row?.getAttribute("data-recorded")).toBe("true");
    expect(row).toHaveTextContent("$0.05");
    expect(row).toHaveTextContent("3 runs");
    expect(
      row?.querySelector("a")?.getAttribute("href"),
    ).toBe("/acme/core-platform/spend/findings");
    // The other five causes the design meters stay not recorded.
    expect(
      document.querySelectorAll('li[data-recorded="false"]').length,
    ).toBe(5);
  });

  it("says no retry loop was found when no retry_loops finding is open, rather than printing a zero", () => {
    waste(NOTHING, [retryLoop({ kind: "spin_loops" })]);
    const row = retryRow();
    expect(row?.getAttribute("data-recorded")).toBe("true");
    expect(row).toHaveTextContent("No retry loop found");
    expect(row).not.toHaveTextContent("$0");
  });

  it("leaves retry loops not recorded when the findings read did not answer", () => {
    waste(NOTHING, null);
    expect(retryRow()?.getAttribute("data-recorded")).toBe("false");
    expect(retryRow()).toHaveTextContent("not recorded");
  });
});
