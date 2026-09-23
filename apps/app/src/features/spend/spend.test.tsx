// @vitest-environment jsdom
// The Spend page against its rev1 design (oxagen-roadmap mockups/pages/
// spend.md) on a fake DataSource: the header with its one gold action, the
// four summary tiles, the tabs with their counts, every tab's panels and
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
import { expectNoAxe } from "@/test/expect-no-axe";
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
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Spend } = await import("./spend");
const { SpendLoading } = await import("./states");
const { parseSpendView } = await import("./view");

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
const source: DataSource = {
  runtimes: { list: vi.fn(), agents: vi.fn() },
  pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
  shell: { context: vi.fn(), preferences: vi.fn() },
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
    transcript: vi.fn(),
    chain: vi.fn(),
    outputs: vi.fn(),
    work: vi.fn(),
    outcomesSettings: vi.fn(),
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
    sso: vi.fn(),
  },
  mandates: { list: vi.fn(), get: vi.fn() },
  audit: { events: vi.fn(), exportEvents: vi.fn() },
  skills: { inventory: vi.fn(), configuration: vi.fn() },
  steering: {
    records: vi.fn(),
    record: vi.fn(),
    proposals: vi.fn(),
    contextPr: vi.fn(),
    freshness: vi.fn(),
    hub: vi.fn(),
    deliveries: vi.fn(),
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

/** The route's own parse, so a test names a path the way a person does. */
async function renderSpend(segments: readonly string[] = [], finding?: string) {
  const view = parseSpendView(segments, finding);
  if (view === null) throw new Error(`no view for ${segments.join("/")}`);
  const element = await Spend({ ctx, source, view, today: TODAY });
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
      provingRuns: ["arun_01k5rn8f3j", "tse_01k5rn9aaa"],
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
    .map((th) => th.textContent ?? "");
}

describe("Spend › header, tiles and tabs", () => {
  it("names the workspace, says what the page is for, and offers Export report and Set a budget with one gold action", async () => {
    loaded();
    await renderSpend();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Spend",
    );
    expect(screen.getByText("Core platform")).toBeInTheDocument();
    expect(
      screen.getByText(
        "What the tokens bought, with the basis on every number.",
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
    await renderSpend();
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

  it("lists the design's nine tabs first, in order, with live counts, as path links", async () => {
    loaded();
    await renderSpend(["waste"]);
    const nav = screen.getByRole("navigation", { name: "Spend views" });
    const links = within(nav).getAllByRole("link");
    expect(links.slice(0, 9).map((a) => a.textContent)).toEqual([
      "Findings3",
      "Tokens",
      "Coaching",
      "By operator",
      "By agent",
      "By model",
      "By tool",
      "Wasted spend2",
      "Budgets2",
    ]);
    expect(links[0]).toHaveAttribute("href", "/acme/core-platform/spend");
    expect(links[7]).toHaveAttribute("href", "/acme/core-platform/spend/waste");
    expect(links[7]).toHaveAttribute("aria-current", "page");
  });

  it("leaves a count off when its read did not answer, rather than printing a zero", async () => {
    loaded();
    findings.mockResolvedValue(readError("findings_down", 503));
    waste.mockResolvedValue(readError("waste_down", 503));
    await renderSpend(["model"]);
    const nav = screen.getByRole("navigation", { name: "Spend views" });
    expect(
      within(nav).getByRole("link", { name: "Findings" }),
    ).toBeInTheDocument();
    expect(tile("Wasted")).toHaveTextContent("not recorded");
  });
});

describe("Spend › Findings", () => {
  it("leads with the savings identified, the share strip, the legend and the four facts", async () => {
    loaded({ operator: report([row("prn_marcusbell", { operator: MARCUS })]) });
    await renderSpend();
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
    await renderSpend();
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
    expect(first).toHaveTextContent("at stake · 58.9% of identified");
    expect(
      within(first).getByRole("link", { name: "Evidence" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend?finding=fnd_01k5rtgh");
    expect(
      within(first).getByRole("button", { name: "Fix" }),
    ).toBeInTheDocument();
    // An operator finding names the person, not the principal id.
    expect(cards[2]).toHaveTextContent("Marcus Bell");
    expect(cards[2]).not.toHaveTextContent("prn_marcusbell");
  });

  it("filters by level and confidence, sorts, and pages the cards", async () => {
    loaded();
    await renderSpend();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Level"), "agent");
    let cards = screen
      .getAllByRole("listitem")
      .filter((li) => li.dataset.finding);
    expect(cards.map((c) => c.dataset.finding)).toEqual(["fnd_01k5rteg"]);
    await user.selectOptions(screen.getByLabelText("Level"), "all");
    await user.selectOptions(screen.getByLabelText("Confidence"), "high");
    await user.selectOptions(screen.getByLabelText("Sort"), "savingAsc");
    cards = screen.getAllByRole("listitem").filter((li) => li.dataset.finding);
    expect(cards.map((c) => c.dataset.finding)).toEqual([
      "fnd_01k5rtop",
      "fnd_01k5rtgh",
    ]);
    expect(screen.getByRole("navigation", { name: "Pages" })).toHaveTextContent(
      "1 to 2 of 2",
    );
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
    await renderSpend();
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
    await renderSpend([], "fnd_01k5rtgh");
    expect(findingEvidence).toHaveBeenCalledExactlyOnceWith(
      ctx,
      "fnd_01k5rtgh",
    );
    const dialog = await screen.findByTestId("spend-evidence-dialog");
    expect(within(dialog).getByText("Evidence")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("2,980 of 3,106");
    expect(dialog).toHaveTextContent("$1,030.40");
    expect(
      within(dialog).getByRole("link", { name: "arun_01k5rn8f3j" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_01k5rn8f3j");
  });

  it("says inside the dialog when the evidence read is refused (negative)", async () => {
    loaded();
    findingEvidence.mockResolvedValue(readError("finding_missing", 404));
    await renderSpend([], "fnd_01k5rtgh");
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
    expect(
      within(rows[0] as HTMLElement).getByRole("link", {
        name: "a-intel.core.agent-12",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/agents/agent-12");
    expect(
      document.querySelector('tr[data-key="a-intel.core.agent-0"]'),
    ).toBeNull();
  });
});

describe("Spend › Coaching", () => {
  it("names the coaching it will show and that no record backs it, inventing no item", async () => {
    loaded();
    await renderSpend(["coaching"]);
    const panel = screen
      .getByRole("heading", { name: "Coaching" })
      .closest("section");
    if (panel === null) throw new Error("no coaching panel");
    expect(within(panel).getByTestId("spend-not-backed")).toHaveAttribute(
      "data-issue",
      "2962",
    );
    expect(panel).toHaveTextContent("Get to one prompt per session");
    expect(panel).toHaveTextContent("Stop the retry storms");
    expect(panel.querySelectorAll("[data-signal]")).toHaveLength(13);
    expect(panel.querySelector("[data-testid=money]")).toBeNull();
  });
});

describe("Spend › By operator", () => {
  it("prints the design's columns, the person by name, tokens and cache from the row, savings from the operator's findings, and opens the drill", async () => {
    loaded({
      operator: report([
        row("prn_marcusbell", {
          cost: cost("9000000", "mixed"),
          operator: MARCUS,
        }),
        row("prn_ada", { cost: null }),
      ]),
    });
    await renderSpend(["operator"]);
    expect(byGroup).toHaveBeenCalledWith(ctx, "operator", PERIOD);
    const table = screen.getByRole("table", { name: "By operator" });
    expect(headers(table)).toEqual([
      "Operator",
      "Role",
      "Agents",
      "Runs",
      "Spend",
      "Tokens",
      "Cache hit",
      "Potential savings",
      "Budget position",
    ]);
    const marcus = rowOf("prn_marcusbell");
    expect(
      within(marcus).getByRole("link", { name: "Marcus Bell" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/operator/prn_marcusbell",
    );
    expect(marcus).toHaveTextContent("workspace.owner");
    expect(marcus).toHaveTextContent("275");
    expect(marcus).toHaveTextContent("40%");
    expect(marcus).toHaveTextContent("$200.00");
    expect(marcus).toHaveTextContent("1 finding");
    expect(marcus.querySelector("[data-basis]")).toHaveAttribute(
      "data-basis",
      "mixed",
    );
    const ada = rowOf("prn_ada");
    expect(ada).toHaveTextContent("none");
    expect(ada).not.toHaveTextContent("$0.00");
    expect(
      screen.getByText(/Every run has exactly one operator/),
    ).toBeInTheDocument();
  });
});

describe("Spend › By agent", () => {
  it("prints Agent, Runs, Spend, Tokens, Per run, Cache hit, Potential savings and Trend, and opens the drill", async () => {
    loaded({ agent: report([row("a-intel.core.stella-ci")]) });
    await renderSpend(["agent"]);
    const table = screen.getByRole("table", { name: "By agent" });
    expect(headers(table)).toEqual([
      "Agent",
      "Runs",
      "Spend",
      "Tokens",
      "Per run",
      "Cache hit",
      "Potential savings",
      "Trend",
    ]);
    const agent = rowOf("a-intel.core.stella-ci");
    expect(within(agent).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/agent/a-intel.core.stella-ci",
    );
    // 275 tokens over 12 runs is 23 a run.
    expect(agent).toHaveTextContent("23");
    expect(agent).toHaveTextContent("$486.20");
    expect(agent).toHaveTextContent("not recorded");
  });
});

describe("Spend › By model", () => {
  it("reads Models and keys with its routes link and a Total row equal to the Spend tile", async () => {
    loaded();
    await renderSpend(["model"]);
    const table = screen.getByRole("table", { name: "Models and keys" });
    expect(headers(table)).toEqual([
      "Model",
      "Provider key",
      "Model calls",
      "Spend",
      "Cache hit rate",
      "Basis",
    ]);
    expect(
      screen.getByText(
        "Every model the workspace called this month, and the provider key it was billed to.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Model routes" })).toHaveAttribute(
      "href",
      "/acme/model-funding",
    );
    expect(rowOf("claude-opus-5")).toHaveTextContent("anthropic");
    expect(rowOf("claude-opus-5")).toHaveTextContent("75%");
    const total = document.querySelector("tr[data-total]");
    expect(total).toHaveTextContent("Total");
    expect(total).toHaveTextContent("$12.35");
    expect(tile("Spend")).toHaveTextContent("$12.35");
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
      "What the frames say",
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
    await userEvent.click(buttons[2] as HTMLElement);
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
    const run = document.querySelector('[data-run="tse_01k5rn9aaa"]');
    if (!(run instanceof HTMLElement)) throw new Error("no run card");
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
    expect(within(crumb).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/agent",
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
    expect(tile("Budget position")).toHaveTextContent("not recorded");
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
    await renderSpend(["operator"]);
    const empty = screen.getByTestId("spend-empty");
    expect(within(empty).getByRole("heading")).toHaveTextContent(
      "No spend to report yet",
    );
    expect(empty).toHaveTextContent(
      "Rollups are derived indexes rebuilt from frames. With no model call recorded there is nothing to roll up, and nothing billable.",
    );
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
    await renderSpend(["agent"]);
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
