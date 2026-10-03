// @vitest-environment jsdom
// A run a backfill rebuilt, on the Run page (ADR-161, #4028). The header
// marks it "Backfilled", and the Details drawer says how it was rebuilt. The
// governance panels it draws (the header's tier, the Policy tab's decisions,
// the seal's tier) read "not recorded", the seal reads "sealed at backfill",
// and the cost reads as the price book's estimate. A run a live session
// continued is marked "Partly backfilled" and keeps its panels, and a live
// run carries none of these marks.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunRow } from "@/data/contracts/runs";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  NOW,
  runChain,
  runDetail,
  runRow,
  runSource,
  runTranscript,
} from "./run.builders";

// jsdom has no layout, so it has no scrollIntoView; playback calls it.
Element.prototype.scrollIntoView = vi.fn();
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../run-outcomes/provider-actions", () => ({
  loadRunIssueProviders: vi.fn(),
  authorizeRunIssues: vi.fn(),
}));
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
  sealRun: vi.fn(),
  answerInterjection: vi.fn(),
}));
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return { getTranslations: (namespace?: string) => translator(namespace) };
});
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Run } = await import("./run");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/**
 * A run `oxagen agent backfill` rebuilt, as `get_run` answers it: sealed by
 * the pass's own `agent_stop`, on `observe`, graded `inspect`, and priced by
 * the rollup as an estimate.
 */
function backfilledRun(over: Partial<RunRow> = {}): RunRow {
  return runRow({
    recordBasis: "backfill",
    sealSource: "agent_stop",
    enforcementTier: "observe",
    replayGrade: "inspect",
    verdict: null,
    cost: { micros: "41312", currency: "USD", basis: "estimated" },
    reportedCost: null,
    ...over,
  });
}

async function renderRun(
  run: RunRow,
  tab: string | null = null,
  details: string | null = "run",
) {
  const { source } = runSource({
    detail: readOk(runDetail({ run })),
    transcript: readOk(runTranscript()),
    chain: readOk(runChain({ enforcementTier: run.enforcementTier })),
  });
  const element = await Run({
    ctx,
    source,
    runId: "tse_7k2m9q",
    tab,
    kinds: null,
    frames: null,
    body: null,
    reads: null,
    spine: null,
    details,
    now: NOW,
  });
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<IntlProvider>{element}</IntlProvider>));
    await Promise.resolve();
  });
  // The Details drawer, which holds the tier and the note, mounts after the
  // first render.
  if (details !== null) await screen.findByTestId("run-details");
  return container;
}

afterEach(cleanup);

describe("a backfilled run", () => {
  it("marks the header, dates the rebuild in Details, and shows no tier", async () => {
    const container = await renderRun(backfilledRun());
    expect(
      within(screen.getByTestId("run-header")).getByTestId("run-backfilled"),
    ).toHaveTextContent(/^Backfilled$/);
    const header = within(screen.getByTestId("run-details-run"));
    expect(header.getByTestId("run-backfill-note")).toHaveTextContent(
      /^Rebuilt from the Claude Code transcript on .*2026\. Nothing was enforced during this run\.$/,
    );
    const tier = header.getByTestId("run-tier");
    expect(tier).toHaveTextContent(/^tier not recorded$/);
    expect(tier).not.toHaveAttribute("data-tier");
    await expectNoAxe(container);
  });

  it("labels its cost an estimate in the stat row and on the Cost tab", async () => {
    const container = await renderRun(backfilledRun(), "cost");
    expect(
      within(screen.getByTestId("run-stat-cost")).getByText("estimated"),
    ).toBeTruthy();
    expect(screen.getByTestId("cost-backfill")).toHaveTextContent(
      /^Estimated\. Oxagen rebuilt this run from the Claude Code transcript/,
    );
    await expectNoAxe(container);
  });

  it("says its policy decisions are not recorded rather than that there were none", async () => {
    const container = await renderRun(backfilledRun(), "policy");
    const panel = within(screen.getByTestId("run-policy"));
    expect(panel.getByTestId("run-policy-backfilled")).toHaveTextContent(
      /^Not recorded\. /,
    );
    expect(
      panel.queryByText("No policy decision was recorded on this run."),
    ).toBeNull();
    expect(screen.queryAllByTestId("run-policy-decision")).toEqual([]);
    await expectNoAxe(container);
  });

  it("reads its seal as sealed at backfill, with no tier", async () => {
    const container = await renderRun(backfilledRun(), "chain");
    const seal = within(screen.getByTestId("chain-seal"));
    expect(seal.getByTestId("chain-sealed")).toHaveTextContent(
      /^sealed at backfill$/,
    );
    // The fact's value is the `dd` after its label.
    expect(
      seal.getByText("Enforcement tier").nextElementSibling,
    ).toHaveTextContent(/^not recorded$/);
    expect(
      screen.getByTestId("chain-seal").querySelector("[data-tier]"),
    ).toBeNull();
    await expectNoAxe(container);
  });

  it("names no date when the run was not sealed by the backfill's own stop (negative)", async () => {
    const container = await renderRun(
      backfilledRun({ sealSource: "idle_timeout" }),
    );
    expect(screen.getByTestId("run-backfill-note")).toHaveTextContent(
      /^Rebuilt from the Claude Code transcript\. Nothing was enforced during this run\.$/,
    );
    await expectNoAxe(container);
  });
});

describe("a backfilled run a live session continued", () => {
  it("is marked partly backfilled and keeps its tier and its policy panel", async () => {
    const run = backfilledRun({
      recordBasis: "mixed",
      enforcementTier: "harness",
      cost: { micros: "41312", currency: "USD", basis: "mixed" },
    });
    const container = await renderRun(run, "policy");
    expect(screen.getByTestId("run-backfilled")).toHaveTextContent(
      /^Partly backfilled$/,
    );
    expect(screen.getByTestId("run-backfill-note")).toHaveTextContent(
      "The start of this run was rebuilt from the Claude Code transcript. Oxagen recorded the rest as it ran.",
    );
    expect(screen.getByTestId("run-tier")).toHaveAttribute(
      "data-tier",
      "harness",
    );
    expect(screen.queryByTestId("run-policy-backfilled")).toBeNull();
    expect(
      within(screen.getByTestId("run-stat-cost")).queryByText("estimated"),
    ).toBeNull();
    await expectNoAxe(container);
  });
});

describe("a live run (negative)", () => {
  it("carries no backfill mark, and its tier and seal read as recorded", async () => {
    const run = runRow({ recordBasis: "live" });
    const container = await renderRun(run, "chain");
    expect(screen.queryByTestId("run-backfilled")).toBeNull();
    expect(screen.queryByTestId("run-backfill-note")).toBeNull();
    expect(screen.getByTestId("run-tier")).toHaveAttribute(
      "data-tier",
      "harness",
    );
    expect(screen.getByTestId("chain-sealed")).toHaveTextContent(/^sealed$/);
    await expectNoAxe(container);
  });

  it("carries no mark on a row that does not say how it was recorded", async () => {
    const run = runRow();
    const container = await renderRun(run);
    expect(screen.queryByTestId("run-backfilled")).toBeNull();
    expect(screen.queryByTestId("run-backfill-note")).toBeNull();
    await expectNoAxe(container);
  });
});
