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
import { CREATE_EVENT, createRequestOf } from "@/shared/create";
import { IntlProvider } from "@/test/intl";
import {
  agentPage,
  contextPr,
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
vi.mock("@/server/session", () => ({
  getSession: vi.fn(),
  getAuthUser: vi.fn(() =>
    Promise.resolve({ name: "Marcus Bell", email: "marcus@acme.test" }),
  ),
}));
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
// jsdom has no layout, so it has no scrollIntoView; the tab strip calls it.
Element.prototype.scrollIntoView = vi.fn();

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Steering, traceInstant } = await import("./steering");
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
    // The All shelf reads the whole list at the contract's bound.
    expect(calls.records).toEqual([
      [ctx, { kind: null, offset: 0, limit: 200 }],
    ]);
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

  it("gives the gold to Merge pull request on a selected Context PR whose checks passed", async () => {
    await renderSteering(`/proposals/prs?proposal=${PROPOSAL_ID}`);
    const create = within(screen.getByTestId("hub-header")).getByRole(
      "button",
      { name: "Write a context record" },
    );
    expect(create.className).not.toMatch(/button-primary/);
    expect(
      screen.getByRole("button", { name: "Merge pull request" }).className,
    ).toMatch(/button-primary/);
    expect(
      document.querySelectorAll('[class*="bg-button-primary-bg"]'),
    ).toHaveLength(1);
  });

  it("keeps the gold in the header while the selected Context PR cannot merge (negative)", async () => {
    await renderSteering(`/proposals/prs?proposal=${PROPOSAL_ID}`, {
      contextPr: readOk(contextPr("checks_failed")),
    });
    expect(
      within(screen.getByTestId("hub-header")).getByRole("button", {
        name: "Write a context record",
      }).className,
    ).toMatch(/button-primary/);
    expect(
      document.querySelectorAll('[class*="bg-button-primary-bg"]'),
    ).toHaveLength(1);
  });

  it("gives the gold to the Skills shelf's Search view", async () => {
    await renderSteering("/skills/search");
    expect(
      screen.getByRole("button", { name: "Add a skill" }).className,
    ).not.toMatch(/button-primary/);
  });

  it("names the panel the selected tab controls, and moves focus along the tabs with the arrow keys", async () => {
    await renderSteering();
    const library = tab("Library");
    const panel = screen.getByRole("tabpanel", { name: /^Library/ });
    expect(library).toHaveAttribute("aria-controls", panel.id);
    expect(library).toHaveAttribute("tabindex", "0");
    expect(tab("Gates")).toHaveAttribute("tabindex", "-1");
    library.focus();
    fireEvent.keyDown(library, { key: "ArrowRight" });
    expect(tab("Assignments")).toHaveFocus();
    fireEvent.keyDown(tab("Assignments"), { key: "End" });
    expect(tab("Compiler")).toHaveFocus();
    fireEvent.keyDown(tab("Compiler"), { key: "ArrowRight" });
    expect(library).toHaveFocus();
    fireEvent.keyDown(library, { key: "ArrowLeft" });
    expect(tab("Compiler")).toHaveFocus();
  });

  it("follows a shelf chip on Space, as its button role promises", async () => {
    await renderSteering();
    const row = screen.getByRole("group", { name: "Library shelves" });
    const records = within(row).getByRole("button", { name: /^Records/ });
    const followed = vi.fn((event: Event) => {
      event.preventDefault();
    });
    records.addEventListener("click", followed);
    fireEvent.keyDown(records, { key: " " });
    expect(followed).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(records, { key: "a" });
    expect(followed).toHaveBeenCalledTimes(1);
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
      // Assignments draws its body only for a workspace with an enrolled agent.
      await renderSteering(path, { agents: readOk(agentPage()) });
      expect(tab(name)).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId(body)).toBeInTheDocument();
      expect(
        screen.queryByRole("group", { name: "Library shelves" }),
      ).toBeNull();
    },
  );

  it("names the agent the Compiler assembles for, and says what it waits on", async () => {
    await renderSteering("/compiler/release-manager", {
      agents: readOk(agentPage()),
    });
    expect(screen.getByTestId("tab-compiler")).toHaveAttribute(
      "data-agent",
      "release-manager",
    );
    const gap = screen.getByTestId("compiler-not-backed");
    expect(gap).toHaveTextContent(
      "Not recorded yet: one assembly for one agent and one prompt",
    );
    // assembleSteering behind a read contract (gaps.ts, `assembler`).
    expect(gap).toHaveTextContent("Tracked in #3879");
    expect(gap).toHaveAttribute("data-issue", "3879");
  });

  it.each(["ontology", "instructions"])(
    "names what the %s shelf waits on and draws no figure",
    async (shelf) => {
      const calls = await renderSteering(`/${shelf}`);
      const gap = screen.getByTestId(`${shelf}-not-backed`);
      expect(gap).toHaveTextContent("Not recorded yet:");
      expect(gap).toHaveAttribute("data-issue", "3830");
      expect(calls.proposals).toEqual([]);
    },
  );

  it("reads the memories on the Memory shelf and says nothing has been recalled, with no gold in the header", async () => {
    const calls = await renderSteering("/memory");
    // list_memories is backed (steering-memory.md): the hub reads it, because
    // its empty state takes the gold from the header.
    expect(calls.memories).toEqual([[ctx, { limit: 200 }]]);
    expect(calls.proposals).toEqual([]);
    expect(section("Nothing has been recalled yet")).toHaveTextContent(
      "No run in this workspace has written one, so nothing competes from here.",
    );
    expect(
      within(screen.getByTestId("hub-header")).queryByRole("button", {
        name: "Write a context record",
      }),
    ).toBeNull();
  });

  it("reads memories on no other shelf (negative)", async () => {
    const calls = await renderSteering("/records");
    expect(calls.memories).toEqual([]);
  });

  it("names the main repository in the Ontology shelf's lead note", async () => {
    await renderSteering("/ontology");
    expect(screen.getByTestId("ontology-lead")).toHaveTextContent(
      "under .oxagen/ontology/ on acme/platform",
    );
  });

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

  it("keeps the skill a source address names, above the Skills catalog", async () => {
    await renderSteering("/skills/a-intel.release-notes/source");
    expect(screen.getByTestId("skill-source")).toHaveTextContent(
      "The source of a-intel.release-notes opens here when the skill source page ships.",
    );
    expect(screen.getByTestId("skills-tab")).toBeInTheDocument();
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
    // The item leads with the label (the title stands in until the record
    // declares one), then the statement, then the slug (ADR-174).
    expect(must?.querySelector('[data-term="label"]')).toHaveTextContent(
      /^Read CHANGELOG.md once per run$/,
    );
    expect(must?.querySelector('[data-term="statement"]')).toHaveTextContent(
      /^A must record.$/,
    );
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

  it("says steering and gating are two planes, and names the issue the other shelves wait on on the values it leaves out", async () => {
    await renderSteering();
    expect(
      screen.getByText(/Steering is what the model reads/),
    ).toHaveTextContent(
      "advisory, ranked, budgeted, and it may be dropped. Gating is what gets refused: deterministic, never budgeted, never ranked.",
    );
    // The design's footer holds no gap paragraph; the tooltips carry the issue.
    expect(screen.queryByTestId("library-gap")).toBeNull();
    expect(screen.getByTestId("tile-items")).toHaveAttribute(
      "title",
      expect.stringMatching(
        /^Only records are read into this list today\..*tracked in #3830\.$/,
      ),
    );
    expect(screen.getByTestId("tile-compiled-size")).toHaveAttribute(
      "title",
      expect.stringContaining("#3830"),
    );
    expect(screen.getByTestId("tile-grants")).toHaveAttribute(
      "title",
      expect.stringContaining("#3830"),
    );
  });

  describe("the list tools", () => {
    // Twelve records over two reads, newest first as list_records answers:
    // the one `must` sits on the second read, and the assembler puts it first.
    const force = (i: number) =>
      i === 11 ? "must" : i % 2 ? "should" : "info";
    const record = (i: number) =>
      publishedRecord({
        id: `ctr_r${String(i).padStart(2, "0")}`,
        lineage: `ctx.r${String(i).padStart(2, "0")}`,
        force: force(i),
        sharingScope: i % 3 === 0 ? "repository" : "workspace",
        statement: `Record ${String(i)}.`,
      });
    const twelve = (q: { offset: number }) =>
      readOk({
        records: Array.from({ length: 12 }, (_, i) => record(i)).slice(
          q.offset,
          q.offset + 8,
        ),
        total: 12,
      });
    const lineages = () =>
      within(screen.getByRole("table", { name: "Everything written down" }))
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.getAttribute("data-lineage"));

    it("reads every page and orders the whole list, ten rows to a page", async () => {
      const calls = await renderSteering("/library", { records: twelve });
      expect(calls.records).toEqual([
        [ctx, { kind: null, offset: 0, limit: 200 }],
        [ctx, { kind: null, offset: 8, limit: 200 }],
      ]);
      expect(lineages()).toHaveLength(10);
      expect(lineages()[0]).toBe("ctx.r11");
      const pager = screen.getByRole("navigation", { name: "Pages" });
      expect(pager).toHaveTextContent("1–10 of 12");
      fireEvent.click(within(pager).getByRole("button", { name: "Page 2" }));
      expect(pager).toHaveTextContent("11–12 of 12");
      expect(lineages()).toHaveLength(2);
      expect(
        within(pager).getByRole("button", { name: "Next page" }),
      ).toBeDisabled();
    });

    it("marks the repository a repository-scoped record names as not recorded, naming the issue", async () => {
      await renderSteering("/library", { records: twelve });
      const row = (lineage: string) =>
        screen
          .getAllByRole("row")
          .find((r) => r.getAttribute("data-lineage") === lineage);
      const scoped = row("ctx.r00")?.querySelector(
        '[data-scope-target="not-recorded"]',
      );
      expect(scoped).toHaveTextContent("not recorded");
      expect(scoped).toHaveAttribute(
        "title",
        "list_records carries no repository for a record, so the repository this record names is not recorded. Tracked in #3830.",
      );
      // Workspace scope names nothing further, so it carries no sub-line.
      expect(row("ctx.r01")?.querySelector("[data-scope-target]")).toBeNull();
    });

    it("gives every pager button a phone-sized touch target", async () => {
      await renderSteering("/library", { records: twelve });
      const pager = screen.getByRole("navigation", { name: "Pages" });
      const buttons = within(pager).getAllByRole("button");
      expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
        "Previous page",
        "Page 1",
        "Page 2",
        "Next page",
      ]);
      for (const button of buttons) {
        expect(button).toHaveAttribute("data-touch-target", "");
      }
    });

    it("searches, filters by Scope, Compiles to and Force, and changes the rows per page", async () => {
      await renderSteering("/library", { records: twelve });
      expect(
        screen.getByRole("searchbox", { name: "Search this list" }),
      ).toBeVisible();
      expect(
        screen
          .getAllByRole("combobox")
          .map((select) => select.getAttribute("aria-label")),
      ).toEqual([
        "Filter by Scope",
        "Filter by Compiles to",
        "Filter by Force",
        "Rows",
      ]);
      fireEvent.change(
        screen.getByRole("combobox", { name: "Filter by Force" }),
        { target: { value: "must" } },
      );
      expect(lineages()).toEqual(["ctx.r11"]);
      fireEvent.change(
        screen.getByRole("combobox", { name: "Filter by Force" }),
        { target: { value: "" } },
      );
      fireEvent.change(
        screen.getByRole("searchbox", { name: "Search this list" }),
        { target: { value: "Record 7." } },
      );
      expect(lineages()).toEqual(["ctx.r07"]);
      fireEvent.change(
        screen.getByRole("searchbox", { name: "Search this list" }),
        { target: { value: "nothing like it" } },
      );
      expect(screen.getByText("No rows match.")).toBeVisible();
      fireEvent.change(
        screen.getByRole("searchbox", { name: "Search this list" }),
        { target: { value: "" } },
      );
      fireEvent.change(screen.getByRole("combobox", { name: "Rows" }), {
        target: { value: "0" },
      });
      expect(lineages()).toHaveLength(12);
    });

    it("sorts on a header press, reverses on the second and gives the assembler's order back on the third", async () => {
      await renderSteering("/library", { records: twelve });
      const item = screen.getByRole("button", { name: "Item" });
      fireEvent.click(item);
      expect(item.closest("th")).toHaveAttribute("aria-sort", "ascending");
      expect(lineages()[0]).toBe("ctx.r00");
      fireEvent.click(item);
      expect(item.closest("th")).toHaveAttribute("aria-sort", "descending");
      expect(lineages()[0]).toBe("ctx.r11");
      fireEvent.click(item);
      expect(item.closest("th")).toHaveAttribute("aria-sort", "none");
      expect(lineages()[0]).toBe("ctx.r11");
    });

    it("fails the shelf when a later read fails, rather than showing part of the list (negative)", async () => {
      await renderSteering("/library", {
        records: (q) => (q.offset === 0 ? twelve(q) : DOWN),
      });
      expect(section("Steering could not be loaded")).toBeInTheDocument();
    });
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
    // The design prints the instant in UTC: `2026-09-11 09:16:04Z`.
    expect(screen.getByTestId("steering-trace")).toHaveTextContent(
      /^503 record_index_unavailable · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
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
      "Signed in asMarcus Bell · workspace.member · core-platform",
    );
    // The name is set in sans; the role and workspace are identifiers, in mono.
    const signedIn = screen.getByTestId("steering-signed-in");
    expect(signedIn).not.toHaveClass("font-mono");
    expect(signedIn.querySelector('[data-signed-in="name"]')).toHaveClass(
      "font-sans",
    );
    expect(signedIn.querySelector('[data-signed-in="name"]')).toHaveTextContent(
      /^Marcus Bell$/,
    );
    expect(signedIn.querySelector('[data-signed-in="role"]')).toHaveClass(
      "font-mono",
    );
    expect(signedIn.querySelector('[data-signed-in="role"]')).toHaveTextContent(
      /^workspace\.member · core-platform$/,
    );
    expect(denied).toHaveTextContent("Neededsteering.read on core-platform");
    // The refusal does not carry the policy that decided it yet (#3846).
    expect(denied).toHaveTextContent(
      "Decided bypolicy not recorded (#3846) · deny wins over every allow",
    );
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
    // Every bone is the design's shimmer, as on every other page, and none pulses.
    expect(loading.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(loading.querySelector(".animate-pulse")).toBeNull();
  });
});

