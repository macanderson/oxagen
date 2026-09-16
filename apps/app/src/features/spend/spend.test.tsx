// @vitest-environment jsdom
// The Spend page body in each of its states: every tab on a fake DataSource,
// one key's drill, a period with nothing rolled up, and each refusal a read can
// answer. Every money figure carries its basis or prints "not recorded"; axe
// checks the state each test ends in (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cost } from "@/data/contracts/money";
import type {
  SpendBudgets,
  SpendDrill,
  SpendFigure,
  SpendReport,
  SpendWaste,
} from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import messages from "../../../messages/spend.json";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
// The dialogs beside the tabs have their own tests (dialogs.test.tsx).
vi.mock("./actions", () => ({
  setBudgetAction: vi.fn(),
  exportStatementAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Spend } = await import("./spend");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
});

const TODAY = new Date("2026-09-15T12:00:00.000Z");
const PERIOD = { from: "2026-09-01", to: "2026-09-15" };

const cost = (micros: string, basis: Cost["basis"] = "gateway_observed") => ({
  micros,
  currency: "USD",
  basis,
});

function figure(over: Partial<SpendFigure> = {}): SpendFigure {
  return {
    cost: cost("12345678"),
    calls: 1240,
    runs: 12,
    proven: null,
    accepted: { micros: "2000000", currency: "USD" },
    productiveRatio: 0.6,
    ...over,
  };
}

function report(
  rows: SpendReport["rows"],
  total: SpendFigure = figure(),
): Read<SpendReport> {
  return readOk({ period: PERIOD, total, rows });
}

const row = (key: string, over: Partial<SpendReport["rows"][number]> = {}) => ({
  ...figure(),
  key,
  provider: null,
  ...over,
});

const byGroup = vi.fn<DataSource["spend"]["byGroup"]>();
const drill = vi.fn<DataSource["spend"]["drill"]>();
const waste = vi.fn<DataSource["spend"]["waste"]>();
const budgets = vi.fn<DataSource["spend"]["budgets"]>();
const source: DataSource = {
  pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
  shell: { context: vi.fn() },
  billing: {
    plan: vi.fn(),
    bucket: vi.fn(),
    contractRate: vi.fn(),
    invoices: vi.fn(),
  },
  runs: { list: vi.fn() },
  approvals: { pending: vi.fn() },
  agents: {
    list: vi.fn(),
    get: vi.fn(),
    toolbelt: vi.fn(),
    incidents: vi.fn(),
  },
  spend: { byGroup, fleet: vi.fn(), drill, waste, budgets },
  org: { members: vi.fn() },
  skills: { inventory: vi.fn() },
  steering: { records: vi.fn(), proposals: vi.fn(), contextPr: vi.fn() },
};

async function renderSpend(searchParams: Record<string, string> = {}) {
  const element = await Spend({ ctx, source, searchParams, today: TODAY });
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {element}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  byGroup.mockReset();
  drill.mockReset();
  waste.mockReset();
  budgets.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function rowOf(key: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`tr[data-key="${key}"]`);
  if (found === null) throw new Error(`no row ${key}`);
  return found;
}

