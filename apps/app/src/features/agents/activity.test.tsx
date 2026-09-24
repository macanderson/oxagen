// @vitest-environment jsdom
// The Activity tab drawn on its own (activity.tsx), for the states the page
// test in agent.test.tsx does not reach: runs, rollup, findings and incidents
// that could not be read; a run with no cost; a rollup with no cost, basis,
// ratio or cache; findings that belong to other agents; and the incident
// panels of every severity, open and resolved, with their pager. Axe runs
// after every test (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  incident,
  incidentPage,
  runRow,
  spendFindings,
  spendReport,
  spendRow,
} from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { ActivitySection } = await import("./activity");

type Props = ComponentProps<typeof ActivitySection>;

const PLACE = { org: "acme", ws: "core-platform", agent: "release-bot" };
const KEY = "acme.core.release-bot";

function renderActivity(overrides: Partial<Props> = {}) {
  const row = spendRow();
  const props: Props = {
    runs: readOk([runRow()]),
    row,
    spend: spendReport([row]),
    findings: spendFindings([{}]),
    incidents: incidentPage([incident()]),
    cursor: null,
    agentKey: KEY,
    place: PLACE,
    ...overrides,
  };
  render(
    <IntlProvider>
      <ActivitySection {...props} />
    </IntlProvider>,
  );
}

const region = (name: string) => screen.getByRole("region", { name });

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Activity › runs", () => {
  it("names the failed runs read in the Runs panel (negative)", () => {
    renderActivity({ runs: readError("runs_unavailable", 503) });
    expect(region("Runs")).toHaveTextContent(
      "Runs could not be loaded: the control plane answered runs_unavailable.",
    );
    expect(screen.queryByTestId("agent-run")).toBeNull();
  });

  it("says the rollup holds no run either when there is no row (negative)", () => {
    renderActivity({ runs: readOk([]), row: null });
    expect(screen.getByTestId("runs-empty")).toHaveTextContent(
      "No run of this agent is on the newest page of runs, and the 30-day rollup holds none.",
    );
  });

  it("counts the runs shown and prints a run with no cost as not recorded", () => {
    renderActivity({
      runs: readOk([runRow(), runRow({ id: "arun_2", cost: null })]),
    });
    const runs = region("Runs");
    expect(runs).toHaveTextContent("2 shown");
    const [, second] = screen.getAllByTestId("agent-run");
    if (second === undefined) throw new Error("second run not drawn");
    const cells = within(second).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent("not recorded");
    expect(cells[4]).toHaveTextContent("1,204");
  });
});

describe("Activity › token accounting", () => {
  it("names the failed rollup read (negative)", () => {
    renderActivity({
      spend: readError("clickhouse_unavailable", 503),
      row: null,
    });
    expect(region("Token accounting")).toHaveTextContent(
      "Token accounting could not be loaded: the control plane answered clickhouse_unavailable.",
    );
  });

  it("says the rollup holds no row when there is none (negative)", () => {
    renderActivity({ row: null, spend: null });
    expect(region("Token accounting")).toHaveTextContent(
      "The 30-day rollup holds no row for this agent.",
    );
  });

  it("says there is no cache hit rate when no input was counted (negative)", () => {
    renderActivity({
      row: spendRow({
        tokens: {
          input_uncached: 0,
          cache_read: 0,
          cache_write_5m: 0,
          cache_write_1h: 0,
          output: 40,
          reasoning: 0,
        },
      }),
    });
    expect(region("Token accounting")).toHaveTextContent(
      "No input token is recorded, so there is no cache hit rate.",
    );
    // With no cache rate the tokens fact is the total alone.
    expect(
      screen.getByRole("region", { name: "Last 30 days" }),
    ).toHaveTextContent("Tokens40");
  });
});

