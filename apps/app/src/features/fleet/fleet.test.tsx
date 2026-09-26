// @vitest-environment jsdom
// Fleet over a fake DataSource, against fleet.md: the header and its two
// actions, the four summary tiles and their basis lines, the Runs panel with
// its chips, columns, row actions and list controls, and every not-loaded
// state, with an axe check in every case. Each tile figure is recomputed from
// the rows the table draws, so a tile that disagreed with its table fails.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HOST_POLL_WINDOW_MS } from "@oxagen/oxagen/contracts/run.list";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STALE_REREAD_MS } from "@/data/contracts/runs";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  agentPage,
  approvalItem,
  approvalQueue,
  fleetSource,
  interjectionItem,
  interjectionQueue,
  NOW,
  runPage,
  runRow,
} from "./fleet.builders";

const { push, refresh, dispatchRunCommand, exportFleetRun } = vi.hoisted(
  () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    dispatchRunCommand: vi.fn(),
    exportFleetRun: vi.fn(),
  }),
);

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh }),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  resolveApprovalAction: vi.fn(),
  readApprovalEligibility: vi.fn(),
  steerFleet: vi.fn(),
  dispatchRunCommand,
  exportFleetRun,
}));
vi.mock("@/server/session", () => ({
  getSession: vi.fn(),
  getAuthUser: vi.fn(() =>
    Promise.resolve({
      id: "usr_marcusbell",
      name: "Marcus Bell",
      email: "marcus@acme.example",
    }),
  ),
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Fleet } = await import("./fleet");

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

/** A viewer of the organization and the workspace, whom dispatch refuses. */
const viewerCtx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "viewer",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "viewer",
});

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "workspace.read",
} as const;
const DOWN = readError("run_index_unavailable", 503);
const NO_APPROVALS = approvalQueue([]);

const usd = (
  micros: string,
  basis: "gateway_observed" | "client_attested" = "gateway_observed",
) => ({ micros, currency: "USD", basis });

/** A live wrapped run, a live run with a parked call, a sealed and a halted run. */
const RUNS = [
  runRow({
    id: "tse_live",
    source: "tacho",
    status: "live",
    enforcementTier: "gateway",
    replayGrade: null,
    harness: { name: "Claude Code", version: "2.1", runtime: "claude-code" },
    cost: usd("4130000"),
  }),
  runRow({
    id: "arun_parked",
    status: "live",
    agentKey: "acme.core.docs",
    operatorName: "Priya Natarajan",
    enforcementTier: "harness",
    cost: usd("610000", "client_attested"),
  }),
  runRow({
    id: "arun_sealed",
    status: "sealed",
    outcome: "completed",
    enforcementTier: "harness",
    replayGrade: "retry",
    cost: usd("2870000"),
    startedAt: new Date(NOW - 26 * 3600_000).toISOString(),
  }),
  runRow({
    id: "arun_halted",
    status: "halted",
    outcome: "cancelled",
    enforcementTier: "gateway",
    cost: null,
  }),
];
const PARKED = approvalItem({ id: "apr_parked", runId: "arun_parked" });

/** A page holding one live ledger run, for the controls its row offers. */
const ledgerRuns = (over: Parameters<typeof runRow>[0] = {}) =>
  runPage([runRow({ id: "arun_ledger", source: "ledger", ...over })]);

/**
 * Cancel a ledger run's evidence ingress from its open dialog. A cancel
 * cannot be undone, so it takes two clicks: the first shows the confirm.
 */
async function cancelIngress(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.click(
    within(dialog).getByRole("button", { name: "Cancel evidence ingress" }),
  );
  await user.click(
    within(dialog).getByRole("button", {
      name: "Revoke evidence ingress for good",
    }),
  );
}

/** One `list_agents` page with its cursor, for the roster's walk. */
function pageValue(
  keys: string[],
  identities: number,
  nextCursor: string | null,
) {
  const read = agentPage(keys, identities);
  if (!read.ok) throw new Error("agentPage answers a page");
  return { ...read.value, nextCursor };
}

async function renderFleet(
  reads: Parameters<typeof fleetSource>[0],
  cursor: string | null = null,
  banners?: ReactNode,
  view: {
    prefs?: Parameters<typeof Fleet>[0]["prefs"];
    pullRequests?: Parameters<typeof Fleet>[0]["pullRequests"];
    list?: Parameters<typeof Fleet>[0]["list"];
    /** A viewer other than the workspace member the page reads as. */
    ctx?: typeof ctx;
  } = {},
) {
  const { source, calls } = fleetSource(reads);
  const element = await Fleet({ ctx, source, cursor, banners, ...view });
  const { container } = render(<IntlProvider>{element}</IntlProvider>);
  return { container, calls };
}

/**
 * The workspace's live runs as `list_runs` counts them: more than the two
 * open runs on the page, since the tile counts the workspace.
 */
const WORKSPACE_LIVE = 5;

const loaded = (over: Partial<Parameters<typeof fleetSource>[0]> = {}) =>
  renderFleet({
    runs: runPage(RUNS, null, WORKSPACE_LIVE),
    approvals: approvalQueue([PARKED]),
    agents: agentPage(["acme.core.release-bot", "acme.core.docs"], 64),
    ...over,
  });

const tiles = () => screen.getAllByTestId("tile");
const tile = (title: string) => {
  const found = tiles().find((t) => t.firstElementChild?.textContent === title);
  if (found === undefined) throw new Error(`no ${title} tile`);
  return found;
};
const waitingTile = () =>
  screen.getByRole("button", { name: "Open approvals" });
const runsPanel = () => screen.getByRole("region", { name: "Runs" });
const rows = () => within(runsPanel()).getAllByTestId("run-row");
const row = (id: string) => {
  const found = rows().find((r) => within(r).queryByText(id) !== null);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  push.mockReset();
  refresh.mockReset();
  dispatchRunCommand.mockReset();
  exportFleetRun.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await expectNoAxe(document.body);
  cleanup();
  // A test that saved a table choice leaves no cookie for the next one.
  document.cookie = "fleet_view=; Path=/; Max-Age=0";
});