describe("Spend › By operator", () => {
  it("prints the month's total with its basis, keeps proven and accepted apart, and opens each operator's drill", async () => {
    byGroup.mockResolvedValue(
      report([
        row("prn_marcusbell", { cost: cost("9000000", "mixed") }),
        row("prn_ada", { cost: null, productiveRatio: null }),
      ]),
    );
    await renderSpend();

    expect(byGroup).toHaveBeenCalledExactlyOnceWith(ctx, "operator", PERIOD);
    const strip = screen.getByText("Spend", { selector: "dt" }).closest("div");
    expect(strip).toHaveTextContent("$12.35");
    expect(strip).toHaveTextContent("gateway observed");
    expect(strip).toHaveTextContent("2026-09-01 to 2026-09-15");
    expect(screen.getByText("Proven spend").closest("div")).toHaveTextContent(
      "not recorded",
    );
    expect(
      screen.getByText("Accepted, not proven").closest("div"),
    ).toHaveTextContent("$2.00");
    expect(screen.getByRole("link", { name: "By operator" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const marcus = rowOf("prn_marcusbell");
    expect(marcus.querySelector("[data-basis]")).toHaveAttribute(
      "data-basis",
      "mixed",
    );
    expect(
      within(marcus).getByRole("link", { name: "prn_marcusbell" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/spend?tab=operator&drill=prn_marcusbell",
    );
    expect(within(marcus).getByText("1,240")).toBeInTheDocument();
  });

  it("prints a group no frame priced as not recorded, never as a zero", async () => {
    byGroup.mockResolvedValue(
      report([row("prn_ada", { cost: null, productiveRatio: null })]),
    );
    await renderSpend();
    const ada = rowOf("prn_ada");
    expect(ada.querySelector("[data-testid=money]")).toBeNull();
    expect(within(ada).getAllByText("not recorded")).toHaveLength(3);
    expect(ada).not.toHaveTextContent("$0.00");
  });

  it("says basis not recorded where a cost carries no basis", async () => {
    byGroup.mockResolvedValue(
      report([row("prn_ada", { cost: cost("500000", null) })]),
    );
    await renderSpend();
    expect(rowOf("prn_ada").querySelector("[data-basis]")).toHaveTextContent(
      "basis not recorded",
    );
  });

  it("renders the empty state, with the way back to Fleet, for a period with nothing rolled up", async () => {
    byGroup.mockResolvedValue(
      report([], figure({ cost: null, calls: 0, runs: 0 })),
    );
    await renderSpend();
    expect(
      screen.getByRole("heading", { name: "No spend to report yet" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Fleet" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Spend › By agent and By tool", () => {
  it("reads agents and models; a model row names its provider and opens no drill", async () => {
    byGroup.mockImplementation((_ctx, groupBy) =>
      Promise.resolve(
        groupBy === "agent"
          ? report([row("acme/core-platform/triage")])
          : report([
              row("claude-sonnet-5", { provider: "anthropic" }),
              row("unpriced-model", { cost: cost("100", "estimated") }),
            ]),
      ),
    );
    await renderSpend({ tab: "agent" });

    expect(byGroup).toHaveBeenCalledWith(ctx, "agent", PERIOD);
    expect(byGroup).toHaveBeenCalledWith(ctx, "model", PERIOD);
    expect(
      within(rowOf("acme/core-platform/triage")).getByRole("link"),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/spend?tab=agent&drill=acme%2Fcore-platform%2Ftriage",
    );
    const model = rowOf("claude-sonnet-5");
    expect(within(model).queryByRole("link")).toBeNull();
    expect(model).toHaveTextContent("anthropic");
    expect(rowOf("unpriced-model")).toHaveTextContent("not recorded");
    expect(
      rowOf("unpriced-model").querySelector("[data-basis]"),
    ).toHaveTextContent("estimated");
  });

  it("names the empty table of a level no run named", async () => {
    byGroup.mockResolvedValue(report([]));
    await renderSpend({ tab: "tool" });
    expect(byGroup).toHaveBeenCalledExactlyOnceWith(ctx, "tool", PERIOD);
    expect(
      screen.getByText("No tool call in this period has been rolled up."),
    ).toBeInTheDocument();
  });

  it("replaces the body when the models read fails after the agents read answered (negative)", async () => {
    byGroup.mockImplementation((_ctx, groupBy) =>
      Promise.resolve(
        groupBy === "agent"
          ? report([row("acme/core-platform/triage")])
          : readError("rollup_rebuild_in_progress", 504),
      ),
    );
    await renderSpend({ tab: "agent" });
    expect(
      screen.getByRole("heading", { name: "Spend could not be loaded" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Spend › Wasted spend", () => {
  const found: SpendWaste = {
    wasted: cost("900000"),
    share: 0.073,
    runsWithWaste: 2,
    largestCause: "cache_write_never_read",
    causes: [
      {
        cause: "cache_write_never_read",
        wasted: cost("900000"),
        runs: 2,
        provingRuns: ["arun_01k5rn8f3j", "tse_01k5rn9t4"],
      },
    ],
  };

  it("prints the wasted total with its basis and links each cause to the runs that prove it", async () => {
    byGroup.mockResolvedValue(report([]));
    waste.mockResolvedValue(readOk(found));
    await renderSpend({ tab: "waste" });

    expect(waste).toHaveBeenCalledExactlyOnceWith(ctx, PERIOD);
    expect(screen.getByText("Share of spend").closest("div")).toHaveTextContent(
      "7.3%",
    );
    const cause = document.querySelector<HTMLElement>(
      '[data-cause="cache_write_never_read"]',
    );
    expect(cause).toHaveTextContent("Cache written and never read");
    expect(cause?.querySelector("[data-basis]")).toHaveAttribute(
      "data-basis",
      "gateway_observed",
    );
    expect(screen.getByRole("link", { name: "tse_01k5rn9t4" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_01k5rn9t4",
    );
  });

  it("says no run shows waste, and prints no wasted amount, when none was found", async () => {
    byGroup.mockResolvedValue(report([]));
    waste.mockResolvedValue(
      readOk({
        wasted: null,
        share: null,
        runsWithWaste: 0,
        largestCause: null,
        causes: [],
      }),
    );
    await renderSpend({ tab: "waste" });
    expect(
      screen.getByText("No run in this period shows waste in its frames."),
    ).toBeInTheDocument();
    expect(screen.getByText("Wasted").closest("div")).toHaveTextContent(
      "not recorded",
    );
    expect(screen.getByText("No waste found")).toBeInTheDocument();
  });
});

describe("Spend › Budgets", () => {
  const ceilings: SpendBudgets = [
    {
      scope: "org",
      enabled: true,
      period: "monthly",
      windowDays: null,
      limit: { micros: "500000000", currency: "USD" },
      spent: { micros: "410000000", currency: "USD" },
      ratio: 0.82,
      state: "threshold_80",
    },
    {
      scope: "workspace",
      enabled: false,
      period: "rolling",
      windowDays: 7,
      limit: { micros: "50000000", currency: "USD" },
      spent: { micros: "1000000", currency: "USD" },
      ratio: 0.02,
      state: "ok",
    },
  ];

  it("prints each ceiling's period, limit, spend and position", async () => {
    byGroup.mockResolvedValue(report([]));
    budgets.mockResolvedValue(readOk(ceilings));
    await renderSpend({ tab: "budgets" });

    const org = document.querySelector<HTMLElement>('tr[data-scope="org"]');
    expect(org).toHaveTextContent("Organization");
    expect(org).toHaveTextContent("Monthly");
    expect(org).toHaveTextContent("$500.00");
    expect(org).toHaveTextContent("$410.00");
    expect(org).toHaveTextContent("82% · past 80%");
    const ws = document.querySelector<HTMLElement>(
      'tr[data-scope="workspace"]',
    );
    expect(ws).toHaveTextContent("Rolling 7 days");
    expect(ws).toHaveTextContent("Not enforced");
  });

  it("offers Export report and Set a budget beside the tabs, on a drill too", async () => {
    byGroup.mockResolvedValue(report([]));
    budgets.mockResolvedValue(readOk([]));
    await renderSpend({ tab: "budgets" });
    expect(
      screen.getByRole("button", { name: "Export report" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set a budget" }),
    ).toBeInTheDocument();
    cleanup();

    drill.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
    await renderSpend({ tab: "agent", drill: "acme/core-platform/triage" });
    expect(
      screen.getByRole("button", { name: "Set a budget" }),
    ).toBeInTheDocument();
  });

  it("says no ceiling is set when there is none", async () => {
    byGroup.mockResolvedValue(report([]));
    budgets.mockResolvedValue(readOk([]));
    await renderSpend({ tab: "budgets" });
    expect(
      screen.getByText(
        "No spend ceiling is set for this workspace or its organization.",
      ),
    ).toBeInTheDocument();
  });
});

describe("Spend › drill", () => {
  const operator: SpendDrill = {
    kind: "operator",
    key: "prn_marcusbell",
    period: { from: "2026-08-17", to: "2026-09-15" },
    total: figure(),
    series: [
      { day: "2026-09-14", cost: cost("3000000"), calls: 30, runs: 2 },
      { day: "2026-09-15", cost: null, calls: 0, runs: 0 },
    ],
    perCall: { micros: "4200", currency: "USD" },
    perRun: { micros: "1028806", currency: "USD" },
    share: 0.31,
    tools: [{ name: "github__create_pull_request", calls: 9, runs: 3 }],
  };

  it("reads one operator's drill and no rollup, printing averages to the micro and a day with no priced run as not recorded", async () => {
    drill.mockResolvedValue(readOk(operator));
    await renderSpend({ tab: "operator", drill: "prn_marcusbell" });

    expect(drill).toHaveBeenCalledExactlyOnceWith(
      ctx,
      "operator",
      "prn_marcusbell",
    );
    expect(byGroup).not.toHaveBeenCalled();
    expect(
      screen.getByText("Average per call").closest("div"),
    ).toHaveTextContent("$0.0042");
    expect(
      screen.getByText("Average per run").closest("div"),
    ).toHaveTextContent("$1.028806");
    expect(
      document.querySelector('tr[data-day="2026-09-15"]'),
    ).toHaveTextContent("not recorded");
    expect(rowOf("github__create_pull_request")).toHaveTextContent("9");
    expect(
      screen.getByRole("link", { name: "Back to the table" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend?tab=operator");
  });

  it("prints a tool drill's money as not recorded and its empty tool list", async () => {
    drill.mockResolvedValue(
      readOk({
        ...operator,
        kind: "tool",
        key: "github__merge",
        total: figure({ cost: null, accepted: null, productiveRatio: null }),
        perCall: null,
        perRun: null,
        share: null,
        tools: [],
      }),
    );
    await renderSpend({ tab: "tool", drill: "github__merge" });
    expect(
      screen.getByText("Average per call").closest("div"),
    ).toHaveTextContent("not recorded");
    expect(
      screen.getByText("Its runs called no tools in this window."),
    ).toBeInTheDocument();
  });
});

describe("Spend › refusals", () => {
  it.each<[string, Read<never>, string, string]>([
    [
      "denied",
      { ok: false, reason: "denied", permission: "spend.read" },
      "You cannot see this workspace’s spend",
      "spend.read",
    ],
    [
      "pending_approval",
      { ok: false, reason: "pending_approval", accessRequestId: "acr_01k5" },
      "Access to this workspace’s spend is waiting for approval",
      "acr_01k5",
    ],
    [
      "error",
      readError("rollup_rebuild_in_progress", 504),
      "Spend could not be loaded",
      "rollup_rebuild_in_progress · 504",
    ],
  ])(
    "renders the %s state in place of the body, keeping the tabs (negative)",
    async (state, read, title, detail) => {
      byGroup.mockResolvedValue(read);
      await renderSpend({ tab: "tool" });
      const section = document.querySelector(`[data-state="${state}"]`);
      expect(section).toHaveTextContent(title);
      expect(section).toHaveTextContent(detail);
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByRole("navigation")).toBeInTheDocument();
    },
  );

  it("renders a refused drill, and a refused budgets read, in place of the body (negative)", async () => {
    drill.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
    await renderSpend({ tab: "agent", drill: "acme/core-platform/triage" });
    expect(document.querySelector('[data-state="denied"]')).not.toBeNull();
    cleanup();

    byGroup.mockResolvedValue(report([]));
    budgets.mockResolvedValue(readError("rollup_rebuild_in_progress", 504));
    await renderSpend({ tab: "budgets" });
    expect(document.querySelector('[data-state="error"]')).not.toBeNull();
  });

  it("renders a refused waste read in place of the body (negative)", async () => {
    byGroup.mockResolvedValue(report([]));
    waste.mockResolvedValue(readError("rollup_rebuild_in_progress", 504));
    await renderSpend({ tab: "waste" });
    expect(document.querySelector('[data-state="error"]')).not.toBeNull();
    expect(document.querySelector("[data-cause]")).toBeNull();
  });
});
