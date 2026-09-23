// @vitest-environment jsdom
// The Steering hub over a fake DataSource (roadmap pages/steering.md): the
// header with the governance chip and one gold action, the five tabs as path
// segments, the Library's shelf row and its All shelf, the empty, error,
// denied and loading states, and each tab and shelf making only its own
// reads: Records in its ok, filtered, empty and paged states, Proposals with
// their support and the writes each state allows, Context PRs with the table
// and the selected proposal's panel, and Assignments with the delivery
// report. An axe check runs in every one. The panel's own states are in
// context-pr-panel.test.tsx and the dialog's in governance.test.tsx.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalStatus } from "@/data/contracts/steering";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  PROPOSAL_ID,
  publishedRecord,
  proposal,
  steeringHub,
  type SteeringReads,
  steeringSource,
} from "@/test/steering-views";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  openContextPr: vi.fn(),
  mergeContextPr: vi.fn(),
  dismissProposal: vi.fn(),
  setSteeringGate: vi.fn(),
  setGovernanceMode: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
// The Skills tab is the Skills lane's inventory; its states are its own test
// (features/skills/skills.test.tsx). Here the tab only has to hand it the
// viewer, the data source and the page the URL names.
const { Skills } = vi.hoisted(() => ({
  Skills: vi.fn((props: { cursor: string | null }) => (
    <p data-testid="skills-tab" data-cursor={props.cursor ?? ""} />
  )),
}));
vi.mock("@/features/skills", () => ({
  Skills,
  SkillsLoading: () => null,
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Steering } = await import("./steering");
const { SteeringLoading } = await import("./page-state");
const { resolveSteeringRoute } = await import("./view");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const BASE = "/acme/core-platform/steering";
const DENIED = {
  ok: false,
  reason: "denied",
  permission: "steering.read",
} as const;
const DOWN = readError("record_index_unavailable", 503);

/**
 * Renders the hub at `path` under `/acme/core-platform/steering`, resolved the
 * way the routes resolve it. The header is the route's; here it is a plain
 * banner holding the actions the hub hands it.
 */
async function renderSteering(path = "", reads: Partial<SteeringReads> = {}) {
  const { source, calls } = steeringSource(reads);
  const url = new URL(`http://oxagen.test${BASE}${path}`);
  const segments = url.pathname
    .slice(BASE.length)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const route = resolveSteeringRoute(
    { org: "acme", ws: "core-platform" },
    segments.length === 0 ? undefined : segments,
    Object.fromEntries(url.searchParams),
  );
  if (route.kind !== "view") throw new Error(`${path} is ${route.kind}`);
  const element = await Steering({
    ctx,
    source,
    view: route.view,
    header: (actions) => (
      <header data-testid="hub-header">
        <h1>Steering</h1>
        {actions}
      </header>
    ),
  });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

const section = (name: string) => screen.getByRole("region", { name });

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const tab = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${name}`) });

describe("the hub", () => {
  it("opens the Library's All shelf on the bare route with the five tabs as path segments, in order", async () => {
    const calls = await renderSteering();
    expect(calls.records).toEqual([[ctx, { kind: null, offset: 0 }]]);
    expect(calls.hub).toEqual([[ctx]]);
    expect(calls.proposals).toEqual([]);
    const tabs = screen.getByRole("tablist", { name: "Steering" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => [
          t.textContent,
          t.getAttribute("href"),
          t.getAttribute("aria-selected"),
        ]),
    ).toEqual([
      ["Library1", `${BASE}/library`, "true"],
      ["Assignments", `${BASE}/assignments`, "false"],
      ["Gates", `${BASE}/gates`, "false"],
      ["Proposals3", `${BASE}/proposals`, "false"],
      ["Compiler", `${BASE}/compiler`, "false"],
    ]);
  });

  it("carries the governance chip and exactly one gold action in the header", async () => {
    await renderSteering();
    const header = screen.getByTestId("hub-header");
    expect(within(header).getByTestId("governance-chip")).toHaveTextContent(
      "Governance: team",
    );
    expect(document.querySelectorAll("[data-create]")).toHaveLength(1);
    expect(
      within(header).getByRole("button", { name: "Write a context record" }),
    ).toHaveAttribute("data-create", "record");
  });

  it("draws the shelf row with a count per shelf and aria-pressed on each chip", async () => {
    await renderSteering();
    const row = screen.getByRole("group", { name: "Library shelves" });
    expect(
      within(row)
        .getAllByRole("button")
        .map((chip) => [
          chip.getAttribute("data-shelf"),
          chip.getAttribute("href"),
          chip.getAttribute("aria-pressed"),
          chip.querySelector("[data-count]")?.getAttribute("data-count"),
        ]),
    ).toEqual([
      ["all", `${BASE}/library`, "true", "1"],
      ["records", `${BASE}/records`, "false", "1"],
      ["skills", `${BASE}/skills`, "false", "not-recorded"],
      ["memory", `${BASE}/memory`, "false", "not-recorded"],
      ["ontology", `${BASE}/ontology`, "false", "not-recorded"],
    ]);
  });

  it.each([
    ["/records", "records"],
    ["/skills", "skills"],
    ["/memory", "memory"],
    ["/ontology", "ontology"],
    ["/library", "all"],
  ])(
    "lands %s on the Library tab with its own chip pressed",
    async (path, shelf) => {
      await renderSteering(path);
      expect(tab("Library")).toHaveAttribute("aria-selected", "true");
      const row = screen.getByRole("group", { name: "Library shelves" });
      expect(
        within(row)
          .getAllByRole("button")
          .filter((chip) => chip.getAttribute("aria-pressed") === "true")
          .map((chip) => chip.getAttribute("data-shelf")),
      ).toEqual([shelf]);
    },
  );

  it.each([
    ["/assignments", "Assignments", "tab-assignments"],
    ["/gates", "Gates", "tab-gates"],
    ["/proposals", "Proposals", "tab-proposals"],
    ["/compiler/release-manager", "Compiler", "tab-compiler"],
  ])(
    "renders %s under its own tab with no shelf row",
    async (path, name, body) => {
      await renderSteering(path);
      expect(tab(name)).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId(body)).toBeInTheDocument();
      expect(
        screen.queryByRole("group", { name: "Library shelves" }),
      ).toBeNull();
    },
  );

  it("names the agent the Compiler assembles for, and says what it waits on", async () => {
    await renderSteering("/compiler/release-manager");
    expect(screen.getByTestId("tab-compiler")).toHaveAttribute(
      "data-agent",
      "release-manager",
    );
    const gap = screen.getByTestId("compiler-not-backed");
    expect(gap).toHaveTextContent(
      "Not recorded yet: one assembly for one agent and one prompt",
    );
    expect(gap).toHaveTextContent("Tracked in #3297");
    expect(gap).toHaveAttribute("data-issue", "3297");
  });

  it.each(["memory", "ontology", "instructions"])(
    "names what the %s shelf waits on and draws no figure",
    async (shelf) => {
      const calls = await renderSteering(`/${shelf}`);
      const gap = screen.getByTestId(`${shelf}-not-backed`);
      expect(gap).toHaveTextContent("Not recorded yet:");
      expect(gap).toHaveAttribute("data-issue", "3830");
      expect(calls.proposals).toEqual([]);
    },
  );

  it("keeps the freshness gates on Gates and reads them there only", async () => {
    const calls = await renderSteering("/gates");
    expect(calls.freshness).toEqual([[ctx]]);
    expect(section("Steering freshness")).toBeVisible();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByTestId("gates-not-backed")).toBeInTheDocument();
  });

  it("names a failed freshness read inside Gates", async () => {
    await renderSteering("/gates", { freshness: DOWN });
    expect(
      screen.getByText(
        "Steering freshness could not be loaded: record_index_unavailable. Nothing was changed.",
      ),
    ).toBeVisible();
  });

  it("opens Skills with the page the URL names and gives the gold to Add a skill", async () => {
    const calls = await renderSteering("/skills?cursor=c2");
    expect(calls.proposals).toEqual([]);
    expect(Skills.mock.calls.at(-1)?.[0]).toMatchObject({ ctx, cursor: "c2" });
    expect(screen.getByTestId("skills-tab")).toHaveAttribute(
      "data-cursor",
      "c2",
    );
    expect(screen.getByRole("button", { name: "Add a skill" })).toHaveAttribute(
      "data-create",
      "skill",
    );
  });

  it("presses the Context PRs segment on /proposals/prs", async () => {
    await renderSteering("/proposals/prs");
    const segments = screen.getByRole("group", {
      name: "Proposals or pull requests",
    });
    expect(
      within(segments).getByRole("button", { name: "Context PRs" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(segments).getByRole("button", { name: "Candidates" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("prints no mode and no waiting count when the hub read fails, and keeps the library (negative)", async () => {
    await renderSteering("", { hub: DOWN });
    expect(screen.getByTestId("governance-chip")).toHaveTextContent(
      "Governance: not read",
    );
    expect(tab("Proposals")).toHaveTextContent(/^Proposals$/);
    expect(screen.getByTestId("library-all")).toBeInTheDocument();
  });

  it.each([
    [{ state: "unbound" } as const, "unbound"],
    [{ state: "unread", code: "github_not_connected" } as const, "not read"],
    [
      { state: "read", repository: "acme/platform", mode: "absent" } as const,
      "team",
    ],
    [
      { state: "read", repository: "acme/platform", mode: "invalid" } as const,
      "invalid",
    ],
  ])("prints the chip for governance %o as %s", async (governance, shown) => {
    await renderSteering("", {
      hub: readOk(steeringHub({ governance })),
    });
    expect(screen.getByTestId("governance-chip")).toHaveTextContent(
      `Governance: ${shown}`,
    );
  });
});

describe("the Library, All shelf", () => {
  const three = readOk({
    records: [
      publishedRecord({
        id: "ctr_b",
        lineage: "ctx.b.info",
        force: "info",
        statement: "An info record.",
      }),
      publishedRecord({
        id: "ctr_a",
        lineage: "ctx.a.must",
        force: "must",
        statement: "A must record.",
      }),
      publishedRecord({
        id: "ctr_c",
        lineage: "ctx.c.should",
        force: "should",
        kind: "rule",
        statement: "A should record.",
        path: null,
        commit: null,
      }),
    ],
    total: 3,
  });

  it("prints the stat strip with each tile's basis, and not recorded for what no read measures", async () => {
    await renderSteering("/library", { records: three });
    expect(screen.getByTestId("tile-items")).toHaveTextContent(
      "Items3everything that can steer an agent here",
    );
    expect(screen.getByTestId("tile-by-kind")).toHaveTextContent(
      "By kindrecord 3one shape, every kind",
    );
    expect(screen.getByTestId("tile-compiled-size")).toHaveTextContent(
      "Compiled sizenot recordedif every item were rendered at once, which no run does",
    );
    expect(screen.getByTestId("tile-grants")).toHaveTextContent(
      "Carry a grantnot recordedthese compile to a gate as well as to text",
    );
  });

  it("prints the lead note verbatim", async () => {
    await renderSteering();
    expect(screen.getByTestId("library-lead")).toHaveTextContent(
      "A shelf is a filter on this list, never a second list. The assembler reads exactly these items, in this order, and decides per run which of them a given agent is shown. Assignments says who receives what; the compiler shows one decision in full.",
    );
  });

  it("lists everything written down in the assembler's order under the design's columns", async () => {
    await renderSteering("/library", { records: three });
    const panel = section("Everything written down");
    expect(within(panel).getByTestId("library-count")).toHaveTextContent("3");
    expect(
      within(panel).getByRole("link", { name: "Who receives it" }),
    ).toHaveAttribute("href", `${BASE}/assignments`);
    const table = within(panel).getByRole("table", {
      name: "Everything written down",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Item",
      "Kind",
      "Force",
      "Scope",
      "Compiles to",
      "Token cost",
      "Source",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-lineage"))).toEqual([
      "ctx.a.must",
      "ctx.c.should",
      "ctx.b.info",
    ]);
    const [must, should] = rows;
    expect(must).toHaveTextContent("A must record.");
    expect(
      within(must ?? table).getByRole("link", { name: "ctx.a.must" }),
    ).toHaveAttribute("href", `${BASE}/records/ctx.a.must`);
    expect(must).toHaveTextContent("record · constraint");
    expect(must).toHaveTextContent(
      ".oxagen/rules/ctx.release.no-reread-changelog.toml @ 4d5e6f7",
    );
    expect(
      must?.querySelector('[data-compiles="not-recorded"]'),
    ).toHaveTextContent("not recorded");
    expect(should).toHaveTextContent("record · rule");
    expect(should).toHaveTextContent("workspace");
  });

  it("says steering and gating are two planes, and names the issue the other shelves wait on", async () => {
    await renderSteering();
    expect(
      screen.getByText(/Steering is what the model reads/),
    ).toHaveTextContent(
      "advisory, ranked, budgeted, and it may be dropped. Gating is what gets refused: deterministic, never budgeted, never ranked.",
    );
    expect(screen.getByTestId("library-gap")).toHaveTextContent(
      "Only records are read into this list today.",
    );
    expect(screen.getByTestId("library-gap")).toHaveTextContent(
      "tracked in #3830",
    );
  });

  it("pages the list by fifty on /library", async () => {
    const calls = await renderSteering("/library?offset=50", {
      records: readOk({ records: [publishedRecord()], total: 51 }),
    });
    expect(calls.records).toEqual([[ctx, { kind: null, offset: 50 }]]);
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      `${BASE}/library`,
    );
  });
});

describe("states", () => {
  const none = readOk({ records: [], total: 0 });

  it.each(["", "/records"])(
    "says nothing steers the workspace on %s, keeps the chip and the tabs, and moves the gold into the state",
    async (path) => {
      await renderSteering(path, { records: none });
      const empty = section("Nothing steers this workspace yet");
      expect(empty).toHaveTextContent(
        "Published records live in .oxagen/rules/ on acme/platform. A record becomes published by being merged, never by being saved here.",
      );
      expect(
        within(empty).getByRole("button", { name: "Write a context record" }),
      ).toBeVisible();
      expect(document.querySelectorAll("[data-create]")).toHaveLength(1);
      expect(screen.getByTestId("governance-chip")).toBeVisible();
      expect(screen.getAllByRole("tab")).toHaveLength(5);
      expect(tab("Library")).toHaveTextContent(/^Library$/);
    },
  );

  it("keeps the gold in the header on a tab whose own empty state is its lane's", async () => {
    await renderSteering("/gates", { records: none });
    expect(screen.queryByTestId("steering-empty")).toBeNull();
    expect(
      within(screen.getByTestId("hub-header")).getByRole("button", {
        name: "Write a context record",
      }),
    ).toBeVisible();
  });

  it("replaces the header and the body with the error state, and says what Open an incident would do", async () => {
    await renderSteering("/gates", { records: DOWN });
    const error = section("Steering could not be loaded");
    expect(error).toHaveTextContent(
      "The control plane answered 503 record_index_unavailable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", `${BASE}/gates`);
    expect(screen.getByTestId("steering-trace")).toHaveTextContent(
      /^503 record_index_unavailable · /,
    );
    fireEvent.click(
      within(error).getByRole("button", { name: "Open an incident" }),
    );
    expect(within(error).getByRole("status")).toHaveTextContent(
      "Oxagen records no incidents yet.",
    );
    expect(screen.queryByTestId("hub-header")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("replaces the header and the body with the denied state and what was needed", async () => {
    await renderSteering("", { records: DENIED });
    const denied = section("You cannot see this workspace’s steering");
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include steering.read on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    expect(denied).toHaveTextContent(
      "Signed in asworkspace.member · core-platform",
    );
    expect(denied).toHaveTextContent("Neededsteering.read on core-platform");
    expect(denied).toHaveTextContent("Decided bydeny wins over every allow");
    fireEvent.click(
      within(denied).getByRole("button", { name: "Request access" }),
    );
    expect(within(denied).getByRole("status")).toHaveTextContent(
      "Oxagen records no access requests yet.",
    );
    expect(screen.queryByTestId("hub-header")).toBeNull();
  });

  it("names a parked read's access request", async () => {
    await renderSteering("", {
      records: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "apr_1",
      },
    });
    expect(screen.getByTestId("steering-pending")).toHaveTextContent(
      "Access request apr_1",
    );
  });

  it("draws the skeleton: four tile blocks and a panel of seven rows", () => {
    render(
      <IntlProvider>
        <SteeringLoading />
      </IntlProvider>,
    );
    const loading = screen.getByRole("status", { name: "Loading steering" });
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading.querySelectorAll(".h-9")).toHaveLength(7);
    expect(loading.querySelectorAll(".h-\\[88px\\]")).toHaveLength(4);
  });
});

describe("Records", () => {
  it("prints each record's statement, classification, scope, lineage, version, commit, file and publication", async () => {
    await renderSteering("/records");
    const card = within(section("Published records")).getByRole("article");
    expect(card).toHaveAttribute("data-kind", "constraint");
    expect(card).toHaveTextContent(
      "Do not re-read CHANGELOG.md after the first read in a run.",
    );
    expect(card.querySelector('[data-term="force"]')).toHaveTextContent(
      "force must",
    );
    expect(
      card.querySelector('[data-term="constraint-effect"]'),
    ).toHaveTextContent("forbid");
    expect(card.querySelector('[data-term="scope"]')).toHaveTextContent(
      "workspace",
    );
    expect(card.querySelector('[data-fact="version"] dd')).toHaveTextContent(
      "3",
    );
    expect(card.querySelector('[data-fact="commit"] dd')).toHaveTextContent(
      "4d5e6f7a8b9c",
    );
    expect(card.querySelector('[data-fact="path"] dd')).toHaveTextContent(
      ".oxagen/rules/ctx.release.no-reread-changelog.toml",
    );
    expect(
      card.querySelector('[data-fact="published"] dd'),
    ).not.toBeEmptyDOMElement();
  });

  it("prints unclassified and the title for a record no Context PR wrote, with no fact it lacks", async () => {
    await renderSteering("/records", {
      records: readOk({
        records: [
          publishedRecord({
            kind: null,
            force: null,
            constraintEffect: null,
            statement: null,
            version: null,
            commit: null,
            path: null,
            publishedAt: null,
          }),
        ],
        total: 1,
      }),
    });
    const card = within(section("Published records")).getByRole("article");
    expect(card).toHaveAttribute("data-kind", "unclassified");
    expect(card).toHaveTextContent("Read CHANGELOG.md once per run");
    expect(card.querySelector('[data-term="force"]')).toBeNull();
    expect(card.querySelector("[data-fact]")).toBeNull();
  });

  it("links every kind, marks the one the URL asks for and reads that kind", async () => {
    const calls = await renderSteering("/records?kind=rule");
    // The hub counts every kind; the shelf reads the kind the URL names.
    expect(calls.records).toEqual([
      [ctx, { kind: null, offset: 0 }],
      [ctx, { kind: "rule", offset: 0 }],
    ]);
    const filter = screen.getByRole("navigation", {
      name: "Filter records by kind",
    });
    const links = within(filter).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `${BASE}/records`,
      `${BASE}/records?kind=rule`,
      `${BASE}/records?kind=constraint`,
      `${BASE}/records?kind=procedure`,
      `${BASE}/records?kind=fact`,
      `${BASE}/records?kind=memory`,
      `${BASE}/records?kind=preference`,
    ]);
    expect(
      links.filter((link) => link.getAttribute("aria-current") === "page"),
    ).toEqual([within(filter).getByRole("link", { name: "rule" })]);
  });

  it("says no record of a kind is in force and keeps the filter", async () => {
    await renderSteering("/records?kind=procedure", {
      records: (q) =>
        q.kind === null
          ? readOk({ records: [publishedRecord()], total: 1 })
          : readOk({ records: [], total: 0 }),
    });
    const records = section("Published records");
    expect(records).toHaveTextContent(
      "No record of that kind is in force in this workspace.",
    );
    expect(
      within(records).getByRole("navigation", {
        name: "Filter records by kind",
      }),
    ).toBeInTheDocument();
  });

  it("pages by fifty with the range, keeping the kind", async () => {
    const calls = await renderSteering("/records?kind=constraint&offset=50", {
      records: readOk({
        records: Array.from({ length: 2 }, (_, i) =>
          publishedRecord({ id: `ctr_r${String(i)}` }),
        ),
        total: 120,
      }),
    });
    expect(calls.records.at(-1)).toEqual([
      ctx,
      { kind: "constraint", offset: 50 },
    ]);
    const pager = screen.getByRole("navigation", { name: "Pages" });
    expect(pager).toHaveTextContent("51 to 52 of 120");
    expect(
      within(pager).getByRole("link", { name: "Previous page" }),
    ).toHaveAttribute("href", `${BASE}/records?kind=constraint`);
    expect(
      within(pager).getByRole("link", { name: "Next page" }),
    ).toHaveAttribute("href", `${BASE}/records?kind=constraint&offset=100`);
  });

  it("shows no pager when one page holds every record (negative)", async () => {
    await renderSteering("/records");
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
  });
});

describe("Proposals", () => {
  it("reads one page of proposals and nothing else, and prints each with its state, tally, source, rationale and support", async () => {
    const calls = await renderSteering("/proposals");
    expect(calls).toEqual({
      record: [],
      records: [[ctx, { kind: null, offset: 0 }]],
      proposals: [[ctx, { offset: 0 }]],
      contextPr: [],
      freshness: [],
      deliveries: [],
      hub: [[ctx]],
    });
    const card = within(section("Proposals")).getByRole("article");
    expect(card.querySelector("[data-status]")).toHaveTextContent(
      "checks passed",
    );
    expect(card).toHaveTextContent("6 of 6 checks pass");
    expect(card).toHaveTextContent("Raised by agent:release-bot");
    expect(card).toHaveTextContent(
      "Three sealed runs across two agents read CHANGELOG.md again after the first read.",
    );
    expect(card).toHaveTextContent(
      "Support: 3 runs, 2 agents, 1 records, 2 evidence links",
    );
    expect(card).toHaveTextContent("arun_01k5rs9q");
    expect(card).toHaveTextContent("frame:arun_01k5rs7m/14");
  });

  it("links a proposal with a pull request to its Context PR", async () => {
    await renderSteering("/proposals");
    expect(
      screen.getByRole("link", { name: "Context PR #519" }),
    ).toHaveAttribute("href", `${BASE}/proposals/prs?proposal=${PROPOSAL_ID}`);
  });

  it.each<[ProposalStatus, string[]]>([
    ["proposed", ["Open a Context PR", "Dismiss"]],
    ["pr_open", ["Run the checks again", "Dismiss"]],
    ["checks_failed", ["Run the checks again", "Dismiss"]],
    ["checks_passed", ["Run the checks again", "Dismiss"]],
    ["merged", []],
    ["rejected", []],
  ])("offers a %s proposal exactly its writes", async (status, writes) => {
    await renderSteering("/proposals", {
      proposals: readOk({
        proposals: [proposal({ status, pr: null, checks: null })],
        total: 1,
      }),
    });
    expect(
      within(screen.getByRole("article"))
        .queryAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(writes);
  });

  it("says a workspace has no proposals, and how one is raised", async () => {
    await renderSteering("/proposals", {
      proposals: readOk({ proposals: [], total: 0 }),
    });
    expect(section("No proposals in this workspace")).toHaveTextContent(
      "a person proposes one with oxagen context propose",
    );
  });

  it("renders a denied read in place of the proposals", async () => {
    await renderSteering("/proposals", { proposals: DENIED });
    expect(section("Proposals")).toHaveTextContent(
      "You cannot see Proposals in this workspace.",
    );
  });
});

describe("Context PRs", () => {
  it("lists only the proposals with a pull request and reads no Context PR until one is selected", async () => {
    const calls = await renderSteering("/proposals/prs", {
      proposals: readOk({
        proposals: [
          proposal(),
          proposal({ id: "prp_01k5rv9z", status: "proposed", pr: null }),
        ],
        total: 2,
      }),
    });
    expect(calls.proposals).toEqual([[ctx, { offset: 0 }]]);
    expect(calls.contextPr).toEqual([]);
    const table = screen.getByRole("table", { name: "Context PRs" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-proposal"))).toEqual([
      PROPOSAL_ID,
    ]);
    expect(
      within(rows[0] ?? table).getByRole("link", {
        name: "#519 on acme/core-platform",
      }),
    ).toHaveAttribute("href", `${BASE}/proposals/prs?proposal=${PROPOSAL_ID}`);
    expect(
      screen.queryByRole("region", { name: /^Context PR for/ }),
    ).toBeNull();
  });

  it("reads the Context PR of the proposal the URL selects, marks its row and renders its panel", async () => {
    const calls = await renderSteering(
      `/proposals/prs?proposal=${PROPOSAL_ID}`,
    );
    expect(calls.contextPr).toEqual([[ctx, PROPOSAL_ID]]);
    expect(
      screen.getByRole("link", { name: "#519 on acme/core-platform" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      section("Context PR for ctx.release.no-reread-changelog"),
    ).toHaveAttribute("data-status", "checks_passed");
  });

  it("reads no Context PR for a malformed proposal id (negative)", async () => {
    const calls = await renderSteering("/proposals/prs?proposal=prp_1;drop");
    expect(calls.contextPr).toEqual([]);
  });

  it("says no proposal on the page has a pull request", async () => {
    await renderSteering("/proposals/prs", {
      proposals: readOk({
        proposals: [proposal({ status: "proposed", pr: null })],
        total: 1,
      }),
    });
    expect(section("Context PRs")).toHaveTextContent(
      "No proposal on this page has a Context PR.",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders an error read in place of the table", async () => {
    await renderSteering("/proposals/prs", { proposals: DOWN });
    expect(section("Context PRs")).toHaveTextContent(
      "Context PRs could not be loaded: record_index_unavailable.",
    );
  });
});

describe("Assignments, the delivery report", () => {
  it("reads only delivery counts and distinguishes missing manifests from zero delivery", async () => {
    const calls = await renderSteering("/assignments");
    expect(calls.deliveries).toEqual([[ctx]]);
    expect(calls.records).toEqual([[ctx, { kind: null, offset: 0 }]]);
    expect(
      screen.getByText(/No steering manifests were recorded/),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Assignments" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("renders counts per run and names records cut from the bounded sample", async () => {
    await renderSteering("/assignments", {
      deliveries: readOk({
        runs: [
          {
            sessionUuid: "10000000-0000-4000-8000-000000000001",
            ts: "2026-09-22 12:00:00.000",
            harness: "codex",
            agentKey: "review",
            recordsIncluded: 14,
            recordsCut: 3,
            recordsCutForBudget: 2,
            budgetTokens: 4096,
            spentTokens: 3200,
          },
        ],
        undelivered: [
          {
            recordRef: "ctx.release",
            runs: 9,
            lastReason: "budget",
            lastSeen: "2026-09-22 12:00:00.000",
          },
        ],
        scanned: 2000,
        truncated: true,
      }),
    });
    const table = screen.getByRole("table", { name: "Steering delivery" });
    expect(within(table).getByText("14")).toBeVisible();
    expect(within(table).getByText("3")).toBeVisible();
    expect(within(table).getByText("2")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("newest 2,000");
    expect(screen.getByText("ctx.release")).toBeVisible();
    expect(screen.getByText("Budget", { exact: true })).toBeVisible();
  });
  it.each([
    DENIED,
    DOWN,
    {
      ok: false,
      reason: "pending_approval",
      accessRequestId: "apr_wait",
    } as const,
  ])("preserves an unsuccessful delivery read", async (read) => {
    await renderSteering("/assignments", { deliveries: read });
    expect(
      document.querySelector(`[data-reason="${read.reason}"]`),
    ).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
