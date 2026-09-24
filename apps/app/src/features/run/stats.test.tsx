// @vitest-environment jsdom
// The Run page's six-figure stat row (`StatRow`, spec pages/run.md, INV-10),
// over hand-built reads. The page test in run.test.tsx renders it with the one
// rollup its builder carries, so the Cost box is only ever proven on a
// gateway-observed rollup. These hold the other places its figure can come
// from, because each is a different claim about who measured the money:
//
// - the rollup's cost, captioned with its basis;
// - the run row's cost, when the rollup priced nothing or has not run;
// - the agent's own report, captioned provisional, when neither holds one;
// - nothing, which reads "not recorded" and carries no caption at all.
//
// The row also says "no rollup yet" where the rollup is missing and a live
// run's wall clock "so far".
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunCost, RunTranscript } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  NOW,
  runCost,
  runRow,
  runTranscript,
  transcriptEntry,
} from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
}));

const { StatRow } = await import("./stats");

afterEach(cleanup);

const usd = (
  micros: string,
  basis: "gateway_observed" | "client_attested" | null = "gateway_observed",
) => ({ micros, currency: "USD" as const, basis });

function renderStats({
  run = runRow(),
  cost = readOk(runCost()),
  transcript = readOk(runTranscript()),
  at = NOW,
}: {
  run?: RunRow;
  cost?: Read<RunCost>;
  transcript?: Read<RunTranscript>;
  at?: number;
}) {
  return render(
    <IntlProvider>
      <StatRow run={run} cost={cost} transcript={transcript} at={at} />
    </IntlProvider>,
  );
}

/** The stat tile whose label is `label`. */
function tile(label: string): HTMLElement {
  const term = within(screen.getByTestId("run-stats")).getByText(label);
  const box = term.parentElement;
  if (box === null) throw new Error(`${label} sits in a tile`);
  return box;
}

function rollupWith(overrides: Partial<NonNullable<RunCost["rollup"]>>) {
  const base = runCost().rollup;
  if (base === null) throw new Error("the builder carries a rollup");
  return readOk({ rollup: { ...base, ...overrides } });
}

describe("StatRow › the Cost box", () => {
  it("prints the rollup's cost over the run row's, captioned with the rollup's basis", () => {
    renderStats({
      run: runRow({ cost: usd("9990000", "client_attested") }),
      cost: rollupWith({ cost: usd("4131265") }),
    });
    expect(tile("Cost")).toHaveTextContent("$4.13");
    expect(tile("Cost")).toHaveTextContent("gateway_observed");
    expect(tile("Cost")).not.toHaveTextContent("$9.99");
  });

  it("falls back to the run row's cost when the rollup priced nothing, with the row's own basis", () => {
    renderStats({
      run: runRow({ cost: usd("2500000", "client_attested") }),
      cost: rollupWith({ cost: null }),
    });
    expect(tile("Cost")).toHaveTextContent("$2.50");
    expect(tile("Cost")).toHaveTextContent("client_attested");
  });

  it("says the basis is not recorded rather than borrowing one (negative)", () => {
    renderStats({
      run: runRow({ cost: usd("2500000", null) }),
      cost: readOk({ rollup: null }),
    });
    expect(tile("Cost")).toHaveTextContent("$2.50");
    expect(tile("Cost")).toHaveTextContent("basis not recorded");
    expect(tile("Cost")).not.toHaveTextContent("gateway_observed");
  });

  it("prints the agent's own report as provisional when neither the rollup nor the run row holds a cost", () => {
    renderStats({
      run: runRow({ cost: null, reportedCost: usd("700000", null) }),
      cost: readOk({ rollup: null }),
    });
    expect(tile("Cost")).toHaveTextContent("$0.70");
    expect(tile("Cost")).toHaveTextContent(
      "Agent reported. Provisional until finalized.",
    );
  });

  it("prints not recorded and no caption when nothing holds a cost, never $0.00 (negative)", () => {
    renderStats({
      run: runRow({ cost: null, reportedCost: null }),
      cost: readOk({ rollup: null }),
    });
    expect(tile("Cost")).toHaveTextContent(/^Costnot recorded$/);
  });

  it("keeps the run row's cost when the cost read was refused", () => {
    renderStats({
      run: runRow({ cost: usd("4131265") }),
      cost: readError("rollup_unreachable", 502),
    });
    expect(tile("Cost")).toHaveTextContent("$4.13");
    // A refused read is not "no rollup yet": nothing says the rollup has not run.
    expect(screen.queryByText("no rollup yet")).toBeNull();
    expect(tile("Tokens")).toHaveTextContent(/^Tokensnot recorded$/);
  });
});

describe("StatRow › a run the rollup has not rebuilt", () => {
  it("says no rollup yet under Tokens and Cache hit, and prints no figure for either (negative)", async () => {
    const { container } = renderStats({ cost: readOk({ rollup: null }) });
    expect(tile("Tokens")).toHaveTextContent("not recorded");
    expect(tile("Tokens")).toHaveTextContent("no rollup yet");
    expect(tile("Cache hit")).toHaveTextContent("not recorded");
    expect(tile("Cache hit")).toHaveTextContent("no rollup yet");
    expect(tile("Cache hit")).not.toHaveTextContent("saving not recorded");
    await expectNoAxe(container);
  });

  it("prints not recorded for a rollup with no cache hit rate", () => {
    renderStats({ cost: rollupWith({ cacheHitRate: null }) });
    expect(tile("Cache hit")).toHaveTextContent("not recorded");
    expect(tile("Cache hit")).toHaveTextContent("saving not recorded");
  });
});

describe("StatRow › prompts", () => {
  it("says no prompt was recorded for a run whose transcript holds none", () => {
    renderStats({
      transcript: readOk(runTranscript({ entries: [transcriptEntry()] })),
    });
    expect(tile("Prompts")).toHaveTextContent("0");
    expect(tile("Prompts")).toHaveTextContent("no prompt recorded");
    expect(tile("Wasted")).toHaveTextContent("cause not recorded (G3)");
  });

  it("prints not recorded for Prompts when the transcript read failed, and Wasted names its gap (negative)", () => {
    renderStats({ transcript: readError("transcript_unreachable", 502) });
    expect(tile("Prompts")).toHaveTextContent(/^Promptsnot recorded$/);
    expect(tile("Wasted")).toHaveTextContent("cause not recorded (G3)");
  });
});

describe("StatRow › wall clock", () => {
  it("reads a live run against the page's instant and says so far", () => {
    renderStats({
      run: runRow({
        status: "live",
        sealedAt: null,
        startedAt: new Date(NOW - 90_000).toISOString(),
      }),
    });
    expect(tile("Wall clock")).toHaveTextContent("so far");
    expect(tile("Wall clock")).not.toHaveTextContent("split not recorded");
  });

  it("never prints a negative duration for a start the clock has not reached (negative)", () => {
    renderStats({
      run: runRow({
        status: "live",
        sealedAt: null,
        startedAt: new Date(NOW + 60_000).toISOString(),
      }),
    });
    expect(tile("Wall clock")).not.toHaveTextContent("-");
  });
});
