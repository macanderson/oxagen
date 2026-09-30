// @vitest-environment jsdom
// The Activity tab drawn on its own (activity.tsx), for the states the page
// test in agent.test.tsx does not reach: runs, rollup, findings and incidents
// that could not be read; a run with no cost; a rollup with no cost, basis,
// ratio or cache; findings that belong to other agents; and the incident
// panels of every severity, open and resolved, with their pager and its Rows
// per page (#4693). Axe runs after every test (INV-26).
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
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

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
// Picking a size from Rows navigates through the router (#4693).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
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
    rows: 50,
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

  // #4571: a run is named by its session name, then its task reference,
  // and never by its id. The id sits on the line below.
  it("names each run by its session name, with its id below", () => {
    renderActivity({
      runs: readOk([
        runRow(),
        runRow({ id: "arun_task", name: null, taskRef: "ENG-4121" }),
        runRow({ id: "arun_bare", name: null, taskRef: null }),
      ]),
    });
    const [named, task, bare] = screen.getAllByTestId("agent-run");
    if (named === undefined || task === undefined || bare === undefined)
      throw new Error("runs not drawn");
    expect(within(named).getByRole("link")).toHaveTextContent(
      /^Cut the 3.2 release branch$/,
    );
    expect(within(task).getByRole("link")).toHaveTextContent(/^ENG-4121$/);
    expect(within(bare).getByRole("link")).toHaveTextContent(
      /^Untitled session$/,
    );
    expect(within(bare).getByTestId("agent-run-id")).toHaveTextContent(
      /^arun_bare$/,
    );
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
      routes.spend("acme", "core-platform", { tab: "agent", drill: KEY }),
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
      "ResolutionThe collector restarted and backfilled.",
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
    // The last page has no older one, so Older is a disabled button.
    expect(
      screen.getByRole("button", { name: "Older incidents" }),
    ).toBeDisabled();
  });

  // #4693: Rows per page sets how many incidents a page holds, and both steps
  // keep that size.
  it("keeps the size on the Newest and Older steps", () => {
    renderActivity({
      cursor: "cur_2",
      rows: 25,
      incidents: incidentPage([incident()], "cur_3"),
    });
    const pager = screen.getByRole("navigation", { name: "Incident pages" });
    expect(
      within(pager).getByRole("link", { name: "Newest incidents" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/activity?rows=25",
    );
    expect(
      within(pager).getByRole("link", { name: "Older incidents" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/activity?rows=25&cursor=cur_3",
    );
    expect(screen.getByRole("combobox", { name: "Rows" })).toHaveTextContent(
      "25",
    );
  });

  it("visits the newest page at the size picked from Rows", async () => {
    push.mockReset();
    renderActivity({
      cursor: "cur_2",
      incidents: incidentPage([incident()], "cur_3"),
    });
    const rows = screen.getByRole("combobox", { name: "Rows" });
    expect(rows).toHaveTextContent("50");
    const user = userEvent.setup();
    await user.click(rows);
    await user.click(await screen.findByRole("option", { name: "25" }));
    // A new size drops the cursor and starts over at the newest page.
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/acme/core-platform/agents/release-bot/activity?rows=25",
      );
    });
    expect(push).toHaveBeenCalledOnce();
  });

  it("draws no pager under an empty first page (negative)", () => {
    renderActivity({ incidents: incidentPage([]) });
    expect(screen.getByTestId("incidents-empty")).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "Incident pages" }),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Rows" })).toBeNull();
  });
});
