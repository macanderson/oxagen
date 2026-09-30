// @vitest-environment jsdom
// The Spend page against the rev1 mockup's spec it was built from (mockups/
// pages/spend.md, not at ADR-226's pin) and the v3 Month tab ADR-226 adds, on a
// fake DataSource: the header with its one gold action, the Month tab on the
// bare path, the four summary tiles on every other tab, the tabs with their
// counts, every tab's panels and
// columns in the design's order, one key's drill, the evidence and stub
// dialogs, and each state (empty, loading, error, denied, waiting). Every
// money figure carries its basis or prints "not recorded"; a slice no store
// records says so and names its issue; axe checks the state each test ends in
// (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  SpendGroupKind,
  SpendReport,
  SpendWaste,
} from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import type { WsRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { pickOption } from "@/test/select";
import enMessages from "../../../messages/en.json";
import spendMessages from "../../../messages/spend.json";
import uiMessages from "../../../messages/ui.json";

const messages = { ...enMessages, ...spendMessages, ...uiMessages };

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
  setGatewayPolicyAction: vi.fn(),
}));
vi.mock("./operator-ranking-actions", () => ({
  setOperatorPseudonymsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Spend } = await import("./spend");
const { SpendLoading } = await import("./states");
const { parseSpendView } = await import("./view");

/** The viewer in the workspace, holding `wsRole` there. */
const ctxAs = (wsRole: WsRole) =>
  unsafeMint(WsCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: "member",
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole,
  });
const ctx = ctxAs("member");

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
  tokens: {
    input_uncached: 120,
    cache_read: 80,
    cache_write_5m: 10,
    cache_write_1h: 5,
    output: 40,
    reasoning: 20,
  },
  operator: null,
  ...over,
});

const byGroup = vi.fn<DataSource["spend"]["byGroup"]>();
const drill = vi.fn<DataSource["spend"]["drill"]>();
const waste = vi.fn<DataSource["spend"]["waste"]>();
const budgets = vi.fn<DataSource["spend"]["budgets"]>();
const gatewayPolicy = vi.fn<DataSource["spend"]["gatewayPolicy"]>();
const findings = vi.fn<DataSource["spend"]["findings"]>();
const findingEvidence = vi.fn<DataSource["spend"]["findingEvidence"]>();
const priceBook = vi.fn<DataSource["spend"]["priceBook"]>();
const unpricedModels = vi.fn<DataSource["spend"]["unpricedModels"]>();
const operatorRanking = vi.fn<DataSource["spend"]["operatorRanking"]>();
const source: DataSource = {
  runtimes: { list: vi.fn(), agents: vi.fn(), named: vi.fn() },
  conversations: { latest: vi.fn(), list: vi.fn(), byId: vi.fn() },
  pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
  shell: {
    context: vi.fn(),
    preferences: vi.fn(),
    counts: vi.fn(),
    notifications: vi.fn(),
    assistantEngine: vi.fn(),
  },
  billing: {
    plan: vi.fn(),
    usageCredits: vi.fn(),
    retention: vi.fn(),
    bucket: vi.fn(),
    contractRate: vi.fn(),
    invoices: vi.fn(),
  },
  runs: {
    list: vi.fn(),
    get: vi.fn(),
    frameBody: vi.fn(),
    cost: vi.fn(),
    turns: vi.fn(),
    transcript: vi.fn(),
    chain: vi.fn(),
    commands: vi.fn(),
    outputs: vi.fn(),
    work: vi.fn(),
    outcomesSettings: vi.fn(),
    issues: vi.fn(),
    context: vi.fn(),
    findings: vi.fn(),
  },
  approvals: { pending: vi.fn(), resolved: vi.fn(), resolvedSince: vi.fn() },
  interjections: { open: vi.fn(), forRun: vi.fn() },
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
    operatorRanking,
    budgets,
    gatewayPolicy,
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
    costCenters: vi.fn(),
    modelCredential: vi.fn(),
    dataPlane: vi.fn(),
    slackConnection: vi.fn(),
    workspaceFacts: vi.fn(),
    sso: vi.fn(),
  },
  mandates: { list: vi.fn(), get: vi.fn() },
  audit: {
    events: vi.fn(),
    exportEvents: vi.fn(),
    retention: vi.fn(),
    bundle: vi.fn(),
  },
  skills: { inventory: vi.fn(), configuration: vi.fn() },
  steering: {
    records: vi.fn(),
    record: vi.fn(),
    proposals: vi.fn(),
    contextPr: vi.fn(),
    freshness: vi.fn(),
    layout: vi.fn(),
    hub: vi.fn(),
    deliveries: vi.fn(),
    memories: vi.fn(),
    tree: vi.fn(),
  },
  steeringRepo: { get: vi.fn() },
  tools: {
    versions: vi.fn(),
    grants: vi.fn(),
    killSwitches: vi.fn(),
    approvalRules: vi.fn(),
    connections: vi.fn(),
    mcpServers: vi.fn(),
    toolbelts: vi.fn(),
    toolbelt: vi.fn(),
  },
};

/** The route's own parse, so a test names a path the way a person does. */
async function renderSpend(
  segments: readonly string[] = [],
  finding?: string,
  as: typeof ctx = ctx,
  by?: string,
) {
  const view = parseSpendView(segments, finding, by);
  if (view === null) throw new Error(`no view for ${segments.join("/")}`);
  const element = await Spend({ ctx: as, source, view, today: TODAY });
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {element}
    </NextIntlClientProvider>,
  );
}

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

const onAgent = found({
  id: "fnd_01k5rteg",
  kind: "repeated_shell_commands",
  level: "agent",
  subject: "a-intel.core.stella-ci",
  saving: cost("486200000"),
  confidence: "medium",
  runs: 1912,
  calls: 8841,
});

const onOperator = found({
  id: "fnd_01k5rtop",
  kind: "duplicate_tool_calls",
  level: "operator",
  subject: "prn_marcusbell",
  saving: cost("200000000"),
  confidence: "high",
  runs: 40,
  calls: 400,
});

function listing(over: Partial<SpendFindings> = {}): SpendFindings {
  return {
    window: span,
    saving: cost("1670800000"),
    spend: cost("18402660000", "mixed"),
    share: 0.64,
    annualised: cost("17649600000"),
    counts: { findings: 3, high: 2, medium: 1, operators: 3 },
    findings: [found(), onAgent, onOperator],
    ...over,
  };
}

const MARCUS = {
  id: "prn_marcusbell",
  name: "Marcus Bell",
  email: "marcus@acme.test",
  avatarUrl: null,
  role: "workspace.owner",
};

/** The month by model: two models, 1,000 tokens between them, 350 read from cache. */
function monthByModel(): Read<SpendReport> {
  return report(
    [
      row("claude-opus-5", {
        provider: "anthropic",
        cost: cost("9000000", "mixed"),
        tokens: {
          input_uncached: 100,
          cache_read: 300,
          cache_write_5m: 50,
          cache_write_1h: 0,
          output: 100,
          reasoning: 50,
        },
      }),
      row("claude-haiku-4-5", {
        provider: "anthropic",
        cost: cost("3345678", "client_attested"),
        tokens: {
          input_uncached: 250,
          cache_read: 50,
          cache_write_5m: 0,
          cache_write_1h: 0,
          output: 100,
          reasoning: 0,
        },
      }),
    ],
    figure({ cost: cost("12345678", "mixed") }),
  );
}

const wasteRead: SpendWaste = {
  wasted: cost("2469135", "client_attested"),
  share: 0.2,
  runsWithWaste: 2,
  largestCause: "cache_write_never_read",
  causes: [
    {
      cause: "cache_write_never_read",
      wasted: cost("2469135", "client_attested"),
      runs: 2,
      provingRuns: [
        { runId: "arun_01k5rn8f3j", name: "Repair the login redirect" },
        { runId: "tse_01k5rn9aaa", name: null },
      ],
    },
  ],
};