describe("Activity › last 30 days", () => {
  it("says every figure is not recorded when there is no row, and links nowhere without a key (negative)", () => {
    renderActivity({ row: null, spend: null, agentKey: null });
    const last30 = region("Last 30 days");
    expect(last30).toHaveTextContent("Runsnot recorded");
    expect(last30).toHaveTextContent("Spendnot recorded");
    expect(last30).toHaveTextContent("Productive rationot recorded");
    expect(last30).toHaveTextContent("Tokensnot recorded");
    expect(
      within(last30).queryByRole("link", { name: "Open on Spend" }),
    ).toBeNull();
    // A finding cannot be narrowed to an agent with no key.
    expect(last30).toHaveTextContent("No finding is open against this agent.");
  });

  it("prints the spend, its basis and the productive ratio, and links the agent on Spend", () => {
    renderActivity();
    const last30 = region("Last 30 days");
    expect(last30).toHaveTextContent("Spend$12.50basis gateway_observed");
    expect(last30).toHaveTextContent("Productive ratio50%");
    expect(last30).toHaveTextContent("Tokens6,000 · 60% cached");
    expect(
      within(last30).getByRole("link", { name: "Open on Spend" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/spend?tab=agent&drill=acme.core.release-bot",
    );
  });

  it("says the basis and the ratio are not recorded when the rollup has neither (negative)", () => {
    renderActivity({
      row: spendRow({
        cost: { micros: "12500000", currency: "USD", basis: null },
        productiveRatio: null,
      }),
    });
    const last30 = region("Last 30 days");
    expect(last30).toHaveTextContent("Spend$12.50basis not recorded");
    expect(last30).toHaveTextContent("Productive rationot recorded");
  });

  it("names the failed findings read (negative)", () => {
    renderActivity({ findings: readError("findings_unavailable", 503) });
    expect(region("Last 30 days")).toHaveTextContent(
      "Findings could not be loaded: the control plane answered findings_unavailable.",
    );
    expect(screen.queryByTestId("agent-findings")).toBeNull();
  });

  it("lists only the findings raised against this agent (negative)", () => {
    renderActivity({
      findings: spendFindings([
        { id: "fnd_other", subject: "acme.core.other-bot" },
        { id: "fnd_ws", level: "workspace", subject: KEY },
      ]),
    });
    expect(screen.queryByTestId("agent-findings")).toBeNull();
    expect(region("Last 30 days")).toHaveTextContent(
      "No finding is open against this agent.",
    );
  });

  it("says nothing is open when the tab read no findings at all", () => {
    renderActivity({ findings: null });
    expect(region("Last 30 days")).toHaveTextContent(
      "No finding is open against this agent.",
    );
  });
});

describe("Activity › incidents", () => {
  it("names the failed incidents read (negative)", () => {
    renderActivity({ incidents: readError("tacho_unavailable", 503) });
    expect(region("Tamper incidents")).toHaveTextContent(
      "Tamper incidents could not be loaded: the control plane answered tacho_unavailable.",
    );
  });

  it("draws a resolved warning that is not tamper with its session, note and close, and pages both ways", () => {
    renderActivity({
      cursor: "cur_2",
      incidents: incidentPage(
        [
          incident({
            id: "tin_2",
            kind: "telemetry_gap",
            severity: "warning",
            detectedBy: "control_plane",
            sessionId: "ses_42",
            resolvedAt: "2026-09-14T12:00:00.000Z",
            resolutionNote: "The collector restarted and backfilled.",
          }),
          incident({ id: "tin_3", kind: "daemon_down", severity: "notice" }),
        ],
        "cur_3",
      ),
    });
    const [warning, notice] = screen.getAllByTestId("incident-panel");
    if (warning === undefined || notice === undefined)
      throw new Error("incident panels not drawn");
    expect(warning).toHaveTextContent("detected by the control plane · ses_42");
    expect(within(warning).queryByText("tamper")).toBeNull();
    expect(
      within(warning).getByText("warning").closest("[data-severity]"),
    ).toHaveAttribute("data-severity", "warning");
    expect(warning).toHaveTextContent("resolved");
    expect(warning).toHaveTextContent(
      "What it stoppedThe collector restarted and backfilled.",
    );
    expect(warning).toHaveTextContent("Closed");
    expect(warning).not.toHaveTextContent("Ownernot recorded");
    expect(notice).toHaveTextContent("notice");
    expect(notice).toHaveTextContent("open");
    expect(notice).toHaveTextContent("Ownernot recorded");
    const pager = screen.getByRole("navigation", { name: "Incident pages" });
    expect(
      within(pager).getByRole("link", { name: "Newest incidents" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/activity",
    );
    expect(
      within(pager).getByRole("link", { name: "Older incidents" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/activity?cursor=cur_3",
    );
  });

  it("keeps the way back on a later page that came back empty (negative)", () => {
    renderActivity({ cursor: "cur_9", incidents: incidentPage([]) });
    expect(screen.queryByTestId("incidents-empty")).toBeNull();
    expect(screen.queryByTestId("incident-panel")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Newest incidents" }),
    ).toBeVisible();
  });
});