describe("Records", () => {
  it("prints each record's statement, classification, scope, lineage, commit and publication", async () => {
    await renderSteering("/records");
    const card = within(section("Published records")).getByRole("article");
    expect(card).toHaveAttribute("data-kind", "constraint");
    expect(card).toHaveTextContent(
      "Do not re-read CHANGELOG.md after the first read in a run.",
    );
    // The force badge carries the force alone (steering-records.md, the card).
    expect(card.querySelector('[data-term="force"]')).toHaveTextContent(
      /^must$/,
    );
    expect(
      card.querySelector('[data-term="constraint-effect"]'),
    ).toHaveTextContent("forbid");
    expect(card.querySelector('[data-term="scope"]')).toHaveTextContent(
      "workspace",
    );
    // The meta line: scope, the effect line, the lineage, the commit and the
    // publication date.
    expect(card.querySelector('[data-term="lineage"]')).toHaveTextContent(
      "ctx.release.no-reread-changelog",
    );
    expect(card.querySelector('[data-term="commit"]')).toHaveTextContent(
      "4d5e6f7",
    );
    expect(card.querySelector('[data-term="published"]')).toHaveTextContent(
      "2026-09-12",
    );
    expect(card.querySelector('[data-term="state"]')).toHaveTextContent(
      "published",
    );
    expect(
      within(card).getByRole("link", {
        name: "Open ctx.release.no-reread-changelog",
      }),
    ).toBeVisible();
  });

  it("offers Clone on each card, which opens the clone editor on that record's slug", async () => {
    const receive = vi.fn((event: Event) => createRequestOf(event));
    window.addEventListener(CREATE_EVENT, receive);
    try {
      await renderSteering("/records");
      const card = within(section("Published records")).getByRole("article");
      fireEvent.click(
        within(card).getByRole("button", {
          name: "Clone ctx.release.no-reread-changelog",
        }),
      );
      expect(receive).toHaveReturnedWith({
        kind: "record",
        cloneSourceRef: "ctx.release.no-reread-changelog",
      });
    } finally {
      window.removeEventListener(CREATE_EVENT, receive);
    }
  });

  it("leads a card with the record's label and prints its statement under it (ADR-174)", async () => {
    await renderSteering("/records", {
      records: readOk({
        records: [publishedRecord({ label: "Read the changelog once" })],
        total: 1,
      }),
    });
    const card = within(section("Published records")).getByRole("article");
    expect(card.querySelector('[data-term="label"]')).toHaveTextContent(
      /^Read the changelog once$/,
    );
    expect(card.querySelector('[data-term="statement"]')).toHaveTextContent(
      /^Do not re-read CHANGELOG.md after the first read in a run.$/,
    );
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
    expect(card.querySelector('[data-term="label"]')).toHaveTextContent(
      /^Read CHANGELOG.md once per run$/,
    );
    expect(card.querySelector('[data-term="statement"]')).toBeNull();
    expect(card.querySelector('[data-term="force"]')).toBeNull();
    expect(card.querySelector('[data-term="tokens"]')).toBeNull();
    expect(card.querySelector('[data-term="commit"]')).toBeNull();
    expect(card.querySelector('[data-term="published"]')).toBeNull();
  });

  it("chips every kind with its count, presses the one the URL asks for and reads the whole list once", async () => {
    const calls = await renderSteering("/records?kind=rule");
    // The hub counts every kind; the shelf reads every record in force at the
    // contract's bound and filters by kind in the browser.
    expect(calls.records).toEqual([
      [ctx, { kind: null, offset: 0 }],
      [ctx, { kind: null, offset: 0, limit: 200 }],
    ]);
    const filter = screen.getByRole("group", {
      name: "Filter records by kind",
    });
    const chips = within(filter).getAllByRole("button");
    expect(
      chips.map((chip) => [
        chip.getAttribute("href"),
        chip.getAttribute("aria-pressed"),
      ]),
    ).toEqual([
      [`${BASE}/records`, "false"],
      [`${BASE}/records?kind=rule`, "true"],
      [`${BASE}/records?kind=constraint`, "false"],
      [`${BASE}/records?kind=procedure`, "false"],
      [`${BASE}/records?kind=fact`, "false"],
      [`${BASE}/records?kind=memory`, "false"],
      [`${BASE}/records?kind=preference`, "false"],
    ]);
    expect(
      within(filter).getByRole("button", { name: /^constraint/ }),
    ).toHaveTextContent("constraint1");
  });

  it("says no record of a kind is in force and keeps the filter", async () => {
    await renderSteering("/records?kind=procedure");
    const records = section("Published records");
    expect(records).toHaveTextContent(
      "No record of that kind is in force in this workspace.",
    );
    expect(
      within(records).getByRole("group", {
        name: "Filter records by kind",
      }),
    ).toBeInTheDocument();
  });

  it("pages ten to a page with the range, keeping the kind", async () => {
    await renderSteering("/records?kind=constraint", {
      records: readOk({
        records: Array.from({ length: 12 }, (_, i) =>
          publishedRecord({ id: `ctr_r${String(i)}` }),
        ),
        total: 12,
      }),
    });
    const pager = screen.getByRole("navigation", { name: "Pages" });
    expect(pager).toHaveTextContent("1–10 of 12");
    expect(
      within(section("Published records")).getAllByRole("article"),
    ).toHaveLength(10);
    fireEvent.click(within(pager).getByRole("button", { name: "Next page" }));
    expect(pager).toHaveTextContent("11–12 of 12");
    expect(
      within(section("Published records")).getAllByRole("article"),
    ).toHaveLength(2);
    expect(
      within(
        screen.getByRole("group", { name: "Filter records by kind" }),
      ).getByRole("button", { pressed: true }),
    ).toHaveAttribute("href", `${BASE}/records?kind=constraint`);
  });

  it("offers no other page when one page holds every record (negative)", async () => {
    await renderSteering("/records");
    const pager = screen.getByRole("navigation", { name: "Pages" });
    expect(pager).toHaveTextContent("1–1 of 1");
    expect(
      within(pager).getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(
      within(pager).getByRole("button", { name: "Next page" }),
    ).toBeDisabled();
  });
});

describe("Proposals", () => {
  it("reads one page of proposals and nothing else, and prints each with its state, tally, source, rationale and support", async () => {
    const calls = await renderSteering("/proposals");
    // The hub asks for the same first page to decide whether the empty state
    // takes the gold (tab-primary.ts); the kernel's per-request read table
    // answers the body's ask without a second invoke (server/kernel.ts).
    expect(calls).toEqual({
      record: [],
      records: [[ctx, { kind: null, offset: 0 }]],
      proposals: [
        [ctx, { offset: 0 }],
        [ctx, { offset: 0 }],
      ],
      contextPr: [],
      freshness: [],
      deliveries: [],
      hub: [[ctx]],
      memories: [],
      tree: [],
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
    // The hub's gold check and the body ask for the same page; the kernel's
    // per-request read table serves the second (tab-primary.ts).
    expect(calls.proposals).toEqual([
      [ctx, { offset: 0 }],
      [ctx, { offset: 0 }],
    ]);
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
  // The body, delivery report included, is drawn for a workspace with an
  // enrolled agent; with none, the tab is its empty state.
  const agents = readOk(agentPage());

  it("says no agent receives steering when none is enrolled, and reads no delivery (negative)", async () => {
    const calls = await renderSteering("/assignments");
    expect(section("No agent receives steering here")).toHaveTextContent(
      "No agent in this workspace is enrolled, so nothing is delivered.",
    );
    expect(
      screen.queryByRole("table", { name: "Steering delivery" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Open Agents" })).toHaveAttribute(
      "href",
      "/acme/core-platform/agents",
    );
    expect(calls.proposals).toEqual([]);
  });

  it("reads only delivery counts and distinguishes missing manifests from zero delivery", async () => {
    const calls = await renderSteering("/assignments", { agents });
    expect(calls.deliveries).toEqual([[ctx]]);
    // The hub's count, then the whole list for the Scope panel.
    expect(calls.records).toEqual([
      [ctx, { kind: null, offset: 0 }],
      [ctx, { kind: null, offset: 0, limit: 200 }],
    ]);
    expect(
      screen.getByText(/No steering manifests were recorded/),
    ).toBeVisible();
    // The tab carries the enrolled count beside its name.
    expect(tab("Assignments")).toHaveAttribute("aria-selected", "true");
    expect(tab("Assignments")).toHaveTextContent(/^Assignments1$/);
  });
  it("renders counts per run and names records cut from the bounded sample", async () => {
    await renderSteering("/assignments", {
      agents,
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
    await renderSteering("/assignments", { agents, deliveries: read });
    expect(
      document.querySelector(`[data-reason="${read.reason}"]`),
    ).toBeVisible();
    // The agents and Scope tables stand; only the report is replaced.
    expect(
      screen.queryByRole("table", { name: "Steering delivery" }),
    ).toBeNull();
  });
});

describe("traceInstant", () => {
  it("prints the instant in UTC as the design does", () => {
    expect(traceInstant("2026-09-11T09:16:04.512Z")).toBe(
      "2026-09-11 09:16:04Z",
    );
    expect(traceInstant("2026-09-11T11:16:04+02:00")).toBe(
      "2026-09-11 09:16:04Z",
    );
  });

  it("returns an unreadable instant as it came rather than an invalid date", () => {
    expect(traceInstant("not a time")).toBe("not a time");
  });
});