const budgetRows: SpendBudgets = [
  {
    scope: "workspace",
    enabled: true,
    period: "monthly",
    windowDays: null,
    limit: { micros: "18000000000", currency: "USD" },
    spent: { micros: "14213780000", currency: "USD" },
    ratio: 0.79,
    state: "threshold_50",
  },
  {
    scope: "org",
    enabled: false,
    period: "rolling",
    windowDays: 30,
    limit: { micros: "25000000000", currency: "USD" },
    spent: { micros: "18402660000", currency: "USD" },
    ratio: 0.74,
    state: "threshold_50",
  },
];

/** Every read answers: the month by model, and the level each tab asks for. */
function loaded(
  levels: Partial<Record<SpendGroupKind, Read<SpendReport>>> = {},
) {
  byGroup.mockImplementation((_ctx, groupBy) =>
    Promise.resolve(
      groupBy === "model" ? monthByModel() : (levels[groupBy] ?? report([])),
    ),
  );
  findings.mockResolvedValue(readOk(listing()));
  waste.mockResolvedValue(readOk(wasteRead));
  budgets.mockResolvedValue(readOk(budgetRows));
  gatewayPolicy.mockResolvedValue(readError("gateway_down", 503));
}

beforeEach(() => {
  byGroup.mockReset();
  drill.mockReset();
  waste.mockReset();
  budgets.mockReset();
  gatewayPolicy.mockReset();
  findings.mockReset();
  findingEvidence.mockReset();
  priceBook.mockReset();
  unpricedModels.mockReset();
  operatorRanking.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function rowOf(key: string): HTMLElement {
  const hit = document.querySelector<HTMLElement>(`tr[data-key="${key}"]`);
  if (hit === null) throw new Error(`no row ${key}`);
  return hit;
}

function tile(term: string): HTMLElement {
  const dt = screen.getByText(term, { selector: "dt" });
  const box = dt.closest("div");
  if (box === null) throw new Error(`no tile ${term}`);
  return box;
}

function headers(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
}

/** The month by model, with `estimatedRuns` runs still open. */
function openRuns(estimatedRuns: number) {
  const month = monthByModel();
  if (!month.ok) throw new Error("monthByModel must answer");
  byGroup.mockImplementation((_ctx, groupBy) =>
    Promise.resolve(
      groupBy === "model"
        ? readOk({ ...month.value, estimatedRuns })
        : report([]),
    ),
  );
}

describe("Spend › open runs (#3980)", () => {
  it("says the Spend tile includes estimates while runs in the month are still open", async () => {
    loaded();
    openRuns(2);
    await renderSpend(["findings"]);
    expect(tile("Spend")).toHaveTextContent(
      "includes estimates for 2 open runs",
    );
  });

  it("says nothing of estimates once every run in the month has sealed (negative)", async () => {
    loaded();
    openRuns(0);
    await renderSpend(["findings"]);
    expect(tile("Spend")).not.toHaveTextContent("estimate");
    expect(screen.queryByTestId("spend-estimate")).toBeNull();
  });
});

describe("Spend › runs with no usage (#3304)", () => {
  /** The month by model, with runs the total counts and cannot price. */
  function unmetered(unmeteredRuns: SpendReport["unmeteredRuns"]) {
    const month = monthByModel();
    if (!month.ok) throw new Error("monthByModel must answer");
    byGroup.mockImplementation((_ctx, groupBy) =>
      Promise.resolve(
        groupBy === "model"
          ? readOk({ ...month.value, unmeteredRuns })
          : report([]),
      ),
    );
  }

  it("says how many runs reported no usage, and on which harness, beside the total that leaves them out", async () => {
    loaded();
    unmetered({
      total: 3,
      byHarness: [
        { harness: "codex", runs: 2 },
        { harness: "cursor", runs: 1 },
      ],
    });
    await renderSpend(["findings"]);
    expect(screen.getByTestId("spend-unmetered")).toHaveTextContent(
      "3 runs reported no usage and are not in this total: codex 2, cursor 1",
    );
    expect(tile("Spend")).toContainElement(
      screen.getByTestId("spend-unmetered"),
    );
  });

  it("says nothing when every run in the month reported usage (negative)", async () => {
    loaded();
    unmetered({ total: 0, byHarness: [] });
    await renderSpend(["findings"]);
    expect(screen.queryByTestId("spend-unmetered")).toBeNull();
  });
});

describe("Spend › header, tiles and tabs", () => {
  it("names the workspace, says what the page is for, and offers Export report and Set a budget with one gold action", async () => {
    loaded();
    await renderSpend(["findings"]);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Spend",
    );
    expect(screen.getByText("Core platform")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Spend and tokens for this workspace with the basis of every figure.",
      ),
    ).toBeInTheDocument();
    const header = screen.getByRole("banner");
    const actions = within(header).getAllByRole("button");
    expect(actions.map((b) => b.textContent)).toEqual([
      "Export report",
      "Set a budget",
    ]);
    expect(document.querySelectorAll('[data-placement="header"]')).toHaveLength(
      1,
    );
  });

  it("prints the four tiles as rollups of the month's rows, each with its basis, and never a zero it was not given", async () => {
    loaded();
    await renderSpend(["findings"]);
    const spend = tile("Spend");
    expect(spend).toHaveTextContent("$12.35");
    expect(spend).toHaveTextContent("gateway_observed + client_attested");
    expect(spend).toHaveTextContent("USD");
    // 100 + 300 + 50 + 100 + 50 + 250 + 50 + 100 = 1,000; 350 of 700 input read from cache.
    const tokens = tile("Tokens");
    expect(tokens).toHaveTextContent("1,000");
    expect(tokens).toHaveTextContent("50% served from cache");
    const observed = tile("Observed by the gateway");
    expect(observed).toHaveTextContent("not recorded");
    expect(observed).toHaveTextContent("of tokens counted by the proxy");
    const wasted = tile("Wasted");
    expect(wasted).toHaveTextContent("$2.47");
    expect(wasted).toHaveTextContent("20% of spend");
    expect(wasted.querySelector('[data-tone="critical"]')).not.toBeNull();
  });

  it("lists Month, then the earlier design's five tabs it keeps, in order, with live counts, as path links", async () => {
    loaded();
    await renderSpend(["waste"]);
    const nav = screen.getByRole("navigation", { name: "Spend views" });
    const links = within(nav).getAllByRole("link");
    expect(links.slice(0, 6).map((a) => a.textContent)).toEqual([
      "Month",
      "Findings3",
      "Tokens",
      "By tool",
      "Wasted spend2",
      "Budgets2",
    ]);
    // Month groups by operator, agent, and model, so those tabs and Coaching are gone.
    for (const gone of ["Coaching", "By operator", "By agent", "By model"]) {
      expect(within(nav).queryByRole("link", { name: gone })).toBeNull();
    }
    expect(links[0]).toHaveAttribute("href", "/acme/core-platform/spend");
    expect(links[1]).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/findings",
    );
    expect(links[4]).toHaveAttribute("href", "/acme/core-platform/spend/waste");
    expect(links[4]).toHaveAttribute("aria-current", "page");
  });

  it("leaves a count off when its read did not answer, rather than printing a zero", async () => {
    loaded();
    findings.mockResolvedValue(readError("findings_down", 503));
    waste.mockResolvedValue(readError("waste_down", 503));
    await renderSpend(["tokens"]);
    const nav = screen.getByRole("navigation", { name: "Spend views" });
    expect(
      within(nav).getByRole("link", { name: "Findings" }),
    ).toBeInTheDocument();
    expect(tile("Wasted")).toHaveTextContent("not recorded");
  });
});

