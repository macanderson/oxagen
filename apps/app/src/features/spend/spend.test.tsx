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
  SpendFinding,
  SpendFindingEvidence,
  SpendFindings,
  SpendReport,
  SpendWaste,
} from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import messages from "../../../messages/spend.json";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
// The dialogs beside the tabs and on each finding have their own tests
// (dialogs.test.tsx).
vi.mock("./actions", () => ({
  setBudgetAction: vi.fn(),
  exportStatementAction: vi.fn(),
  recordFindingFixAction: vi.fn(),
  dismissFindingAction: vi.fn(),
  setPriceEntryAction: vi.fn(),
  removePriceEntryAction: vi.fn(),
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
  wsRole: "member",
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
const findings = vi.fn<DataSource["spend"]["findings"]>();
const findingEvidence = vi.fn<DataSource["spend"]["findingEvidence"]>();
const priceBook = vi.fn<DataSource["spend"]["priceBook"]>();
const unpricedModels = vi.fn<DataSource["spend"]["unpricedModels"]>();
const source: DataSource = {
  pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
  shell: { context: vi.fn(), preferences: vi.fn() },
  billing: {
    plan: vi.fn(),
    usageCredits: vi.fn(),
    bucket: vi.fn(),
    contractRate: vi.fn(),
    invoices: vi.fn(),
  },
  runs: {
    list: vi.fn(),
    get: vi.fn(),
    frameBody: vi.fn(),
    cost: vi.fn(),
    transcript: vi.fn(),
    chain: vi.fn(),
  },
  approvals: { pending: vi.fn(), resolved: vi.fn() },
  agents: {
    list: vi.fn(),
    get: vi.fn(),
    toolbelt: vi.fn(),
    incidents: vi.fn(),
  },
  spend: {
    byGroup,
    fleet: vi.fn(),
    drill,
    waste,
    budgets,
    findings,
    findingEvidence,
    priceBook,
    unpricedModels,
  },
  onboarding: { state: vi.fn(), firstFrame: vi.fn() },
  org: {
    members: vi.fn(),
    roles: vi.fn(),
    workspaces: vi.fn(),
    apiKeys: vi.fn(),
    modelCredential: vi.fn(),
  },
  mandates: { list: vi.fn(), get: vi.fn() },
  audit: { events: vi.fn(), exportEvents: vi.fn() },
  skills: { inventory: vi.fn() },
  steering: {
    records: vi.fn(),
    proposals: vi.fn(),
    contextPr: vi.fn(),
    freshness: vi.fn(),
  },
  tools: {
    versions: vi.fn(),
    grants: vi.fn(),
    killSwitches: vi.fn(),
    approvalRules: vi.fn(),
    connections: vi.fn(),
    mcpServers: vi.fn(),
  },
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
  findings.mockReset();
  findingEvidence.mockReset();
  priceBook.mockReset();
  unpricedModels.mockReset();
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
  it("prints the month's total with its basis, omits outcome scores, and opens each operator's drill", async () => {
    byGroup.mockResolvedValue(
      report([
        row("prn_marcusbell", { cost: cost("9000000", "mixed") }),
        row("prn_ada", { cost: null, productiveRatio: null }),
      ]),
    );
    await renderSpend({ tab: "operator" });

    expect(byGroup).toHaveBeenCalledExactlyOnceWith(ctx, "operator", PERIOD);
    const strip = screen.getByText("Spend", { selector: "dt" }).closest("div");
    expect(strip).toHaveTextContent("$12.35");
    expect(strip).toHaveTextContent("gateway observed");
    expect(strip).toHaveTextContent("2026-09-01 to 2026-09-15");
    expect(screen.queryByText("Proven spend")).toBeNull();
    expect(screen.queryByText("Accepted, not proven")).toBeNull();
    expect(screen.queryByText("Productive ratio")).toBeNull();
    expect(
      screen.getByText("Runs", { selector: "dt" }).closest("div"),
    ).toHaveTextContent("12");
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
    await renderSpend({ tab: "operator" });
    const ada = rowOf("prn_ada");
    expect(ada.querySelector("[data-testid=money]")).toBeNull();
    expect(within(ada).getAllByText("not recorded")).toHaveLength(1);
    expect(ada).not.toHaveTextContent("$0.00");
  });

  it("says basis not recorded where a cost carries no basis", async () => {
    byGroup.mockResolvedValue(
      report([row("prn_ada", { cost: cost("500000", null) })]),
    );
    await renderSpend({ tab: "operator" });
    expect(rowOf("prn_ada").querySelector("[data-basis]")).toHaveTextContent(
      "basis not recorded",
    );
  });

  it("renders the empty state, with the way back to Fleet, for a period with nothing rolled up", async () => {
    byGroup.mockResolvedValue(
      report([], figure({ cost: null, calls: 0, runs: 0 })),
    );
    await renderSpend({ tab: "operator" });
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

describe("Spend › Findings", () => {
  const span = {
    from: "2026-08-16T00:00:00.000Z",
    to: "2026-09-15T00:00:00.000Z",
  };

  function found(over: Partial<SpendFinding> = {}): SpendFinding {
    return {
      id: "fnd_01k5rtgh",
      kind: "unpaged_results",
      level: "tool",
      subject: "aws_billing__get_cost_and_usage",
      saving: cost("984600000"),
      confidence: "high",
      window: span,
      why: "Each run requests thirty days of line items unpaged.",
      fix: "Request grouped totals; page line items only on drill-down.",
      runs: 88,
      calls: 3106,
      ...over,
    };
  }

  const second = found({
    id: "fnd_01k5rteg",
    kind: "repeated_shell_commands",
    level: "agent",
    subject: "a-intel.core.stella-ci",
    saving: cost("486200000"),
    confidence: "medium",
    runs: 1912,
    calls: 8841,
  });

  function listed(over: Partial<SpendFindings> = {}): SpendFindings {
    return {
      window: span,
      saving: cost("1470800000"),
      spend: cost("18402660000", "mixed"),
      share: 0.64,
      annualised: cost("17649600000"),
      counts: { findings: 2, high: 1, medium: 1, operators: 3 },
      findings: [found(), second],
      ...over,
    };
  }

  it("leads with the savings identified, prints each finding's share of them, and opens each finding's evidence", async () => {
    byGroup.mockResolvedValue(report([]));
    findings.mockResolvedValue(readOk(listed()));
    await renderSpend({ tab: "findings" });

    expect(findings).toHaveBeenCalledExactlyOnceWith(ctx);
    const saving = screen
      .getByText("Potential savings", { selector: "dt" })
      .closest("div");
    expect(saving).toHaveTextContent("$1,470.80");
    expect(saving).toHaveTextContent("estimated reduction");
    expect(saving?.querySelector("[data-basis]")).toBeNull();
    expect(saving).toHaveTextContent("Cost data: gateway observed");
    expect(
      screen.getByText("Share of priced spend").closest("div"),
    ).toHaveTextContent("64%");
    expect(
      screen.getByText("A year at this run rate").closest("div"),
    ).toHaveTextContent("$17,649.60");
    expect(
      screen.getByRole("img", {
        name: "Share of the identified savings by finding",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("66.9%")).toBeInTheDocument();
    expect(screen.getByText("33.1%")).toBeInTheDocument();
    expect(
      screen.getByText(
        "2 findings · 3 operators involved · 1 high confidence · 1 medium",
      ),
    ).toBeInTheDocument();

    const card = document.querySelector<HTMLElement>(
      'li[data-finding="fnd_01k5rtgh"]',
    );
    expect(card).toHaveAttribute("data-confidence", "high");
    expect(card).toHaveTextContent("Unpaged results");
    expect(card).toHaveTextContent("aws_billing__get_cost_and_usage");
    expect(card).toHaveTextContent("88 runs · 3,106 calls");
    expect(card).toHaveTextContent("$984.60");
    expect(card).toHaveTextContent("Cost data: gateway observed");
    expect(card).toHaveTextContent("66.9% of the identified savings");
    expect(
      within(card ?? document.body).getByRole("link", {
        name: "Review calculation",
      }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/spend?tab=findings&finding=fnd_01k5rtgh",
    );
    expect(
      within(card ?? document.body).getByRole("button", { name: "Review fix" }),
    ).toBeInTheDocument();
  });

  it.each<[Cost["basis"], string]>([
    ["client_attested", "client attested"],
    ["estimated", "estimated"],
    [null, "basis not recorded"],
  ])("keeps %s provenance beside potential savings", async (basis, label) => {
    byGroup.mockResolvedValue(report([]));
    findings.mockResolvedValue(
      readOk(
        listed({
          saving: cost("1000000", basis),
          findings: [found({ saving: cost("1000000", basis) })],
        }),
      ),
    );
    await renderSpend({ tab: "findings" });
    const hero = screen
      .getByText("Potential savings", { selector: "dt" })
      .closest("div");
    expect(hero).toHaveTextContent(`Cost data: ${label}`);
    expect(document.querySelector("li[data-finding]")).toHaveTextContent(
      `Cost data: ${label}`,
    );
  });

  it("names the largest eight in the legend and rolls the rest into one entry", async () => {
    const many = Array.from({ length: 10 }, (_item, index) =>
      found({ id: `fnd_0${String(index)}`, saving: cost("100000000") }),
    );
    byGroup.mockResolvedValue(report([]));
    findings.mockResolvedValue(
      readOk(
        listed({
          saving: cost("1000000000"),
          counts: { findings: 10, high: 10, medium: 0, operators: 1 },
          findings: many,
        }),
      ),
    );
    await renderSpend({ tab: "findings" });
    expect(screen.getByText("2 smaller findings")).toBeInTheDocument();
    expect(screen.getAllByText("10%")).toHaveLength(8);
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(document.querySelectorAll("li[data-finding]")).toHaveLength(10);
  });

  it("says no finding is open, printing no total it was not given", async () => {
    byGroup.mockResolvedValue(report([]));
    findings.mockResolvedValue(
      readOk(
        listed({
          window: null,
          saving: null,
          spend: null,
          share: null,
          annualised: null,
          counts: { findings: 0, high: 0, medium: 0, operators: 0 },
          findings: [],
        }),
      ),
    );
    await renderSpend({ tab: "findings" });
    expect(
      screen.getByRole("heading", { name: "No finding is open" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("li[data-finding]")).toBeNull();
    expect(
      screen.getByText("Potential savings", { selector: "dt" }).closest("div"),
    ).toHaveTextContent("not recorded");
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("opens one finding's evidence: the arithmetic and the runs it cites, and no rollup read", async () => {
    const evidence: SpendFindingEvidence = {
      finding: found(),
      calls: 3106,
      coveredCalls: 2980,
      measuredTokens: 41200,
      counterfactualTokens: 1900,
      measured: { micros: "1030400000", currency: "USD" },
      counterfactual: { micros: "45800000", currency: "USD" },
      runs: [
        {
          runId: "arun_01k5rn8f3j",
          startedAt: "2026-09-11T06:00:00.000Z",
          calls: 36,
          measuredTokens: 41200,
          counterfactualTokens: 1900,
          measured: { micros: "24100000", currency: "USD" },
          counterfactual: { micros: "1120000", currency: "USD" },
        },
      ],
    };
    findingEvidence.mockResolvedValue(readOk(evidence));
    await renderSpend({ tab: "findings", finding: "fnd_01k5rtgh" });
    expect(
      screen.getByText("Potential savings", { selector: "dt" }).closest("div"),
    ).toHaveTextContent("Cost data: gateway observed");

    expect(findingEvidence).toHaveBeenCalledExactlyOnceWith(
      ctx,
      "fnd_01k5rtgh",
    );
    expect(byGroup).not.toHaveBeenCalled();
    expect(findings).not.toHaveBeenCalled();
    expect(
      screen.getByText("Calls the counterfactual prices").closest("div"),
    ).toHaveTextContent("2,980 of 3,106");
    expect(screen.getByText("Tokens").closest("div")).toHaveTextContent(
      "41,200 measured · 1,900 counterfactual",
    );
    expect(
      screen.getByText("What the cited calls cost").closest("div"),
    ).toHaveTextContent("$1,030.40");
    expect(
      screen.getByRole("link", { name: "arun_01k5rn8f3j" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_01k5rn8f3j");
    expect(
      screen.getByRole("link", { name: "Back to the findings" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend?tab=findings");
  });

  it("says the evidence lists no run where the finding cites none", async () => {
    findingEvidence.mockResolvedValue(
      readOk({
        finding: found(),
        calls: 3106,
        coveredCalls: 0,
        measuredTokens: 41200,
        counterfactualTokens: 1900,
        measured: { micros: "1030400000", currency: "USD" },
        counterfactual: { micros: "45800000", currency: "USD" },
        runs: [],
      }),
    );
    await renderSpend({ tab: "findings", finding: "fnd_01k5rtgh" });
    expect(
      screen.getByText("The evidence lists no run for this finding."),
    ).toBeInTheDocument();
  });

  it("replaces the body when the findings read or the evidence read is refused (negative)", async () => {
    byGroup.mockResolvedValue(report([]));
    findings.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
    await renderSpend({ tab: "findings" });
    expect(document.querySelector('[data-state="denied"]')).not.toBeNull();
    expect(document.querySelector("li[data-finding]")).toBeNull();
    cleanup();

    findingEvidence.mockResolvedValue(
      readError("rollup_rebuild_in_progress", 504),
    );
    await renderSpend({ tab: "findings", finding: "fnd_01k5rtgh" });
    expect(document.querySelector('[data-state="error"]')).not.toBeNull();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });
});