describe("Fleet reads", () => {
  it("reads one runs page at the URL's cursor, the pending approvals and the workspace's agents", async () => {
    const { calls } = await renderFleet(
      { runs: runPage(RUNS), approvals: NO_APPROVALS },
      "c1",
    );
    // The page size is the read's own limit (25 until the person picks
    // another), and every run is listed until a filter is chosen. Fleet
    // asks for the total, because its pager prints one, and for the
    // workspace's live count, since the Live runs tile sits above every page.
    expect(calls.runs).toEqual([
      [
        ctx,
        {
          cursor: "c1",
          limit: 25,
          pullRequests: "any",
          count: true,
          countLive: true,
        },
      ],
    ]);
    expect(calls.approvals).toEqual([[ctx, { runId: null }]]);
    // The open questions, for the waiting tile (#3839).
    expect(calls.interjections).toEqual([[ctx, { runId: null }]]);
    expect(calls.agents).toEqual([[ctx, { cursor: null }]]);
  });

  it("reads every page of the workspace's agents, so Steer lists all of them", async () => {
    const pages: Record<string, ReturnType<typeof agentPage>> = {
      first: {
        ok: true,
        value: pageValue(["acme.core.release-bot"], 3, "a2"),
      },
      a2: {
        ok: true,
        value: pageValue(["acme.core.docs", "acme.core.triage"], 3, null),
      },
    };
    const { calls } = await renderFleet({
      runs: runPage(RUNS),
      approvals: approvalQueue([PARKED]),
      agents: (cursor) => pages[cursor ?? "first"] ?? readError("x", 500),
    });
    expect(calls.agents).toEqual([
      [ctx, { cursor: null }],
      [ctx, { cursor: "a2" }],
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fleet-steer"));
    expect(screen.getByTestId("steer-selected")).toHaveTextContent(
      "Agents · 3 of 3 selected",
    );
    expect(screen.queryByTestId("steer-unlisted")).toBeNull();
    // arun_parked is the docs agent's run, and its call is parked. The picker
    // draws each agent's state on its option row, so the list has to be open.
    const picker = screen.getByTestId("steer-agents");
    fireEvent.focus(within(picker).getByRole("combobox"));
    expect(
      screen
        .getAllByRole("option")
        .find((row) => row.getAttribute("data-value") === "acme.core.docs"),
    ).toHaveTextContent("parked for approval");
  });

  it("says the steer list stopped when a later agents page failed (negative)", async () => {
    const { calls } = await renderFleet({
      runs: runPage(RUNS),
      approvals: NO_APPROVALS,
      agents: (cursor) =>
        cursor === null
          ? {
              ok: true,
              value: pageValue(["acme.core.release-bot"], 3, "a2"),
            }
          : readError("agent_index_unavailable", 503),
    });
    expect(calls.agents).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fleet-steer"));
    expect(screen.getByTestId("steer-selected")).toHaveTextContent(
      "Agents · 1 of 3 selected",
    );
    expect(screen.getByTestId("steer-unlisted")).toHaveTextContent(
      "The list stops after 1 agent. 2 more are not listed",
    );
  });
});

describe("header", () => {
  it("names the workspace, the page and what it holds, with Steer then Register Agent, neither gold", async () => {
    await loaded();
    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent("Core platform");
    expect(
      screen.getByRole("heading", { level: 1, name: "Fleet" }),
    ).toBeInTheDocument();
    expect(header).toHaveTextContent(
      "Every run in this workspace, live and recent.",
    );
    const steer = screen.getByTestId("fleet-steer");
    const register = screen.getByTestId("fleet-register");
    expect(steer).toHaveTextContent("Steer");
    expect(register).toHaveTextContent("Register Agent");
    expect(register).toHaveAttribute(
      "href",
      "/acme/core-platform/register/name",
    );
    expect(
      steer.compareDocumentPosition(register) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const action of [steer, register])
      expect(action.className).not.toContain("bg-button-primary-bg");
  });

  it("opens Steer the fleet from the header", async () => {
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fleet-steer"));
    expect(
      screen.getByRole("dialog", { name: "Steer the fleet" }),
    ).toBeInTheDocument();
  });

  it("draws the onboarding banners it is handed under the header", async () => {
    await renderFleet(
      { runs: runPage(RUNS), approvals: NO_APPROVALS },
      null,
      <p data-testid="banner">provisional</p>,
    );
    expect(screen.getByTestId("banner")).toBeInTheDocument();
  });

  it("draws no approvals panel: approvals are decided in the drawer (negative)", async () => {
    await loaded();
    expect(screen.queryByRole("region", { name: "Approvals" })).toBeNull();
  });
});

describe("summary tiles", () => {
  it("draws four tiles, each one figure and one basis line, rolled up from the rows", async () => {
    await loaded();
    expect(tiles().map((t) => t.firstElementChild?.textContent)).toEqual([
      "Live runs",
      "Waiting on a human",
      "Spend shown",
      "Tokens shown",
    ]);
    // The workspace's count, not the page's two open rows (A-04).
    expect(tile("Live runs")).toHaveTextContent(
      "Live runs5of 64 agents in this workspace",
    );
    // 4.13 + 0.61 + 2.87; the halted run recorded no cost.
    expect(tile("Spend shown")).toHaveTextContent("$7.61");
    expect(screen.getByTestId("spend-basis")).toHaveTextContent(
      "gateway_observed + client_attested · USD · 1 run has no cost recorded",
    );
    expect(tile("Tokens shown")).toHaveTextContent(
      "Tokens shownnot recordedno cache figure recorded",
    );
    // No row carries a token figure, so none is typed or zeroed (#3834).
    expect(
      within(tile("Tokens shown")).getByTestId("tokens-not-recorded"),
    ).toHaveAttribute("data-recorded", "false");
  });

  it("marks an open run's cost as an estimate, in its cell and in Spend shown (#3980)", async () => {
    await renderFleet({
      runs: runPage([
        runRow({
          id: "tse_open",
          source: "tacho",
          status: "live",
          cost: usd("4130000"),
          costIsEstimate: true,
        }),
        runRow({ id: "arun_done", cost: usd("2870000") }),
      ]),
      approvals: NO_APPROVALS,
    });
    expect(screen.getAllByTestId("row-cost-estimate")).toHaveLength(1);
    expect(tile("Spend shown")).toHaveTextContent("$7.00");
    expect(screen.getByTestId("spend-basis")).toHaveTextContent(
      "gateway_observed · USD · includes 1 estimate",
    );
  });

  // With no rollup yet, the Run page shows what the agent reported, and so
  // does the row, as an estimate. The tile adds the figure the row shows.
  it("shows the agent's reported cost where no rollup is recorded yet, in its cell and in Spend shown", async () => {
    await renderFleet({
      runs: runPage([
        runRow({
          id: "tse_reported",
          source: "tacho",
          status: "sealed",
          cost: null,
          reportedCost: usd("1250000", "client_attested"),
        }),
        runRow({ id: "arun_done", cost: usd("2870000") }),
      ]),
      approvals: NO_APPROVALS,
    });
    expect(row("tse_reported")).toHaveTextContent("$1.25estimate");
    expect(
      within(row("tse_reported")).getByTestId("row-cost-reported"),
    ).toHaveTextContent("estimate");
    expect(tile("Spend shown")).toHaveTextContent("$4.12");
    expect(screen.getByTestId("spend-basis")).toHaveTextContent(
      "client_attested + gateway_observed · USD · includes 1 estimate",
    );
    expect(screen.getByTestId("spend-basis")).not.toHaveTextContent(
      "no cost recorded",
    );
  });

  it("shows the rolled-up cost over the reported one (negative)", async () => {
    await renderFleet({
      runs: runPage([
        runRow({
          id: "tse_rolled",
          source: "tacho",
          status: "sealed",
          cost: usd("4130000"),
          reportedCost: usd("1250000", "client_attested"),
        }),
      ]),
      approvals: NO_APPROVALS,
    });
    expect(row("tse_rolled")).toHaveTextContent("$4.13gateway_observed");
    expect(
      within(row("tse_rolled")).queryByTestId("row-cost-reported"),
    ).toBeNull();
    expect(tile("Spend shown")).toHaveTextContent("$4.13");
  });

  it("opens the approvals drawer from the waiting tile, with the oldest wait off the live clock", async () => {
    const opened = vi.fn();
    window.addEventListener("oxagen:open-approvals", opened);
    await loaded();
    expect(waitingTile()).toHaveTextContent(
      "Waiting on a human1oldest approval has waited 2:30 of 10m · open the drawer",
    );
    fireEvent.click(waitingTile());
    expect(opened).toHaveBeenCalledOnce();
    window.removeEventListener("oxagen:open-approvals", opened);
  });

  it("says nothing is waiting on an empty queue", async () => {
    await loaded({ approvals: NO_APPROVALS });
    expect(waitingTile()).toHaveTextContent(
      "0nothing is waiting · open the drawer",
    );
  });

  // #3839: the tile counted approvals alone and said interjections were not
  // recorded. It now adds the open questions and names them.
  it("adds an open interjection to the approvals and names it beside the oldest approval", async () => {
    await loaded({ interjections: interjectionQueue([interjectionItem()]) });
    expect(waitingTile()).toHaveTextContent(
      "Waiting on a human2oldest approval has waited 2:30 of 10m · 1 interjection · open the drawer",
    );
    expect(screen.queryByTestId("interjections-not-recorded")).toBeNull();
  });

  it("names the interjection's own wait against its 30-minute window when no approval waits", async () => {
    await loaded({
      approvals: NO_APPROVALS,
      interjections: interjectionQueue([interjectionItem()]),
    });
    expect(waitingTile()).toHaveTextContent(
      "1an interjection has waited 3:36 of 30m · open the drawer",
    );
  });

  it("counts the approvals as a floor and says the interjections were not read (negative)", async () => {
    await loaded({ interjections: readError("record_unmappable", 502) });
    expect(waitingTile()).toHaveTextContent("1+");
    expect(screen.getByTestId("interjections-unread")).toHaveTextContent(
      "interjections not read: record_unmappable",
    );
  });

  it("marks a count the read could not finish", async () => {
    await loaded({ approvals: approvalQueue([PARKED], true) });
    expect(waitingTile()).toHaveTextContent("1+");
    expect(waitingTile()).toHaveTextContent(
      "more are parked than this page read",
    );
  });

  it("says the live runs were not counted when the read carried no count, never the page's figure (negative)", async () => {
    await loaded({ runs: runPage(RUNS) });
    expect(tile("Live runs")).toHaveTextContent(
      "Live runsnot countedof 64 agents in this workspace",
    );
    expect(screen.getByTestId("live-not-counted")).toBeTruthy();
  });

  it("names what the waiting and live tiles could not read, never a zero (negative)", async () => {
    await loaded({
      approvals: DENIED,
      agents: { ok: false, reason: "denied", permission: "agent.read" },
    });
    expect(waitingTile()).toHaveTextContent(
      "Waiting on a human—approvals not read: workspace.read",
    );
    expect(tile("Live runs")).toHaveTextContent(
      "the workspace's agents were not read",
    );
  });

  it("changes Spend shown with the filter chips, and keeps Live runs on the workspace's count (A-04)", async () => {
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("chip-sealed"));
    expect(screen.getByTestId("chip-sealed")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(tile("Spend shown")).toHaveTextContent("$2.87");
    expect(screen.getByTestId("spend-basis")).toHaveTextContent(
      "gateway_observed · USD",
    );
    // The tile says "in this workspace", so no chip and no page changes it.
    expect(tile("Live runs")).toHaveTextContent("Live runs5");
    expect(rows()).toHaveLength(1);
    await user.click(screen.getByTestId("chip-parked"));
    expect(rows().map((r) => r.dataset.state)).toEqual(["parked"]);
    expect(screen.getByTestId("spend-basis")).toHaveTextContent(
      "client_attested · USD",
    );
    await user.click(screen.getByTestId("chip-live"));
    expect(rows().map((r) => r.dataset.state)).toEqual(["live", "parked"]);
  });
});

describe("the Runs panel", () => {
  it("heads the table with every column, in order, and an action column named only to a screen reader", async () => {
    await loaded();
    const heads = within(runsPanel())
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(heads).toEqual([
      "Run",
      "Summary",
      "Agent",
      "Operator",
      "Status",
      "Pull requests",
      "Lines",
      "Tier",
      "Replay",
      "Tokens",
      "Cost",
      "Frames",
      "Started",
      "Actions",
    ]);
  });

  it("draws a row per run: id and task, agent and harness, operator, status, tier, replay, tokens, cost with its basis, frames", async () => {
    await loaded();
    const live = row("tse_live");
    expect(live).toHaveTextContent("Cut the 3.2 release branch");
    expect(live).toHaveTextContent("acme.core.release-bot");
    expect(live).toHaveTextContent("Claude Code 2.1");
    expect(live).toHaveTextContent("Marcus Bell");
    expect(live).toHaveTextContent("gateway");
    expect(within(live).getByTestId("row-tokens")).toHaveTextContent(
      "not recorded",
    );
    expect(live).toHaveTextContent("$4.13gateway_observed");
    expect(live).toHaveTextContent("1,204");
    // A ledger run with no harness recorded names its source instead.
    expect(row("arun_sealed")).toHaveTextContent("evidence ledger");
    expect(row("arun_sealed")).toHaveTextContent("retry");
    expect(
      within(row("arun_halted")).getByTestId("row-tokens"),
    ).toHaveAttribute("data-recorded", "false");
    expect(row("arun_halted")).toHaveTextContent("not recorded");
  });

  // A workspace that turned enrichment off shows no generated name anywhere
  // (the Run page's header reads the same fallback), so a row falls back to
  // its task reference, and a run with neither shows only its id.
  it("keeps a run's recorded name when its workspace turned enrichment off", async () => {
    await renderFleet({
      runs: runPage([
        runRow({ id: "tse_off", enrichmentEnabled: false }),
        runRow({
          id: "tse_bare",
          enrichmentEnabled: false,
          name: null,
          taskRef: null,
        }),
      ]),
      approvals: NO_APPROVALS,
    });
    // Enrichment off stops Oxagen writing names; it never hides the one the
    // run carries, which for a wrapped session is its harness title.
    expect(row("tse_off")).toHaveTextContent("Cut the 3.2 release branch");
    expect(row("tse_bare").querySelector("td")?.textContent).toBe("tse_bare");
  });

  it("words Status as the design does, sealed or halted, with the outcome on hover", async () => {
    await loaded();
    const status = (id: string) => {
      const badge = row(id).querySelector<HTMLElement>("span[data-status]");
      if (!badge) throw new Error(`no status badge on ${id}`);
      return badge;
    };
    expect(status("tse_live")).toHaveTextContent("live");
    expect(status("arun_sealed")).toHaveTextContent("sealed");
    expect(status("arun_sealed")).toHaveAttribute("title", "completed");
    expect(status("arun_halted")).toHaveTextContent("halted");
    expect(status("arun_halted")).toHaveAttribute("title", "cancelled");
    expect(
      within(screen.getByTestId("facet-status"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      // The lifecycle words the record holds (#3837). Parked comes from the
      // approvals read, so the chips find it and the read cannot filter on it.
      "All · Status",
      "live",
      "sealed",
      "halted",
    ]);
  });

  it("says stale, with a still dot, on a live row whose host has not checked in for five minutes (A-02)", async () => {
    await loaded({
      runs: runPage([
        runRow({
          id: "tse_quiet",
          source: "tacho",
          status: "live",
          commandBlock: "host_offline",
        }),
        runRow({ id: "tse_heard", source: "tacho", status: "live" }),
      ]),
      approvals: approvalQueue([
        approvalItem({ id: "apr_quiet", runId: "tse_quiet" }),
      ]),
    });
    const quiet = row("tse_quiet");
    const badge = quiet.querySelector<HTMLElement>("span[data-status]");
    expect(badge).toHaveTextContent(/^stale$/);
    expect(badge).toHaveAttribute("data-stale", "true");
    expect(quiet.querySelector("[data-pulse]")).toBeNull();
    // Stale wins over the parked call: the host that holds it went quiet.
    expect(quiet).not.toHaveTextContent("parked for approval");
    // Negative: a live run whose host checks in still pulses live.
    const heard = row("tse_heard");
    expect(heard.querySelector("span[data-status]")).toHaveTextContent(
      /^live$/,
    );
    expect(heard.querySelector("[data-pulse]")).not.toBeNull();
  });

  describe("reading a live wrapped run's light again (A-02, #4343 review)", () => {
    // Fleet read a run's stale light once, when it loaded, so a Fleet left
    // open kept pulsing live after the host went quiet. With no stream to
    // say so, it reads itself again once per host poll window.
    let visibility: DocumentVisibilityState = "visible";
    beforeEach(() => {
      vi.useFakeTimers({
        now: NOW,
        toFake: ["Date", "setInterval", "clearInterval"],
      });
      visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(document, "visibilityState");
    });
    const advance = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };

    it("reads the page again once per host poll window while it lists a live wrapped run", async () => {
      await loaded({
        runs: runPage([
          runRow({ id: "tse_open", source: "tacho", status: "live" }),
          runRow({ id: "tse_done", source: "tacho", status: "sealed" }),
        ]),
      });
      // The window is the one the row's stale reading uses.
      expect(STALE_REREAD_MS).toBe(HOST_POLL_WINDOW_MS);
      advance(STALE_REREAD_MS - 1);
      expect(refresh).not.toHaveBeenCalled();
      advance(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      // Negative: a hidden tab is not read.
      visibility = "hidden";
      advance(STALE_REREAD_MS);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("reads nothing again when no listed run can go stale (negative)", async () => {
      await loaded({
        runs: runPage([
          runRow({ id: "arun_open", source: "ledger", status: "live" }),
          runRow({ id: "tse_done", source: "tacho", status: "sealed" }),
        ]),
      });
      advance(STALE_REREAD_MS * 3);
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  it("marks the chips, the pager and the row actions as 44px touch targets on a phone", async () => {
    await loaded();
    for (const chip of ["all", "live", "parked", "sealed"])
      expect(screen.getByTestId(`chip-${chip}`)).toHaveAttribute(
        "data-touch-target",
      );
    expect(screen.getByTestId("columns-open")).toHaveAttribute(
      "data-touch-target",
    );
    for (const select of ["pr-filter", "rows-per-page"])
      expect(screen.getByTestId(select).className).toContain("max-md:min-h-11");
    expect(within(row("tse_live")).getByTestId("row-pause")).toHaveAttribute(
      "data-touch-target",
    );
    expect(
      within(row("tse_live")).getByRole("link", { name: "tse_live" }),
    ).toHaveAttribute("data-touch-target");
    // The search box is 44px tall on a phone, as every other control is.
    expect(screen.getByRole("searchbox").className).toContain(
      "max-md:min-h-11",
    );
  });

  it("stacks the four tiles two by two on a phone, as the design does", async () => {
    await loaded();
    expect(screen.getByRole("region", { name: "Fleet summary" })).toHaveClass(
      "grid-cols-2",
    );
  });

  it("draws the Tokens header with no sort while the server cannot order by tokens (#3834, #3837)", async () => {
    await loaded();
    expect(screen.queryByRole("button", { name: /Sort by Tokens/ })).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: /^Tokens/ }),
    ).toBeInTheDocument();
  });

  it("reads a live run with a parked call as parked for approval, and resolves it on the Run page", async () => {
    await loaded();
    const parked = row("arun_parked");
    expect(parked).toHaveTextContent("parked for approval");
    expect(within(parked).getByTestId("row-resolve")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/arun_parked",
    );
  });

  it("opens the Run page when a row is clicked", async () => {
    await loaded();
    fireEvent.click(row("arun_sealed"));
    expect(push).toHaveBeenCalledWith("/acme/core-platform/runs/arun_sealed");
  });

  it("pauses a live run through the pause dialog and says the pause was queued", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_1"] },
    });
    await loaded();
    const user = userEvent.setup();
    await user.click(within(row("tse_live")).getByTestId("row-pause"));
    expect(push).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Pause this run" });
    expect(dialog).toHaveTextContent("Takes effect at the next boundary");
    expect(dialog).toHaveTextContent("turn 34 · step 271 · frame 1204");
    expect(dialog).toHaveTextContent(
      "control.pause frame · operator authority",
    );
    expect(dialog).toHaveTextContent("Pause is not cancel.");
    const note = dialog.querySelector("[data-sheet-footer] [data-footer-note]");
    expect(note).toHaveTextContent(
      "Recorded as a control.pause frame under run.pause.",
    );
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The design's header x, labelled Close, beside the footer's Cancel.
    expect(
      within(dialog)
        .getByRole("button", { name: "Close" })
        .closest("[data-sheet-header]"),
    ).not.toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
    // A wrapped run's row offers Pause alone. Cancel is the ledger's control.
    expect(
      within(dialog).queryByRole("button", { name: "Cancel evidence ingress" }),
    ).toBeNull();
    await user.type(
      within(dialog).getByLabelText(
        "Reason — the model reads this on resume, so write it for the agent",
      ),
      "Holding for finance",
    );
    await user.click(
      screen.getByRole("button", { name: "Pause at the next boundary" }),
    );
    expect(dispatchRunCommand).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tse_live",
      "pause",
      "Holding for finance",
    );
    const queued = await screen.findByText(
      "Pause queued for tse_live. It takes effect at the next boundary.",
    );
    expect(queued.closest("[data-toast]")).toHaveAttribute(
      "data-tone",
      "approval",
    );
    expect(refresh).toHaveBeenCalled();
  });

  // #3665: a live ledger run's row refused every command and named a Cancel
  // the page did not have. It now offers what the Run page offers: Pause of
  // the run's evidence ingress, and Cancel. A paused run's row opens its Run
  // page, where Resume is.
  it("cancels a live ledger run's evidence ingress from its row and says what changed", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_1"] },
    });
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    expect(dialog).toHaveTextContent("refuses further appends");
    // The wrapped copy names a control frame the ledger never writes.
    expect(dialog).not.toHaveTextContent("control.pause");
    // Both commands, Cancel in the danger style. The dialog renders outside
    // the container, so the check runs over the whole document.
    await expectNoAxe(document.body);
    await user.type(within(dialog).getByLabelText("Reason"), "Key leaked");
    await cancelIngress(user, dialog);
    expect(dispatchRunCommand).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "arun_ledger",
      "cancel",
      "Key leaked",
    );
    expect(
      await within(dialog).findByTestId("ledger-applied"),
    ).toHaveTextContent("Further appends are refused");
    expect(refresh).not.toHaveBeenCalled();
    // Closing re-reads the page, so the row shows what the ledger now holds.
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("pauses a live ledger run's evidence ingress from its row", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_2"] },
    });
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    expect(dialog).toHaveTextContent(
      "Pause refuses new evidence batches at the next ingest boundary.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Pause evidence ingress" }),
    );
    expect(dispatchRunCommand).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "arun_ledger",
      "pause",
      "",
    );
    const applied = await within(dialog).findByTestId("ledger-applied");
    expect(applied).toHaveTextContent("Evidence ingress is paused.");
    expect(applied).toHaveAttribute("role", "status");
    await expectNoAxe(document.body);
  });

  // Review round 1 on #4382: the dialog stayed mounted between rows, so the
  // next ledger row's Pause opened on "Evidence ingress is paused." for a run
  // it had not paused, with no buttons. Each row now opens a dialog of its own.
  it("opens the next row's dialog with nothing the last one showed (negative)", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_7"] },
    });
    await loaded({
      runs: runPage([
        runRow({ id: "arun_first", source: "ledger" }),
        runRow({ id: "arun_second", source: "ledger" }),
      ]),
      approvals: NO_APPROVALS,
    });
    const user = userEvent.setup();
    await user.click(within(row("arun_first")).getByTestId("row-pause"));
    const first = screen.getByRole("dialog", { name: "Evidence ingress" });
    await user.click(
      within(first).getByRole("button", { name: "Pause evidence ingress" }),
    );
    expect(
      await within(first).findByTestId("ledger-applied"),
    ).toHaveTextContent("Evidence ingress is paused.");
    await user.click(within(first).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("pause-dialog")).toBeNull();
    });
    // The page is read again, so the run that paused shows it.
    expect(refresh).toHaveBeenCalledTimes(1);
    await user.click(within(row("arun_second")).getByTestId("row-pause"));
    const second = screen.getByRole("dialog", { name: "Evidence ingress" });
    expect(second).toHaveTextContent("arun_second");
    expect(within(second).queryByTestId("ledger-applied")).toBeNull();
    for (const name of ["Pause evidence ingress", "Cancel evidence ingress"])
      expect(within(second).getByRole("button", { name })).toBeEnabled();
    expect(dispatchRunCommand).toHaveBeenCalledTimes(1);
  });

  // Review round 2 on #4382: the board mounts one dialog per run (`key`), so
  // closing it while a command was in flight unmounted it. A refusal that
  // came back then went nowhere, and reopening the row let a second command
  // go. The dialog now waits for the answer, and the answer lands in it.
  it("holds a ledger dialog open while its command is in flight, and shows the refusal it comes back with (negative)", async () => {
    let settle: (value: unknown) => void = () => undefined;
    dispatchRunCommand.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    await cancelIngress(user, dialog);
    expect(
      await within(dialog).findByRole("button", { name: "Cancelling" }),
    ).toBeDisabled();
    // Both close buttons wait for the answer, and so does Escape.
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Close Evidence ingress" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Evidence ingress" })).toBe(
      dialog,
    );
    settle({ ok: false, reason: "denied", code: "run_sealed" });
    expect(
      await within(dialog).findByTestId("pause-failure"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByTestId("ledger-applied")).toBeNull();
    expect(dispatchRunCommand).toHaveBeenCalledTimes(1);
    // With the answer in, the dialog closes again.
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("pause-dialog")).toBeNull();
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("holds a wrapped run's pause dialog open while the pause is in flight, and shows the refusal in it (negative)", async () => {
    let settle: (value: unknown) => void = () => undefined;
    dispatchRunCommand.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await loaded({
      runs: runPage([runRow({ id: "tse_first", source: "tacho" })]),
      approvals: NO_APPROVALS,
    });
    const user = userEvent.setup();
    await user.click(within(row("tse_first")).getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Pause this run" });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Pause at the next boundary",
      }),
    );
    expect(
      await within(dialog).findByRole("button", { name: "Queueing" }),
    ).toBeDisabled();
    // The footer's Cancel and the header's Close wait for the answer, and so
    // does Escape.
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Pause this run" })).toBe(dialog);
    settle({ ok: false, reason: "denied", code: "host_offline" });
    expect(
      await within(dialog).findByTestId("pause-failure"),
    ).toBeInTheDocument();
    expect(dispatchRunCommand).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  // The dialog cannot close while a command is in flight, but the board can
  // go away under it. The answer then draws nothing, and the page is read
  // again, so the row shows what the command changed.
  it.each([
    ["ledger", "arun_gone", "Pause evidence ingress"],
    ["tacho", "tse_gone", "Pause at the next boundary"],
  ] as const)(
    "reads the page again when the board goes away before a %s run's pause is answered (negative)",
    async (source, id, button) => {
      let settle: (value: unknown) => void = () => undefined;
      dispatchRunCommand.mockReturnValue(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      await loaded({
        runs: runPage([runRow({ id, source })]),
        approvals: NO_APPROVALS,
      });
      const user = userEvent.setup();
      await user.click(screen.getByTestId("row-pause"));
      await user.click(screen.getByRole("button", { name: button }));
      expect(dispatchRunCommand).toHaveBeenCalledTimes(1);
      cleanup();
      settle({ ok: true, value: { commandIds: ["tcm_10"] } });
      await waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
      });
    },
  );

  // Review round 2 on #4382: closing unmounts the dialog (`key`), so nothing
  // checked that focus still goes back to the row that opened it.
  it("gives focus back to the row's Pause button when the dialog closes", async () => {
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    const pause = screen.getByTestId("row-pause");
    await user.click(pause);
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    // The dialog takes focus once it has opened.
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("pause-dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(pause).toHaveFocus();
    });
    expect(dispatchRunCommand).not.toHaveBeenCalled();
  });

  // Review round 1 on #4382: an irreversible Cancel sat one click behind a
  // row button labelled Pause. A cancel now takes a second, confirming click.
  it("asks for a second click before it cancels a ledger run's ingress, and sends nothing on the first (negative)", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_9"] },
    });
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    await user.click(
      within(dialog).getByRole("button", { name: "Cancel evidence ingress" }),
    );
    expect(dispatchRunCommand).not.toHaveBeenCalled();
    const warning =
      "Cancel cannot be undone. The run then cannot append more frames or receive a fresh run credential.";
    expect(
      within(dialog).getByTestId("pause-cancel-warning"),
    ).toHaveTextContent(warning);
    // The confirm names what cannot be undone, and focus waits on the way
    // back.
    const back = within(dialog).getByRole("button", { name: "Back" });
    await waitFor(() => {
      expect(back).toHaveFocus();
    });
    expect(
      within(dialog).getByRole("button", {
        name: "Revoke evidence ingress for good",
      }),
    ).toHaveAccessibleDescription(warning);
    expect(
      within(dialog).queryByRole("button", { name: "Pause evidence ingress" }),
    ).toBeNull();
    await expectNoAxe(document.body);
    // Back returns to both commands, and still sends nothing.
    await user.click(back);
    expect(within(dialog).queryByTestId("pause-cancel-warning")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Pause evidence ingress" }),
    ).toBeEnabled();
    expect(dispatchRunCommand).not.toHaveBeenCalled();
    // The confirming click is the one that sends the cancel.
    await cancelIngress(user, dialog);
    expect(dispatchRunCommand).toHaveBeenCalledTimes(1);
    expect(dispatchRunCommand).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "arun_ledger",
      "cancel",
      "",
    );
    expect(
      await within(dialog).findByTestId("ledger-applied"),
    ).toHaveTextContent("Further appends are refused");
  });

  // A paused row reads paused and links to its Run page, which offers Resume
  // (controls.test.tsx covers it there). The row sends no command and opens
  // no dialog.
  it("sends a ledger run whose ingress is paused to its Run page, where Resume is (negative)", async () => {
    await loaded({
      runs: ledgerRuns({ ingressPaused: true }),
      approvals: NO_APPROVALS,
    });
    const paused = row("arun_ledger");
    expect(paused.dataset.state).toBe("paused");
    expect(within(paused).getByTestId("row-open")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/arun_ledger",
    );
    expect(within(paused).queryByTestId("row-pause")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dispatchRunCommand).not.toHaveBeenCalled();
  });

  it("says a cancelled ledger run's ingress is revoked, and sends nothing (negative)", async () => {
    await loaded({
      runs: ledgerRuns({ ingressRevoked: true }),
      approvals: NO_APPROVALS,
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    expect(screen.getByTestId("pause-refusal")).toHaveTextContent(
      "Evidence ingress is revoked.",
    );
    for (const name of ["Pause evidence ingress", "Cancel evidence ingress"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByLabelText("Reason")).toBeDisabled();
    expect(dispatchRunCommand).not.toHaveBeenCalled();
    await expectNoAxe(document.body);
  });

  it("says a viewer cannot command a ledger run, and sends nothing (negative)", async () => {
    await renderFleet(
      { runs: ledgerRuns(), approvals: NO_APPROVALS },
      null,
      undefined,
      { ctx: viewerCtx },
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    expect(screen.getByTestId("pause-refusal")).toHaveTextContent(
      "Sending a command needs an organization Owner or Admin role",
    );
    for (const name of ["Pause evidence ingress", "Cancel evidence ingress"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(dispatchRunCommand).not.toHaveBeenCalled();
  });

  it("names the refusal a ledger cancel came back with, and claims no change (negative)", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "run_sealed",
    });
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    await cancelIngress(user, dialog);
    expect(await screen.findByTestId("pause-failure")).toBeInTheDocument();
    expect(screen.queryByTestId("ledger-applied")).toBeNull();
    // The confirm step stays, so the person can send it again or go back.
    expect(
      within(dialog).getByRole("button", {
        name: "Revoke evidence ingress for good",
      }),
    ).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Back" })).toBeEnabled();
  });

  it("says a ledger command no live run took, claims no change, and re-reads nothing on close (negative)", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: true,
      value: { commandIds: [] },
    });
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    await user.click(
      within(dialog).getByRole("button", { name: "Pause evidence ingress" }),
    );
    expect(
      await within(dialog).findByTestId("pause-failure"),
    ).toHaveTextContent("No live run took this command.");
    expect(within(dialog).queryByTestId("ledger-applied")).toBeNull();
    // Nothing changed, so closing the dialog has nothing to re-read.
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("pause-dialog")).toBeNull();
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says a ledger command went unanswered when the call throws, and claims no change (negative)", async () => {
    dispatchRunCommand.mockRejectedValue(new Error("socket hang up"));
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    await cancelIngress(
      user,
      screen.getByRole("dialog", { name: "Evidence ingress" }),
    );
    expect(await screen.findByTestId("pause-failure")).toBeInTheDocument();
    expect(screen.queryByTestId("ledger-applied")).toBeNull();
    expect(dispatchRunCommand).toHaveBeenCalledTimes(1);
  });

  it("names the cancel in flight on its own button and holds the way back until the ledger answers", async () => {
    let settle: (value: unknown) => void = () => undefined;
    dispatchRunCommand.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    await cancelIngress(user, dialog);
    expect(
      await within(dialog).findByRole("button", { name: "Cancelling" }),
    ).toBeDisabled();
    // Back waits too, so the confirm step cannot change under the answer.
    expect(within(dialog).getByRole("button", { name: "Back" })).toBeDisabled();
    settle({ ok: true, value: { commandIds: ["tcm_5"] } });
    expect(
      await within(dialog).findByTestId("ledger-applied"),
    ).toHaveTextContent("Further appends are refused");
    expect(dispatchRunCommand).toHaveBeenCalledTimes(1);
  });

  it("names a pause in flight on its own button and leaves Cancel's name alone", async () => {
    let settle: (value: unknown) => void = () => undefined;
    dispatchRunCommand.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await loaded({ runs: ledgerRuns(), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const dialog = screen.getByRole("dialog", { name: "Evidence ingress" });
    await user.click(
      within(dialog).getByRole("button", { name: "Pause evidence ingress" }),
    );
    expect(
      await within(dialog).findByRole("button", { name: "Queueing" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel evidence ingress" }),
    ).toBeDisabled();
    settle({ ok: true, value: { commandIds: ["tcm_6"] } });
    expect(
      await within(dialog).findByTestId("ledger-applied"),
    ).toHaveTextContent("Evidence ingress is paused.");
  });

  it("names the role before the revoked ingress for a viewer on a cancelled ledger run, as the Run page does (negative)", async () => {
    await renderFleet(
      { runs: ledgerRuns({ ingressRevoked: true }), approvals: NO_APPROVALS },
      null,
      undefined,
      { ctx: viewerCtx },
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    const refusal = screen.getByTestId("pause-refusal");
    expect(refusal).toHaveTextContent(
      "Sending a command needs an organization Owner or Admin role",
    );
    expect(refusal).not.toHaveTextContent("Evidence ingress is revoked.");
    expect(dispatchRunCommand).not.toHaveBeenCalled();
  });

  it("says why a run whose host stopped polling cannot be paused (negative)", async () => {
    await loaded({
      runs: runPage([
        // A wrapped run: a ledger run has no host for this block to name.
        runRow({
          id: "tse_quiet",
          source: "tacho",
          commandBlock: "host_offline",
        }),
      ]),
      approvals: NO_APPROVALS,
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-pause"));
    expect(screen.getByTestId("pause-refusal")).toHaveTextContent(
      "This run's host has not checked for commands in the last five minutes.",
    );
    expect(
      screen.getByRole("button", { name: "Pause at the next boundary" }),
    ).toBeDisabled();
    expect(dispatchRunCommand).not.toHaveBeenCalled();
  });

  it("names the refusal a pause came back with (negative)", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "host_offline",
    });
    await loaded();
    const user = userEvent.setup();
    await user.click(within(row("tse_live")).getByTestId("row-pause"));
    await user.click(
      screen.getByRole("button", { name: "Pause at the next boundary" }),
    );
    expect(await screen.findByTestId("pause-failure")).toBeInTheDocument();
  });

  it("queues an export from a sealed row and says so", async () => {
    exportFleetRun.mockResolvedValue({
      ok: true,
      value: { exportId: "rexp_1" },
    });
    await loaded();
    const user = userEvent.setup();
    await user.click(within(row("arun_sealed")).getByTestId("row-export"));
    expect(exportFleetRun).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "arun_sealed",
    );
    // The design confirms with a toast in the page's polite live region.
    const toast = await screen.findByText(
      "Export bundle queued for arun_sealed.",
    );
    expect(toast.closest("[data-toast]")).toHaveAttribute(
      "data-tone",
      "allowed",
    );
    expect(screen.getByTestId("runs-toasts")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("says an export was not queued when the handler refused it (negative)", async () => {
    exportFleetRun.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await loaded();
    const user = userEvent.setup();
    await user.click(within(row("arun_halted")).getByTestId("row-export"));
    const failed = await screen.findByText(
      /The export bundle for arun_halted was not queued/,
    );
    expect(failed.closest("[data-toast]")).toHaveAttribute(
      "data-tone",
      "failed",
    );
  });
});

describe("list controls", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    runRow({
      id: `arun_${String(i).padStart(2, "0")}`,
      status: "sealed",
      outcome: "completed",
      frames: 100 + i,
      enforcementTier: i % 3 === 0 ? "gateway" : "harness",
    }),
  );

  it("lists every run the read returned, and says when the read stopped before the oldest run", async () => {
    await loaded({ runs: runPage(many, "c2"), approvals: NO_APPROVALS });
    expect(rows()).toHaveLength(12);
    expect(screen.getByTestId("pager-range")).toHaveTextContent(
      "12 runs on this page",
    );
    expect(screen.getByRole("link", { name: "Older runs" })).toHaveAttribute(
      "href",
      "/acme/core-platform?cursor=c2",
    );
    expect(screen.getByTestId("rows-per-page")).toHaveValue("25");
  });

  it("saves a new page size in the cookie and reads the newest runs again at that size", async () => {
    await loaded({ runs: runPage(many, "c2"), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId("rows-per-page"), "50");
    expect(document.cookie).toContain("fleet_view=v1|50|");
    expect(refresh).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  it("goes back to the newest runs when the page size changes on a later page", async () => {
    await renderFleet(
      { runs: runPage(many), approvals: NO_APPROVALS },
      "c2",
      undefined,
      { pullRequests: "with" },
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId("rows-per-page"), "10");
    expect(push).toHaveBeenCalledWith("/acme/core-platform?prs=with");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reads again only when the page size actually changes (negative)", async () => {
    await loaded({ runs: runPage(many), approvals: NO_APPROVALS });
    fireEvent.change(screen.getByTestId("rows-per-page"), {
      target: { value: "25" },
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("fleet_view");
  });

  it("links back to the newest runs on a later read", async () => {
    await renderFleet({ runs: runPage(many), approvals: NO_APPROVALS }, "c2");
    expect(screen.getByRole("link", { name: "Newest runs" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    // A later cursor page is not rows 1–12 of 12: nothing counted it (#4370
    // review). It says how many rows it holds and nothing more.
    const range = screen.getByTestId("pager-range");
    expect(range).toHaveTextContent("12 runs on this page");
    expect(range).not.toHaveTextContent("1–12");
  });

  // #3837: the search, the facets, the order and the page are the read's.
  it("sends a search, a facet and a column's order to the read as a navigation", async () => {
    await loaded({ runs: runPage(many), approvals: NO_APPROVALS });
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "arun_07{Enter}");
    expect(push).toHaveBeenLastCalledWith("/acme/core-platform?q=arun_07");
    // The rows are the read's: typing filters nothing on this page.
    expect(rows()).toHaveLength(12);
    await user.selectOptions(screen.getByTestId("facet-tier"), "gateway");
    expect(push).toHaveBeenLastCalledWith("/acme/core-platform?tier=gateway");
    await user.click(screen.getByRole("button", { name: "Sort by Cost" }));
    expect(push).toHaveBeenLastCalledWith(
      "/acme/core-platform?sort=cost&dir=asc",
    );
  });

  it("sorts only the columns the read can order, and marks the order the URL asked for", async () => {
    const { calls } = await renderFleet(
      { runs: runPage(many), approvals: NO_APPROVALS },
      null,
      undefined,
      {
        list: {
          q: "",
          status: [],
          tier: [],
          replay: [],
          sort: "cost",
          dir: "desc",
          page: 1,
        },
      },
    );
    expect(calls.runs[0]?.[1]).toMatchObject({
      sort: { key: "cost", dir: "desc" },
    });
    const cost = screen.getByRole("button", { name: "Sort by Cost" });
    expect(cost.closest("th")).toHaveAttribute("aria-sort", "descending");
    // Frames, Run, Pull requests and Lines have no single order in both
    // stores, so their headers do not sort.
    for (const column of ["Frames", "Run", "Lines"])
      expect(
        screen.queryByRole("button", { name: `Sort by ${column}` }),
      ).toBeNull();
    const user = userEvent.setup();
    await user.click(cost);
    expect(push).toHaveBeenLastCalledWith("/acme/core-platform");
  });

  it("reads the pager from the read's total, with page buttons to the last page", async () => {
    const { container } = await loaded({
      runs: readOk({
        runs: many,
        nextCursor: null,
        total: 279,
        totalBound: 10_000,
      }),
      approvals: NO_APPROVALS,
    });
    expect(screen.getByTestId("pager-range")).toHaveTextContent("1–12 of 279");
    expect(screen.getByRole("link", { name: "Page 12" })).toHaveAttribute(
      "href",
      "/acme/core-platform?page=12",
    );
    await expectNoAxe(container);
  });

  it("reads page N at its offset and keeps the list on the pager's links", async () => {
    const { calls } = await renderFleet(
      {
        runs: readOk({
          runs: many,
          nextCursor: null,
          total: 279,
          totalBound: 10_000,
        }),
        approvals: NO_APPROVALS,
      },
      null,
      undefined,
      {
        list: {
          q: "deploy",
          status: ["sealed"],
          tier: [],
          replay: [],
          sort: "started",
          dir: "desc",
          page: 3,
        },
      },
    );
    expect(calls.runs[0]?.[1]).toEqual({
      cursor: null,
      limit: 25,
      pullRequests: "any",
      status: ["sealed"],
      query: "deploy",
      offset: 50,
      count: true,
      countLive: true,
    });
    expect(screen.getByTestId("pager-range")).toHaveTextContent("51–62 of 279");
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "/acme/core-platform?q=deploy&status=sealed&page=2",
    );
  });

  it("keeps the table and says no rows match when a search finds none (negative)", async () => {
    const { calls } = await renderFleet(
      {
        runs: readOk({
          runs: [],
          nextCursor: null,
          total: 0,
          totalBound: 10_000,
        }),
        approvals: NO_APPROVALS,
      },
      null,
      undefined,
      {
        list: {
          q: "zzz",
          status: [],
          tier: [],
          replay: [],
          sort: "started",
          dir: "desc",
          page: 1,
        },
      },
    );
    expect(calls.runs[0]?.[1]).toMatchObject({ query: "zzz" });
    expect(screen.queryByTestId("fleet-empty")).toBeNull();
    expect(runsPanel()).toHaveTextContent("No rows match.");
    expect(screen.getByTestId("pager-range")).toHaveTextContent("0 of 0");
    expect(screen.getByRole("searchbox")).toHaveValue("zzz");
  });
});

describe("not-loaded states", () => {
  it("empty: says how a run arrives and offers Register Agent and Open Agents, with no header or table", async () => {
    await renderFleet({ runs: runPage([]), approvals: NO_APPROVALS });
    const empty = screen.getByTestId("fleet-empty");
    expect(
      within(empty).getByRole("heading", {
        name: "No runs yet in Core platform",
      }),
    ).toBeInTheDocument();
    expect(empty).toHaveTextContent(
      "Nothing has reached Oxagen from this workspace. A run appears the moment a registered agent makes its first model call. You do not create runs here. Agents do.",
    );
    expect(
      within(empty).getByRole("link", { name: "Register Agent" }),
    ).toHaveAttribute("href", "/acme/core-platform/register/name");
    expect(
      within(empty).getByRole("link", { name: "Open Agents" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents");
    // The CLI path to a first run (#2950): the enroll command, set as code.
    const enroll = within(empty).getByTestId("fleet-empty-enroll");
    expect(enroll).toHaveTextContent(
      "To record an agent that already runs on a machine, run oxagen agent enroll on that machine.",
    );
    expect(within(enroll).getByText("oxagen agent enroll").tagName).toBe(
      "CODE",
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps the table on a later read that came back empty", async () => {
    await renderFleet({ runs: runPage([]), approvals: NO_APPROVALS }, "c9");
    expect(screen.queryByTestId("fleet-empty")).toBeNull();
    expect(runsPanel()).toHaveTextContent("No rows match.");
  });

  it("error: names the code, offers Try again and Open an incident, and prints the failure line", async () => {
    await renderFleet({ runs: DOWN, approvals: NO_APPROVALS });
    const error = screen.getByTestId("fleet-error");
    expect(
      within(error).getByRole("heading", {
        name: "Fleet could not be loaded",
      }),
    ).toBeInTheDocument();
    expect(error).toHaveTextContent(
      "The control plane answered 503 run_index_unavailable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    // This read recorded no trace id or region (#3841), and each part says
    // so; the instant is the design's UTC form.
    expect(screen.getByTestId("fleet-error-trace").textContent).toMatch(
      /^trace not recorded · region not recorded · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
    );
    expect(screen.getByTestId("fleet-error-trace-id")).toHaveAttribute(
      "data-recorded",
      "false",
    );
    expect(screen.getByTestId("fleet-error-region")).toHaveAttribute(
      "data-recorded",
      "false",
    );
    expect(screen.queryByTestId("fleet-error-request")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    // The design's errorState glyph: a circle with an exclamation mark, in
    // the failed tone alone.
    const glyph = error.querySelector("[data-state-icon]");
    expect(glyph).toHaveAttribute("data-state-icon", "failed");
    expect(glyph?.querySelector("circle")).not.toBeNull();
    expect(glyph).toHaveClass("border-error/40");
    expect(glyph).not.toHaveClass("border-border");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Open an incident" }));
    const dialog = screen.getByRole("dialog", { name: "Open an incident" });
    expect(within(dialog).getByLabelText("Subject")).toHaveValue(
      "503 run_index_unavailable",
    );
    expect(
      within(within(dialog).getByLabelText("Severity"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "critical — money moved that Oxagen did not govern",
      "warning",
      "info",
    ]);
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
    const attach = within(dialog).getByRole("list", { name: "Attach" });
    expect(
      within(attach)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "503 run_index_unavailable",
      "core-platform",
      expect.stringMatching(/Z$/),
    ]);
    expect(screen.getByTestId("incident-unbacked")).toHaveTextContent(
      "cannot be sent",
    );
    expect(screen.getByRole("button", { name: "Raise it" })).toBeDisabled();
  });

  it("access denied: names the permission, offers Request access and Back to Fleet, and says who is signed in", async () => {
    await renderFleet({ runs: DENIED, approvals: NO_APPROVALS });
    const denied = screen.getByTestId("fleet-denied");
    expect(
      within(denied).getByRole("heading", {
        name: "You cannot see this workspace",
      }),
    ).toBeInTheDocument();
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include workspace.read on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(denied).toHaveTextContent(
      "Signed in asMarcus Bell · workspace.member · core-platform",
    );
    expect(denied).toHaveTextContent("Neededworkspace.read on core-platform");
    expect(denied).toHaveTextContent(
      "Decided bypolicy not recorded · deny wins over every allow",
    );
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = screen.getByRole("dialog", { name: "Request access" });
    expect(within(dialog).getByLabelText("Role requested")).toHaveValue(
      "workspace.read on core-platform",
    );
    expect(screen.getByTestId("request-access-unbacked")).toHaveTextContent(
      "cannot be sent",
    );
    expect(
      screen.getByRole("button", { name: "Send the request" }),
    ).toBeDisabled();
  });

  // #3841: the error line and Decided by read from the record.
  it("error: prints the trace, the region and the request the seam recorded, and attaches them to an incident", async () => {
    const { container } = await renderFleet({
      runs: readError("run_index_unavailable", 503, {
        traceId: "01K5RSXQ7F2E",
        region: "us-east-1",
        requestId: "0192f1c4-0000-7000-8000-00000000c0de",
      }),
      approvals: NO_APPROVALS,
    });
    expect(screen.getByTestId("fleet-error-trace").textContent).toMatch(
      /^trace 01K5RSXQ7F2E · us-east-1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z · request 0192f1c4-0000-7000-8000-00000000c0de$/,
    );
    for (const id of ["fleet-error-trace-id", "fleet-error-region"])
      expect(screen.getByTestId(id)).toHaveAttribute("data-recorded", "true");
    await expectNoAxe(container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open an incident" }));
    const attach = within(
      screen.getByRole("dialog", { name: "Open an incident" }),
    ).getByRole("list", { name: "Attach" });
    expect(
      within(attach)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "503 run_index_unavailable",
      "core-platform",
      expect.stringMatching(/Z$/),
      "trace 01K5RSXQ7F2E",
      "request 0192f1c4-0000-7000-8000-00000000c0de",
    ]);
  });

  it("error: says which part was not recorded when only some were", async () => {
    await renderFleet({
      runs: readError("run_index_unavailable", 503, {
        traceId: null,
        region: "us-east-1",
      }),
      approvals: NO_APPROVALS,
    });
    expect(screen.getByTestId("fleet-error-trace").textContent).toMatch(
      /^trace not recorded · us-east-1 · /,
    );
    expect(screen.getByTestId("fleet-error-trace-id")).toHaveAttribute(
      "data-recorded",
      "false",
    );
  });

  it("access denied: names the IAM rule that decided", async () => {
    const { container } = await renderFleet({
      runs: {
        ...DENIED,
        decidedBy: { source: "iam", id: "8:default" },
        traceId: null,
        region: null,
      },
      approvals: NO_APPROVALS,
    });
    const decided = screen.getByTestId("fleet-decided-by");
    expect(decided).toHaveTextContent("IAM rule 8:default");
    // 8:default means no grant matched. No deny beat an allow, so the line
    // does not say one did (#4370 review).
    expect(decided).not.toHaveTextContent("deny wins");
    expect(decided).toHaveAttribute("data-recorded", "true");
    expect(within(decided).getByText("8:default").tagName).toBe("CODE");
    expect(screen.getByTestId("fleet-denied")).toHaveTextContent(
      "do not include workspace.read on core-platform",
    );
    await expectNoAxe(container);
  });

  it("access denied: names the decision rule that refused the read, and says a rule refused it", async () => {
    await renderFleet({
      runs: {
        ...DENIED,
        decidedBy: { source: "decision_rule", id: "rul_no_weekend_reads" },
      },
      approvals: NO_APPROVALS,
    });
    expect(screen.getByTestId("fleet-decided-by")).toHaveTextContent(
      "decision rule rul_no_weekend_reads",
    );
    expect(screen.getByTestId("fleet-denied")).toHaveTextContent(
      "A decision rule on Acme Robotics refused this read.",
    );
  });

  it("access denied: says the rule was not recorded when the record names none", async () => {
    await renderFleet({
      runs: { ...DENIED, decidedBy: null },
      approvals: NO_APPROVALS,
    });
    const decided = screen.getByTestId("fleet-decided-by");
    expect(decided).toHaveTextContent(
      "policy not recorded · deny wins over every allow",
    );
    expect(decided).toHaveAttribute("data-recorded", "false");
  });

  it("pending: carries the id of the access request still waiting", async () => {
    await renderFleet({
      runs: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_91",
      },
      approvals: NO_APPROVALS,
    });
    expect(screen.getByTestId("fleet-pending")).toHaveTextContent("acr_91");
  });
});