describe("Spend › Month", () => {
  const triage = {
    runId: "arun_01k5rn8f3j",
    name: "Repair the login redirect",
    startedAt: "2026-09-11T06:00:00.000Z",
    agentKey: "acme.core.triage",
    harness: "codex",
    operatorKey: "prn_marcusbell",
    cost: cost("4000000"),
    calls: 12,
  };

  /** The month grouped one way: the two rows `rows` names, and three days. */
  function month(
    rows: SpendReport["rows"],
    over: Partial<SpendReport> = {},
  ): Read<SpendReport> {
    return readOk({
      period: PERIOD,
      total: figure({ cost: cost("12345678", "mixed") }),
      days: [
        { day: "2026-09-13", cost: cost("2345678"), calls: 40, runs: 2 },
        { day: "2026-09-14", cost: null, calls: 0, runs: 0 },
        { day: "2026-09-15", cost: cost("10000000"), calls: 90, runs: 10 },
      ],
      reported: null,
      rows,
      ...over,
    });
  }

  const byAgentRows = () => [
    row("acme.core.triage", {
      cost: cost("9000000"),
      runs: 8,
      topRuns: [triage],
    }),
    row("acme.core.review", {
      cost: cost("3345678"),
      runs: 4,
      topRuns: [],
    }),
  ];

  const byAgent = () => month(byAgentRows());

  /** Every read answers, with the month grouped as `read` says. */
  function loadedMonth(read: () => Read<SpendReport> = byAgent) {
    loaded();
    byGroup.mockImplementation(() => Promise.resolve(read()));
  }

  it("opens on the bare path with one read of the month by agent, the total, the days, and no summary tiles", async () => {
    loadedMonth();
    await renderSpend();
    expect(byGroup).toHaveBeenCalledExactlyOnceWith(ctx, "agent", PERIOD);
    expect(screen.queryByTestId("spend-summary")).toBeNull();
    expect(
      screen.getByText("What every run cost, from its own model requests."),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Spend views" });
    expect(within(nav).getByRole("link", { name: "Month" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const total = screen
      .getByRole("heading", { name: "September 2026" })
      .closest("section");
    if (total === null) throw new Error("no total");
    expect(total).toHaveTextContent("$12.35");
    expect(total).toHaveTextContent("September 1 to September 15, 12 runs");
    expect(
      within(total).getByRole("img", { name: "Spend by day" }),
    ).toBeInTheDocument();
  });

  it("lists the groups with runs, share, and cost over a Total row, and opens a group to its costliest runs", async () => {
    loadedMonth();
    await renderSpend();
    const table = screen.getByRole("table", { name: "By agent" });
    expect(headers(table)).toEqual(["Agent", "Runs", "Share", "Cost"]);
    const triageRow = rowOf("acme.core.triage");
    expect(triageRow).toHaveTextContent("8");
    expect(triageRow).toHaveTextContent("72.9%");
    expect(triageRow).toHaveTextContent("$9.00");
    expect(within(table).getByRole("rowheader", { name: "Total" })).toBeInTheDocument();
    // A group with no runs listed has nothing to open, and still links its drill.
    expect(
      within(rowOf("acme.core.review")).queryByRole("button"),
    ).toBeNull();
    expect(
      within(rowOf("acme.core.review")).getByRole("link", {
        name: "acme.core.review",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/spend/agent/acme.core.review");
    expect(
      within(triageRow).getByRole("link", { name: "acme.core.triage" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend/agent/acme.core.triage");
    const toggle = within(triageRow).getByRole("button", {
      name: "Costliest runs of acme.core.triage",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("link", { name: /Repair the login redirect/ }),
    ).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const run = screen.getByRole("link", { name: /Repair the login redirect/ });
    expect(run).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/arun_01k5rn8f3j",
    );
    expect(run).toHaveTextContent("$4.00");
    expect(run.querySelector('[data-harness-badge="codex"]')).not.toBeNull();
    expect(screen.getByText("7 more runs")).toBeInTheDocument();
  });

  it("groups by the query's choice, with the chip in force pressed and Agent on the bare path", async () => {
    loadedMonth(() =>
      month([
        row("prn_marcusbell", {
          cost: cost("12345678"),
          operator: MARCUS,
          topRuns: [triage],
        }),
      ]),
    );
    await renderSpend([], undefined, ctx, "operator");
    expect(byGroup).toHaveBeenCalledExactlyOnceWith(ctx, "operator", PERIOD);
    const group = screen.getByRole("group", { name: "Group by" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Agent",
      "Operator",
      "Model",
      "MCP server",
    ]);
    expect(chips[0]).toHaveAttribute("href", "/acme/core-platform/spend");
    expect(chips[0]).toHaveAttribute("aria-pressed", "false");
    expect(chips[1]).toHaveAttribute("aria-pressed", "true");
    expect(chips[3]).toHaveAttribute(
      "href",
      "/acme/core-platform/spend?by=mcp_server",
    );
    const table = screen.getByRole("table", { name: "By operator" });
    expect(headers(table)[0]).toBe("Operator");
    expect(rowOf("prn_marcusbell")).toHaveTextContent("Marcus Bell");
    expect(rowOf("prn_marcusbell")).not.toHaveTextContent("prn_marcusbell");
    expect(
      within(rowOf("prn_marcusbell")).getByRole("link", { name: "Marcus Bell" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/operator/prn_marcusbell",
    );
    expect(
      within(rowOf("prn_marcusbell")).getByRole("button", {
        name: "Costliest runs of Marcus Bell",
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("links no model row, since no drill takes a model (negative)", async () => {
    loadedMonth(() =>
      month([
        row("claude-opus-5-5", {
          cost: cost("12345678"),
          provider: "anthropic",
          topRuns: [triage],
        }),
      ]),
    );
    await renderSpend([], undefined, ctx, "model");
    const model = rowOf("claude-opus-5-5");
    expect(model).toHaveTextContent("anthropic");
    expect(within(model).queryByRole("link")).toBeNull();
    expect(
      within(model).getByRole("button", {
        name: "Costliest runs of claude-opus-5-5",
      }),
    ).toBeInTheDocument();
  });

  it("prints the rest of the spend on the MCP server grouping as Other spend, with no runs and nothing to open", async () => {
    loadedMonth(() =>
      month(
        [
          row("github", { cost: cost("2000000"), runs: 3, topRuns: [triage] }),
          row("~other", { cost: cost("10345678"), runs: 12, topRuns: [] }),
        ],
        { reported: { micros: "3345678", currency: "USD" } },
      ),
    );
    await renderSpend([], undefined, ctx, "mcp_server");
    expect(byGroup).toHaveBeenCalledExactlyOnceWith(
      ctx,
      "mcp_server",
      PERIOD,
    );
    const rest = rowOf("~other");
    expect(rest).toHaveTextContent("Other spend");
    expect(rest).toHaveTextContent(
      "Spend outside MCP server calls",
    );
    expect(within(rest).queryByRole("button")).toBeNull();
    expect(within(rest).queryByRole("link")).toBeNull();
    // No drill takes an MCP server.
    expect(within(rowOf("github")).queryByRole("link")).toBeNull();
    expect(rest).toHaveTextContent("83.8%");
    expect(
      screen.getByText(
        "The harness reported $3.35 of this total. The gateway metered or estimated the rest.",
      ),
    ).toBeInTheDocument();
    // Other spend already holds the rest, so nothing is left ungrouped.
    expect(screen.queryByText("Not grouped")).toBeNull();
  });

  it("adds a Not grouped row for the spend no group carries, so the rows sum to the total", async () => {
    loadedMonth(() =>
      month([
        row("acme.core.triage", {
          cost: cost("9000000"),
          runs: 8,
          topRuns: [triage],
        }),
      ]),
    );
    await renderSpend();
    const rest = rowOf("~ungrouped");
    expect(rest).toHaveTextContent("Not grouped");
    expect(rest).toHaveTextContent(
      "Runs the rollup cannot group by agent",
    );
    expect(rest).toHaveTextContent("$3.35");
    expect(rest).toHaveTextContent("27.1%");
    expect(within(rest).queryByRole("button")).toBeNull();
    expect(within(rest).queryByRole("link")).toBeNull();
  });

  it("adds no Not grouped row when the groups carry the whole total (negative)", async () => {
    loadedMonth();
    await renderSpend();
    expect(screen.queryByText("Not grouped")).toBeNull();
  });

  it("says how many open runs the total estimates", async () => {
    loadedMonth(() => month(byAgentRows(), { estimatedRuns: 2 }));
    await renderSpend();
    expect(screen.getByTestId("spend-month-estimate")).toHaveTextContent(
      "includes estimates for 2 open runs",
    );
  });

  it("meters the workspace's monthly budget beside the total", async () => {
    loadedMonth();
    await renderSpend();
    expect(screen.getByText("Monthly budget")).toBeInTheDocument();
    expect(screen.getByText("79% of $18,000.00")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "79% of the monthly budget used" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Reached")).toBeNull();
  });

  it("marks a budget the month has reached", async () => {
    loadedMonth();
    const [first, ...rest] = budgetRows;
    if (first === undefined) throw new Error("no budget");
    budgets.mockResolvedValue(
      readOk([{ ...first, ratio: 1.02, state: "exceeded" }, ...rest]),
    );
    await renderSpend();
    expect(screen.getByText("102% of $18,000.00")).toBeInTheDocument();
    expect(screen.getByText("Reached")).toBeInTheDocument();
    expect(screen.queryByText("Not enforced")).toBeNull();
  });

  it("marks a budget that is not enforced, and draws its reach as no alarm", async () => {
    loadedMonth();
    const [first, ...rest] = budgetRows;
    if (first === undefined) throw new Error("no budget");
    budgets.mockResolvedValue(
      readOk([
        { ...first, enabled: false, ratio: 1.02, state: "exceeded" },
        ...rest,
      ]),
    );
    await renderSpend();
    expect(screen.getByText("Reached")).toBeInTheDocument();
    expect(screen.getByText("Not enforced")).toBeInTheDocument();
    const bar = screen.getByRole("img", {
      name: "102% of the monthly budget used",
    }).firstElementChild;
    expect(bar).toHaveClass("bg-link");
    expect(bar).not.toHaveClass("bg-destructive");
  });

  it("links to Budgets when the workspace sets no monthly budget", async () => {
    loadedMonth();
    budgets.mockResolvedValue(readOk([]));
    await renderSpend();
    expect(
      screen.getByRole("link", { name: "No budget set" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend/budgets");
  });

  it("says nothing of a budget when the budgets read did not answer (negative)", async () => {
    loadedMonth();
    budgets.mockResolvedValue(readError("budgets_down", 503));
    await renderSpend();
    expect(screen.queryByText("Monthly budget")).toBeNull();
    expect(screen.queryByText("No budget set")).toBeNull();
  });

  it("says no day carried a price rather than drawing an empty chart (negative)", async () => {
    loadedMonth(() =>
      month([row("acme.core.triage", { cost: null, topRuns: [] })], {
        total: figure({ cost: null }),
        days: [{ day: "2026-09-15", cost: null, calls: 3, runs: 1 }],
      }),
    );
    await renderSpend();
    expect(
      screen.getByText("No run this month carried a price."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Spend by day" })).toBeNull();
  });

  it("says how many runs reported no usage under the total", async () => {
    loadedMonth(() =>
      month([], {
        unmeteredRuns: { total: 2, byHarness: [{ harness: "codex", runs: 2 }] },
      }),
    );
    await renderSpend();
    expect(screen.getByTestId("spend-month-unmetered")).toHaveTextContent(
      "2 runs reported no usage and are not in this total: codex 2",
    );
    expect(
      screen.getByText("No run this month falls in a group here."),
    ).toBeInTheDocument();
  });

  it("shows the empty state when the month has no run (negative)", async () => {
    loadedMonth(() =>
      month([], { total: figure({ cost: null, calls: 0, runs: 0 }) }),
    );
    await renderSpend();
    expect(screen.getByTestId("spend-empty")).toBeInTheDocument();
  });

  it("keeps the grouping on the retry link when the month read fails (negative)", async () => {
    loaded();
    byGroup.mockResolvedValue(readError("rollup_down", 503));
    await renderSpend([], undefined, ctx, "model");
    expect(
      within(screen.getByTestId("spend-error")).getByRole("link", {
        name: "Try again",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/spend?by=model");
  });
});

describe("Spend › Findings", () => {
  it("leads with the savings identified, the share strip, the legend and the four facts", async () => {
    loaded({ operator: report([row("prn_marcusbell", { operator: MARCUS })]) });
    await renderSpend(["findings"]);
    const hero = screen.getByTestId("spend-findings-hero");
    expect(within(hero).getByRole("heading")).toHaveTextContent(
      "Savings identified",
    );
    expect(hero).toHaveTextContent("$1,670.80");
    expect(hero).toHaveTextContent("64% of");
    expect(hero).toHaveTextContent("About $17,649.60 a year at this run rate.");
    expect(
      within(hero).getByRole("img", {
        name: "Share of the identified savings by finding",
      }),
    ).toBeInTheDocument();
    expect(hero).toHaveTextContent("3 findings");
    expect(hero).toHaveTextContent("3 operators involved");
    expect(hero).toHaveTextContent("2 high confidence 1 medium");
    expect(hero).toHaveTextContent("every one opens to its evidence");
  });

  it("ranks each card with its kind, level, confidence, who it is about, the evidence line, the amount at stake and its share, Evidence and Fix", async () => {
    loaded({ operator: report([row("prn_marcusbell", { operator: MARCUS })]) });
    await renderSpend(["findings"]);
    const list = screen.getByRole("list", {
      name: "Findings ranked by savings",
    });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(3);
    const first = cards[0];
    if (first === undefined) throw new Error("no card");
    expect(first).toHaveTextContent("1");
    expect(first).toHaveTextContent("Unpaged results");
    expect(first).toHaveTextContent("tool");
    expect(first).toHaveTextContent("high confidence");
    expect(first).toHaveTextContent("aws_billing__get_cost_and_usage");
    expect(first).toHaveTextContent("evidence 88 runs · 3,106 calls");
    expect(first).toHaveTextContent("$984.60");
    expect(first).toHaveTextContent("at stake (58.9% of identified)");
    expect(
      within(first).getByRole("link", { name: "Evidence" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/findings?finding=fnd_01k5rtgh",
    );
    expect(
      within(first).getByRole("button", { name: "Fix" }),
    ).toBeInTheDocument();
    // An operator finding names the person, not the principal id.
    expect(cards[2]).toHaveTextContent("Marcus Bell");
    expect(cards[2]).not.toHaveTextContent("prn_marcusbell");
  });

  it("filters by level and confidence, sorts, and pages the cards", async () => {
    loaded();
    await renderSpend(["findings"]);
    const user = userEvent.setup();
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Level" }),
      "agent",
    );
    let cards = screen
      .getAllByRole("listitem")
      .filter((li) => li.dataset.finding);
    expect(cards.map((c) => c.dataset.finding)).toEqual(["fnd_01k5rteg"]);
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Level" }),
      "All",
    );
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Confidence" }),
      "high confidence",
    );
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Sort" }),
      "Savings low first",
    );
    cards = screen.getAllByRole("listitem").filter((li) => li.dataset.finding);
    expect(cards.map((c) => c.dataset.finding)).toEqual([
      "fnd_01k5rtop",
      "fnd_01k5rtgh",
    ]);
    // The range sits in the pager beside Rows, outside the Previous and Next
    // landmark.
    const pager = screen
      .getByRole("navigation", { name: "Pages" })
      .closest("[data-rows-pager]");
    expect(pager).toHaveTextContent("1 to 2 of 2");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("says no finding is open, printing no total it was not given", async () => {
    loaded();
    findings.mockResolvedValue(
      readOk(
        listing({
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
    await renderSpend(["findings"]);
    expect(screen.getByText("No finding is open")).toBeInTheDocument();
    expect(screen.getByTestId("spend-findings-hero")).toHaveTextContent(
      "not recorded",
    );
  });

  it("opens one finding's evidence as a dialog over the list, with the arithmetic and the runs it cites", async () => {
    loaded();
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
          name: "Repair the login redirect",
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
    await renderSpend(["findings"], "fnd_01k5rtgh");
    expect(findingEvidence).toHaveBeenCalledExactlyOnceWith(
      ctx,
      "fnd_01k5rtgh",
    );
    const dialog = await screen.findByTestId("spend-evidence-dialog");
    expect(within(dialog).getByText("Evidence")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("2,980 of 3,106");
    expect(dialog).toHaveTextContent("$1,030.40");
    expect(
      within(dialog).getByRole("columnheader", { name: "Session name" }),
    ).toBeInTheDocument();
    const row = within(dialog)
      .getByRole("link", { name: "Repair the login redirect" })
      .closest("tr");
    if (!(row instanceof HTMLElement)) throw new Error("no evidence row");
    expect(
      within(row).getByRole("link", { name: "Repair the login redirect" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_01k5rn8f3j");
    expect(within(row).getByTestId("run-id")).toHaveTextContent(
      /^arun_01k5rn8f3j$/,
    );
  });

  it("says inside the dialog when the evidence read is refused (negative)", async () => {
    loaded();
    findingEvidence.mockResolvedValue(readError("finding_missing", 404));
    await renderSpend(["findings"], "fnd_01k5rtgh");
    const dialog = await screen.findByTestId("spend-evidence-dialog");
    expect(dialog.querySelector('[data-reason="error"]')).not.toBeNull();
  });
});

describe("Spend › Tokens", () => {
  function classRow(name: string): HTMLElement {
    const hit = document.querySelector<HTMLElement>(
      `tr[data-token-class="${name}"]`,
    );
    if (hit === null) throw new Error(`no class ${name}`);
    return hit;
  }

  it("sums the month's classes once, prints no cost per class it was not given, and names what the rollup does not record", async () => {
    loaded({ agent: report([]) });
    await renderSpend(["tokens"]);
    const classes = screen.getByRole("table", { name: "By token class" });
    expect(headers(classes)).toEqual(["Class", "Tokens", "Share", "Cost"]);
    expect(classRow("input_uncached")).toHaveTextContent("350");
    expect(classRow("cache_read")).toHaveTextContent("350");
    expect(classRow("cache_write")).toHaveTextContent("50");
    expect(classRow("output")).toHaveTextContent("200");
    expect(classRow("reasoning")).toHaveTextContent("50");
    expect(classRow("output")).toHaveTextContent("20%");
    expect(classRow("output")).toHaveTextContent("not recorded");
    expect(screen.getByText(/1,000 tokens/)).toBeInTheDocument();
    expect(
      screen.getByText("Cache hit rate").nextElementSibling,
    ).toHaveTextContent("50%");
    // 50 of 750 input tokens were written to the cache (A-08).
    expect(
      screen.getByText("Written to cache").nextElementSibling,
    ).toHaveTextContent("6.7%");
    for (const heading of ["Prompt composition", "By harness"]) {
      const panel = screen
        .getByRole("heading", { name: heading })
        .closest("section");
      if (panel === null) throw new Error(`no panel ${heading}`);
      expect(within(panel).getByTestId("spend-not-backed")).toHaveAttribute(
        "data-issue",
        "2962",
      );
    }
    expect(
      screen
        .getByRole("heading", { name: "Prompt composition" })
        .closest("section"),
    ).toHaveTextContent("Tool definitions");
  });

  it("lists the twelve agents with the most tokens, with the design's columns, each opening its agent page", async () => {
    const agents = Array.from({ length: 13 }, (_, index) =>
      row(`a-intel.core.agent-${String(index)}`, {
        runs: 2,
        tokens: {
          input_uncached: 10 * (index + 1),
          cache_read: 10 * (index + 1),
          cache_write_5m: 0,
          cache_write_1h: 0,
          output: 0,
          reasoning: 0,
        },
      }),
    );
    loaded({ agent: report(agents) });
    await renderSpend(["tokens"]);
    const table = screen.getByRole("table", { name: "By agent" });
    expect(headers(table)).toEqual([
      "Agent",
      "Runs",
      "Tokens",
      "Per run",
      "Cache hit",
      "Tool defs",
      "Context",
      "Tool results",
      "Reasoning",
      "Basis",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toHaveTextContent("a-intel.core.agent-12");
    expect(rows[0]).toHaveTextContent("260");
    expect(rows[0]).toHaveTextContent("130");
    const [first] = rows;
    if (first === undefined) throw new Error("Expected a first agent row");
    expect(
      within(first).getByRole("link", {
        name: "a-intel.core.agent-12",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/agents/agent-12");
    expect(
      document.querySelector('tr[data-key="a-intel.core.agent-0"]'),
    ).toBeNull();
  });
});

describe("Spend › Findings › Operator ranking", () => {
  const owner = unsafeMint(WsCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: "owner",
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole: "member",
  });

  it("reads the ranking for an org Owner and prints it under the findings", async () => {
    loaded({
      operator: report([row("prn_marcusbell", { operator: MARCUS })]),
    });
    operatorRanking.mockResolvedValue(
      readOk({
        period: PERIOD,
        pseudonyms: false,
        unproductive: { micros: "5000000", currency: "USD" },
        unattributed: {
          unproductive: { micros: "0", currency: "USD" },
          runs: 0,
        },
        operators: [
          {
            rank: 1,
            operator: {
              kind: "named",
              key: "prn_marcusbell",
              facts: MARCUS,
            },
            unproductive: { micros: "5000000", currency: "USD" },
            shareOfTotal: 1,
            unproductiveShare: 0.4,
            runs: 1,
            topRuns: [
              {
                runId: "arun_01",
                unproductive: { micros: "5000000", currency: "USD" },
              },
            ],
          },
        ],
      }),
    );
    await renderSpend(["findings"], undefined, owner);
    expect(operatorRanking).toHaveBeenCalledWith(owner, PERIOD);
    const ranking = screen.getByRole("table", { name: "Operator ranking" });
    const list = screen.getByRole("list", {
      name: "Findings ranked by savings",
    });
    expect(
      list.compareDocumentPosition(ranking) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(ranking).toHaveTextContent("$5.00");
    expect(ranking).toHaveTextContent("Marcus Bell");
    expect(
      screen.getByRole("button", { name: "Turn on pseudonyms" }),
    ).toBeInTheDocument();
  });

  it("reads the ranking for the workspace Owner and hides the pseudonym switch an org role sets", async () => {
    const wsOwner = ctxAs("owner");
    loaded({
      operator: report([row("prn_marcusbell", { operator: MARCUS })]),
    });
    operatorRanking.mockResolvedValue(
      readOk({
        period: PERIOD,
        pseudonyms: false,
        unproductive: { micros: "0", currency: "USD" },
        unattributed: {
          unproductive: { micros: "0", currency: "USD" },
          runs: 0,
        },
        operators: [],
      }),
    );
    await renderSpend(["findings"], undefined, wsOwner);
    expect(operatorRanking).toHaveBeenCalledWith(wsOwner, PERIOD);
    expect(
      screen.getByText("No run has unproductive spend in this period."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pseudonyms/ })).toBeNull();
  });

  it("asks no ranking for a member and says who can read it (negative)", async () => {
    loaded({
      operator: report([row("prn_marcusbell", { operator: MARCUS })]),
    });
    await renderSpend(["findings"]);
    expect(operatorRanking).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("table", { name: "Operator ranking" }),
    ).toBeNull();
    expect(
      screen.getByText(/or the workspace Owner, can read the operator ranking/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Findings ranked by savings" }),
    ).toBeVisible();
  });

  it("asks no ranking on the Month tab grouped by operator, which holds the table alone (negative)", async () => {
    loaded({
      operator: report([row("prn_marcusbell", { operator: MARCUS })]),
    });
    await renderSpend([], undefined, owner, "operator");
    expect(operatorRanking).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("table", { name: "Operator ranking" }),
    ).toBeNull();
    expect(screen.getByRole("table", { name: "By operator" })).toBeVisible();
  });
});

describe("Spend › By tool", () => {
  it("prints the design's columns with share and averages from the row, and switches the chart between its three metrics", async () => {
    loaded({
      tool: report(
        [
          row("github__get_issue", {
            cost: cost("6000000"),
            calls: 4,
            runs: 3,
          }),
          row("jira__get_project", { cost: null, calls: 2, runs: 1 }),
        ],
        figure({ cost: cost("12000000") }),
      ),
    });
    await renderSpend(["tool"]);
    const table = screen.getByRole("table", { name: "By tool" });
    expect(headers(table)).toEqual([
      "Tool",
      "Server",
      "Calls",
      "Runs",
      "Cumulative",
      "Share",
      "Avg per call",
      "Avg per run",
      "Potential savings",
      "Frame summary",
    ]);
    const github = rowOf("github__get_issue");
    expect(github).toHaveTextContent("50%");
    expect(github).toHaveTextContent("$1.50");
    expect(github).toHaveTextContent("$2.00");
    expect(within(github).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/tool/github__get_issue",
    );
    const chart = screen.getByTestId("spend-tool-chart");
    expect(within(chart).getByRole("heading")).toHaveTextContent(
      "Cumulative spend",
    );
    const buttons = within(chart).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Cumulative spend",
      "Avg per run",
      "Avg per call",
    ]);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    const perCall = buttons[2];
    if (perCall === undefined)
      throw new Error("Expected the Avg per call button");
    await userEvent.click(perCall);
    expect(within(chart).getByRole("heading")).toHaveTextContent(
      "Avg per call",
    );
    expect(chart).toHaveTextContent(
      "The leading 1 of 2. The table holds every tool.",
    );
  });
});

describe("Spend › Wasted spend", () => {
  it("prints the four tiles, the recorded cause, the six design causes as not recorded, and a card per run with its two links", async () => {
    loaded();
    await renderSpend(["waste"]);
    const wasted = screen.getAllByText("Wasted", { selector: "dt" });
    expect(wasted).toHaveLength(2);
    expect(tile("Share of spend")).toHaveTextContent("20%");
    expect(tile("Runs with waste")).toHaveTextContent("of 12 runs this month");
    expect(tile("Largest cause")).toHaveTextContent(
      "cache written and never read",
    );
    const causes = screen
      .getByRole("heading", { name: "By cause" })
      .closest("section");
    if (causes === null) throw new Error("no causes");
    for (const cause of [
      "cache misses",
      "corrective prompts",
      "retry loops",
      "context bloat",
      "idle while parked",
      "halted early",
    ]) {
      expect(causes).toHaveTextContent(cause);
    }
    expect(causes.querySelectorAll('li[data-recorded="false"]')).toHaveLength(
      6,
    );
    const named = document.querySelector('[data-run="arun_01k5rn8f3j"]');
    if (!(named instanceof HTMLElement)) throw new Error("no named run card");
    expect(named).toHaveTextContent("Repair the login redirect");
    expect(within(named).getByTestId("run-id")).toHaveTextContent(
      /^arun_01k5rn8f3j$/,
    );
    const run = document.querySelector('[data-run="tse_01k5rn9aaa"]');
    if (!(run instanceof HTMLElement)) throw new Error("no run card");
    expect(run).toHaveTextContent("Untitled session");
    expect(within(run).getByTestId("run-id")).toHaveTextContent(
      /^tse_01k5rn9aaa$/,
    );
    expect(
      within(run).getByRole("link", { name: "Open the run" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/tse_01k5rn9aaa");
    expect(
      within(run).getByRole("link", { name: "Show the frames" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_01k5rn9aaa?tab=frames",
    );
  });
});

describe("Spend › Budgets", () => {
  it("prints Scope, Period, Limit, Used, Mode and Position, and a plain Set a budget beside the header's gold one", async () => {
    loaded();
    await renderSpend(["budgets"]);
    const table = screen.getByRole("table", { name: "Budgets" });
    expect(headers(table)).toEqual([
      "Scope",
      "Period",
      "Limit",
      "Used",
      "Mode",
      "Position",
    ]);
    const ws = document.querySelector('tr[data-scope="workspace"]');
    expect(ws).toHaveTextContent("$18,000.00");
    expect(ws).toHaveTextContent("$14,213.78");
    expect(ws).toHaveTextContent("hard");
    expect(ws).toHaveTextContent("79%");
    expect(document.querySelector('tr[data-scope="org"]')).toHaveTextContent(
      "not enforced",
    );
    expect(document.querySelectorAll('[data-placement="header"]')).toHaveLength(
      1,
    );
    expect(document.querySelectorAll('[data-placement="panel"]')).toHaveLength(
      1,
    );
    // The gateway policy read is down, and says so beside the ceilings.
    expect(screen.getByText("Spend could not be loaded")).toBeInTheDocument();
  });
});

describe("Spend › drill", () => {
  function drillOf(over: Partial<SpendDrill> = {}): SpendDrill {
    return {
      kind: "agent",
      key: "a-intel.core.stella-ci",
      period: { from: "2026-08-17", to: "2026-09-15" },
      total: figure({ cost: cost("30000000", "gateway_observed") }),
      series: [
        { day: "2026-09-13", cost: cost("10000000"), calls: 4, runs: 1 },
        { day: "2026-09-14", cost: null, calls: 0, runs: 0 },
        { day: "2026-09-15", cost: cost("20000000"), calls: 8, runs: 2 },
      ],
      perCall: { micros: "24193", currency: "USD" },
      perRun: { micros: "2500000", currency: "USD" },
      share: 0.1,
      tools: [{ name: "github__get_issue", calls: 5, runs: 2 }],
      ...over,
    };
  }

  it("opens an agent's drill with the crumb, Open the agent, the savings its findings hold, the kind's tiles, and the sparkline, and hides the summary tiles", async () => {
    drill.mockResolvedValue(readOk(drillOf()));
    findings.mockResolvedValue(readOk(listing()));
    await renderSpend(["agent", "a-intel.core.stella-ci"]);
    expect(drill).toHaveBeenCalledExactlyOnceWith(
      ctx,
      "agent",
      "a-intel.core.stella-ci",
    );
    expect(byGroup).not.toHaveBeenCalled();
    expect(screen.queryByTestId("spend-summary")).toBeNull();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    // The crumb goes back to the Month tab, which groups by agent on the bare path.
    expect(within(crumb).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/spend",
    );
    expect(crumb).toHaveTextContent("By agent");
    expect(
      screen.getByRole("link", { name: "Open the agent" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents/stella-ci");
    const savings = screen
      .getByRole("heading", { name: "Potential savings" })
      .closest("section");
    expect(savings).toHaveTextContent("$486.20");
    expect(savings).toHaveTextContent("1 finding on this agent directly");
    expect(tile("Spend per run")).toHaveTextContent("$2.50");
    expect(tile("Tool definitions")).toHaveTextContent("not recorded");
    expect(
      screen.getByRole("img", {
        name: "Spend by day from 2026-08-17 to 2026-09-15",
      }),
    ).toBeInTheDocument();
    const byDay = screen
      .getByRole("heading", { name: "Spend by day" })
      .closest("section");
    expect(byDay).toHaveTextContent("Peak $20.00 on 2026-09-15");
    expect(byDay).toHaveTextContent("Average $10.00");
    expect(rowOf("github__get_issue")).toHaveTextContent("5");
  });

  it("says what Export this view would do and that nothing was built", async () => {
    drill.mockResolvedValue(
      readOk(drillOf({ kind: "tool", key: "github__get_issue" })),
    );
    findings.mockResolvedValue(readOk(listing()));
    await renderSpend(["tool", "github__get_issue"]);
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/tool",
    );
    expect(crumb).toHaveTextContent("By tool");
    expect(screen.queryByRole("link", { name: "Open the agent" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Export this view" }),
    );
    const dialog = await screen.findByTestId("spend-drill-export");
    expect(dialog).toHaveTextContent("nothing was built");
    expect(dialog.querySelector("[data-issue]")).toHaveAttribute(
      "data-issue",
      "2962",
    );
  });

  it("names an operator's drill by the person", async () => {
    drill.mockResolvedValue(
      readOk(drillOf({ kind: "operator", key: "prn_marcusbell" })),
    );
    findings.mockResolvedValue(readOk(listing()));
    byGroup.mockResolvedValue(
      report([row("prn_marcusbell", { operator: MARCUS })]),
    );
    await renderSpend(["operator", "prn_marcusbell"]);
    expect(
      screen.getByRole("heading", { level: 2, name: "Marcus Bell" }),
    ).toBeInTheDocument();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/findings",
    );
    expect(crumb).toHaveTextContent("Findings");
    expect(tile("Budget position")).toHaveTextContent("not recorded");
  });

  it("says the findings could not be read, and that the key's runs called no tools, rather than drawing zeros (negative)", async () => {
    drill.mockResolvedValue(
      readOk(
        drillOf({
          tools: [],
          share: null,
          series: [{ day: "2026-09-15", cost: null, calls: 0, runs: 0 }],
        }),
      ),
    );
    findings.mockResolvedValue(readError("findings_down", 503));
    await renderSpend(["agent", "a-intel.core.stella-ci"]);
    const savings = screen
      .getByRole("heading", { name: "Potential savings" })
      .closest("section");
    if (savings === null) throw new Error("no savings panel");
    expect(savings).toHaveTextContent("not recorded");
    expect(savings).toHaveTextContent("The findings could not be read.");
    expect(
      screen.getByText("Its runs called no tools in this window."),
    ).toBeInTheDocument();
    const own = screen
      .getByRole("heading", { name: "Findings" })
      .closest("section");
    expect(own).toHaveTextContent("The findings could not be read.");
    expect(document.querySelector("[data-finding]")).toBeNull();
  });

  it("says none identified when no open finding names the key", async () => {
    drill.mockResolvedValue(
      readOk(drillOf({ key: "a-intel.core.quiet-agent" })),
    );
    findings.mockResolvedValue(readOk(listing()));
    await renderSpend(["agent", "a-intel.core.quiet-agent"]);
    const savings = screen
      .getByRole("heading", { name: "Potential savings" })
      .closest("section");
    expect(savings).toHaveTextContent("none identified");
    expect(savings).toHaveTextContent("0 findings on this agent directly");
    expect(
      screen.getByText("No open finding names this key."),
    ).toBeInTheDocument();
  });
});

describe("Spend › states", () => {
  it("renders the empty state verbatim, in place of the header, with the way back to Fleet", async () => {
    byGroup.mockResolvedValue(
      report([], figure({ cost: null, calls: 0, runs: 0 })),
    );
    findings.mockResolvedValue(readOk(listing()));
    waste.mockResolvedValue(readOk(wasteRead));
    budgets.mockResolvedValue(readOk([]));
    await renderSpend(["tool"]);
    const empty = screen.getByTestId("spend-empty");
    expect(within(empty).getByRole("heading")).toHaveTextContent(
      "Nothing spent yet",
    );
    expect(empty).toHaveTextContent("Spend fills in from the first run.");
    expect(
      within(empty).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    expect(screen.queryByRole("button", { name: "Set a budget" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Spend",
    );
  });

  it("renders the error state with the code, Try again, Open an incident and the trace line (negative)", async () => {
    byGroup.mockResolvedValue(readError("rollup_rebuild_in_progress", 504));
    findings.mockResolvedValue(readOk(listing()));
    waste.mockResolvedValue(readOk(wasteRead));
    budgets.mockResolvedValue(readOk([]));
    await renderSpend(["tokens"]);
    const error = screen.getByTestId("spend-error");
    expect(within(error).getByRole("heading")).toHaveTextContent(
      "Spend could not be loaded",
    );
    expect(error).toHaveTextContent(
      "The control plane answered 504 rollup_rebuild_in_progress. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend/tokens");
    expect(error).toHaveTextContent("2026-09-15T12:00:00.000Z");
    await userEvent.click(
      within(error).getByRole("button", { name: "Open an incident" }),
    );
    const dialog = await screen.findByTestId("spend-incident");
    expect(dialog).toHaveTextContent("nothing was filed");
    expect(dialog.querySelector("[data-issue]")).toHaveAttribute(
      "data-issue",
      "3847",
    );
  });

  it("renders the denied state with the permission, Request access, Back to Fleet, and who asked (negative)", async () => {
    byGroup.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "get_spend",
    });
    findings.mockResolvedValue(readOk(listing()));
    waste.mockResolvedValue(readOk(wasteRead));
    budgets.mockResolvedValue(readOk([]));
    await renderSpend();
    const denied = screen.getByTestId("spend-denied");
    expect(within(denied).getByRole("heading")).toHaveTextContent(
      "You cannot see this workspace’s spend",
    );
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include get_spend on core-platform.",
    );
    expect(denied).toHaveTextContent("Signed in as");
    expect(denied).toHaveTextContent(
      "org.member, workspace.member on core-platform",
    );
    expect(denied).toHaveTextContent("Decided by");
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(denied).getByRole("button", { name: "Request access" }),
    );
    const dialog = await screen.findByTestId("spend-request-access");
    expect(dialog).toHaveTextContent("nothing was sent");
  });

  it("renders a waiting access request with its id", async () => {
    byGroup.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "areq_1",
    });
    findings.mockResolvedValue(readOk(listing()));
    waste.mockResolvedValue(readOk(wasteRead));
    budgets.mockResolvedValue(readOk([]));
    await renderSpend();
    expect(screen.getByTestId("spend-pending")).toHaveTextContent("areq_1");
  });

  it("replaces only a tab's body when the tab's own read fails, keeping one h1 (negative)", async () => {
    loaded();
    byGroup.mockImplementation((_ctx, groupBy) =>
      Promise.resolve(
        groupBy === "model" ? monthByModel() : readError("rollup_down", 503),
      ),
    );
    await renderSpend(["tool"]);
    expect(screen.getByTestId("spend-summary")).toBeInTheDocument();
    expect(screen.getByTestId("spend-error")).toHaveTextContent(
      "503 rollup_down",
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("draws the loading skeleton: four tile blocks and a panel of seven rows, with no figure", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SpendLoading />
      </NextIntlClientProvider>,
    );
    const loading = screen.getByTestId("spend-loading");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(
      loading.querySelectorAll("[aria-hidden=true]").length,
    ).toBeGreaterThanOrEqual(11);
    expect(loading.querySelector("[data-testid=money]")).toBeNull();
    expect(loading).not.toHaveTextContent("$");
    // Every bone is the design's shimmer, as on every other page, and none pulses.
    expect(loading.querySelectorAll(".skeleton").length).toBeGreaterThanOrEqual(
      11,
    );
    expect(loading.querySelector(".animate-pulse")).toBeNull();
  });
});

describe("Spend › this build's own tabs", () => {
  it("reads the cost_center level and prints the unassigned share as its own row", async () => {
    loaded({
      cost_center: report([
        row("platform", { cost: cost("6000000") }),
        row("~none", { cost: cost("6345678") }),
      ]),
    });
    await renderSpend(["cost_center"]);
    expect(byGroup).toHaveBeenCalledWith(ctx, "cost_center", PERIOD);
    expect(screen.getByText("No cost center")).toBeInTheDocument();
  });

  it("prints a task row as text with no drill", async () => {
    loaded({ task: report([row("Cut the 4.11 release notes")]) });
    await renderSpend(["task"]);
    const task = rowOf("Cut the 4.11 release notes");
    expect(within(task).queryByRole("link")).toBeNull();
  });
});

describe("Spend › a tab's own read failing", () => {
  it.each([
    [
      "findings",
      () => findings.mockResolvedValue(readError("findings_down", 503)),
    ],
    ["waste", () => waste.mockResolvedValue(readError("waste_down", 503))],
    [
      "budgets",
      () => budgets.mockResolvedValue(readError("budgets_down", 503)),
    ],
  ] as const)(
    "replaces only the %s tab's body with its refusal (negative)",
    async (tab, fail) => {
      loaded();
      fail();
      await renderSpend([tab]);
      expect(screen.getByTestId("spend-summary")).toBeInTheDocument();
      expect(screen.getByTestId("spend-error")).toHaveTextContent(
        `503 ${tab}_down`,
      );
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    },
  );

  it("replaces only the cost_center tab's body when its rollup fails (negative)", async () => {
    loaded({ cost_center: readError("rollup_down", 503) });
    await renderSpend(["cost_center"]);
    expect(screen.getByTestId("spend-summary")).toBeInTheDocument();
    expect(screen.getByTestId("spend-error")).toHaveTextContent(
      "503 rollup_down",
    );
  });

  it("prints the tool table with savings not recorded when the findings read failed", async () => {
    loaded({ tool: report([row("github__get_issue")]) });
    findings.mockResolvedValue(readError("findings_down", 503));
    await renderSpend(["tool"]);
    const github = rowOf("github__get_issue");
    if (!(github instanceof HTMLTableRowElement)) throw new Error("not a row");
    // Potential savings is the ninth column: unread findings are not "none".
    const savings = github.cells[8];
    expect(savings).toHaveTextContent("not recorded");
    expect(savings).not.toHaveTextContent("none");
  });

  it("replaces the whole drill with its refusal when the drill read fails (negative)", async () => {
    drill.mockResolvedValue(readError("drill_down", 503));
    findings.mockResolvedValue(readOk(listing()));
    await renderSpend(["agent", "a-intel.core.stella-ci"]);
    expect(screen.getByTestId("spend-error")).toHaveTextContent(
      "503 drill_down",
    );
  });

  it("names an operator's drill by the key when the operator rollup does not hold them", async () => {
    drill.mockResolvedValue(
      readOk({
        kind: "operator",
        key: "prn_nobody",
        period: PERIOD,
        total: figure(),
        series: [],
        perCall: null,
        perRun: null,
        share: null,
        tools: [],
      }),
    );
    findings.mockResolvedValue(readOk(listing()));
    byGroup.mockResolvedValue(
      report([row("prn_marcusbell", { operator: MARCUS })]),
    );
    await renderSpend(["operator", "prn_nobody"]);
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe(
      "prn_nobody",
    );
  });

  it("still lists findings, naming nobody, when the operator rollup read fails", async () => {
    loaded();
    byGroup.mockImplementation((_ctx, groupBy) =>
      Promise.resolve(
        groupBy === "model" ? monthByModel() : readError("rollup_down", 503),
      ),
    );
    await renderSpend(["findings"]);
    expect(
      document.querySelector('li[data-finding="fnd_01k5rtop"]')?.textContent,
    ).toContain("prn_marcusbell");
  });

  it("offers a workspace owner the gateway policy form under the budgets", async () => {
    loaded();
    gatewayPolicy.mockResolvedValue(
      readOk({
        mode: "observed",
        sessionLimit: null,
        sessionLimitUsd: null,
        modelAllow: null,
        modelDeny: [],
      }),
    );
    await renderSpend(["budgets"], undefined, ctxAs("owner"));
    expect(document.querySelector("#gateway-mode")).not.toBeNull();
  });
});

describe("Spend › what a read did not record", () => {
  it("prints Wasted spend with nothing recorded as not recorded, not as zeros (negative)", async () => {
    loaded();
    waste.mockResolvedValue(
      readOk({
        wasted: null,
        share: null,
        runsWithWaste: 0,
        largestCause: null,
        causes: [],
      }),
    );
    await renderSpend(["waste"]);
    const wasted = screen
      .getAllByText("Wasted", { selector: "dt" })
      .map((dt) => dt.closest("div"))
      .find((box) => box?.textContent.includes("not recorded"));
    expect(wasted).toBeTruthy();
    expect(tile("Share of spend")).toHaveTextContent("not recorded");
    expect(tile("Largest cause")).toHaveTextContent("No waste found");
    expect(
      screen.getByText("No run in this period shows waste in its frames."),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-run]")).toBeNull();
  });

  it("draws a cause's bar empty when the total wasted is not recorded", async () => {
    loaded();
    waste.mockResolvedValue(
      readOk({ ...wasteRead, wasted: null, share: null }),
    );
    await renderSpend(["waste"]);
    const cause = document.querySelector(
      'li[data-cause="cache_write_never_read"]',
    );
    if (!(cause instanceof HTMLElement)) throw new Error("no cause");
    expect(cause.querySelector('[style*="width"]')).toHaveStyle({
      width: "0%",
    });
  });

  it("says why By agent is missing when its read is refused, and prints no share of an empty month (negative)", async () => {
    byGroup.mockImplementation((_ctx, groupBy) =>
      Promise.resolve(
        groupBy === "agent" ? readError("rollup_down", 503) : report([]),
      ),
    );
    findings.mockResolvedValue(readOk(listing()));
    waste.mockResolvedValue(readOk(wasteRead));
    budgets.mockResolvedValue(readOk(budgetRows));
    gatewayPolicy.mockResolvedValue(readError("gateway_down", 503));
    await renderSpend(["tokens"]);
    const byAgent = screen
      .getByRole("heading", { name: "By agent" })
      .closest("section");
    if (byAgent === null) throw new Error("no By agent panel");
    expect(within(byAgent).queryByRole("table")).toBeNull();
    expect(byAgent).toHaveTextContent("rollup_down");
    const output = document.querySelector('tr[data-token-class="output"]');
    expect(output).toHaveTextContent("0");
    expect(output).toHaveTextContent("not recorded");
  });

  it("prints no per-run figure for an agent with no runs, and no basis for a row without a cost", async () => {
    loaded({
      agent: report([
        row("a-intel.core.idle", {
          runs: 0,
          cost: null,
          tokens: {
            input_uncached: 0,
            cache_read: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            output: 0,
            reasoning: 0,
          },
        }),
      ]),
    });
    await renderSpend(["tokens"]);
    const idle = rowOf("a-intel.core.idle");
    expect(
      within(idle).getAllByText("not recorded").length,
    ).toBeGreaterThanOrEqual(4);
    expect(within(idle).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/idle",
    );
  });
});
