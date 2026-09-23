// @vitest-environment jsdom
// The Agents page over a fake DataSource (mockups/pages/agents.md): the tiles,
// the Columns toggle and both column sets, the list controls, the row actions,
// the row click, and the empty, loading, error, denied and pending states, with
// an axe check in every one. A column no store backs prints the not-recorded
// words, and a trust word is only the one the record holds.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { phoneWidth } from "@/test/phone";
import { buttonDanger, buttonPrimary } from "@/ui/control-styles";
import { agentPage, agentRow, agentsSource } from "./agents.builders";

const push = vi.fn();
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  retireAgent: vi.fn(),
  rotateAgentCredential: vi.fn(),
  setAgentSuspended: vi.fn(),
  readAssignableRoles: vi.fn(() => new Promise(() => {})),
  readAgentRoleNames: vi.fn(() => new Promise(() => {})),
  assignAgentRole: vi.fn(),
  revokeAgentRole: vi.fn(),
  registerAgent: vi.fn(),
}));
// The wizard's folder is its own lane; the header needs only its two lists.
vi.mock("@/features/create", () => ({
  AGENT_HARNESSES: ["claude-code", "codex", "cursor", "stella"],
  MODEL_TIERS: ["complex", "light"],
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Agents, AgentsLoading } = await import("./agents");
const { AgentsCreate } = await import("./create-actions");

const t = translator("agents.list");

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

const HEADER = <h1>Agents</h1>;

async function renderAgents(
  reads: Parameters<typeof agentsSource>[0],
  cursor: string | null = null,
  container?: HTMLElement,
) {
  const { source, calls } = agentsSource(reads);
  const element = await Agents({
    ctx,
    source,
    cursor,
    header: HEADER,
    viewerName: "Marcus Bell",
  });
  render(
    <IntlProvider>{element}</IntlProvider>,
    container === undefined ? undefined : { container },
  );
  return calls;
}

const tiles = () => screen.queryAllByTestId("tile");
const table = () =>
  screen.getByRole("table", { name: "Agents registered in Core platform" });
const headers = () =>
  within(table())
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
const rows = () => screen.queryAllByTestId("agent-row");
const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
const operations = () =>
  fireEvent.click(screen.getByRole("button", { name: "Operations" }));
const only = (list: HTMLElement[]): HTMLElement => {
  const [first] = list;
  if (first === undefined) throw new Error("no row");
  return first;
};

const COMPOSITION = [
  "Agent",
  "Purpose",
  "Owner",
  "Steering",
  "Toolbelt",
  "Runtime",
  "Principal",
  "Health",
  "Activity",
  // The action column's header is empty, as the design draws it; its name is
  // on aria-label (see the phone-width test).
  "",
];
const OPERATIONS = [
  "Agent",
  "Harness",
  "Operator",
  "Status",
  "Tier",
  "Belt",
  "Runs 30d",
  "Spend 30d",
  "Tokens 30d",
  "Mandates",
  "Incidents",
  "",
];

beforeEach(() => {
  push.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Agents, loaded", () => {
  it("reads one agents page at the URL's cursor and draws the header it is handed", async () => {
    const calls = await renderAgents({ list: agentPage([agentRow()]) }, "c1");
    expect(calls.list).toEqual([[ctx, { cursor: "c1" }]]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Agents",
    );
  });

  it("draws four tiles, each one number and one basis line from the workspace totals", async () => {
    await renderAgents({
      list: agentPage(
        [
          agentRow({ mandates: 2 }),
          agentRow({ id: "agt_b", slug: "b", agentKey: "acme.core.b" }),
        ],
        null,
        { identities: 7, enrolled: 2, holdingMandate: 1, tamperIncidents: 3 },
      ),
    });
    expect(tiles().map((tile) => tile.textContent)).toEqual([
      // "Listed below" counts the rows this read returned, not the total.
      "Agents here7organization count not recorded · 2 listed below",
      "Enrolled25 not yet enrolled",
      "Holding a mandate1acme.core.release-bot · in Core platform · counted in Core platform only",
      // Every tamper incident the store keeps on the agents' hosts, and the
      // newest as <scope> · <kind>, <date> with how many are open.
      "Tamper incidents4acme.core.release-bot · hooks_removed, 2026-09-11 · 3 open · counted in Core platform only",
    ]);
    expect(tiles()[3]?.querySelector("[data-critical]")).not.toBeNull();
    // The design scopes the last two to the organization; the read answers
    // for the workspace and says so in the visible basis line, with the
    // fuller reason on hover.
    expect(
      [...document.querySelectorAll('[data-scope="workspace"]')].map((el) =>
        el.getAttribute("title"),
      ),
    ).toEqual([
      "Counted over the agents in Core platform. No organization-wide rollup is recorded yet.",
      "Summed over the agents in Core platform. No organization-wide rollup is recorded yet.",
    ]);
  });

  it("says the rest are on harness when they are, and says when nobody holds a mandate or no incident was recorded", async () => {
    await renderAgents({
      list: agentPage(
        [
          agentRow({ enforcementTier: "observe" }),
          agentRow({ id: "agt_b", slug: "b", enforcementTier: "harness" }),
        ],
        null,
        {
          identities: 2,
          enrolled: 2,
          holdingMandate: 0,
          tamperIncidents: 0,
          tamper: { recorded: 0, open: 0, newest: null },
        },
      ),
    });
    expect(tiles().map((tile) => tile.textContent)).toEqual([
      "Agents here2organization count not recorded · 2 listed below",
      "Enrolled21 listed here on the observe tier, the rest on harness",
      "Holding a mandate0no agent in Core platform holds one",
      "Tamper incidents0none in the retention window in Core platform",
    ]);
    expect(tiles()[3]?.querySelector("[data-critical]")).toBeNull();
  });

  it("counts each recorded tier on Enrolled when not every other agent is on harness, and says all resolved when none is open", async () => {
    await renderAgents({
      list: agentPage(
        [
          agentRow({ enforcementTier: "observe" }),
          agentRow({ id: "agt_b", slug: "b", enforcementTier: "harness" }),
          agentRow({ id: "agt_c", slug: "c", enforcementTier: null }),
        ],
        null,
        {
          identities: 3,
          enrolled: 3,
          tamper: {
            recorded: 2,
            open: 0,
            newest: {
              agentKey: "acme.core.c",
              kind: "chain_break",
              detectedAt: "2026-09-02T23:59:00.000Z",
            },
          },
        },
      ),
    });
    expect(tiles()[1]?.textContent).toBe(
      "Enrolled31 listed here on the observe tier, 1 on harness, 1 on another tier or none recorded",
    );
    expect(tiles()[3]?.textContent).toBe(
      "Tamper incidents2acme.core.c · chain_break, 2026-09-02 · all resolved · counted in Core platform only",
    );
  });

  it("names every holder among the rows, as the design does, with no count of the rest", async () => {
    await renderAgents({
      list: agentPage(
        [
          agentRow({ mandates: 1 }),
          agentRow({
            id: "agt_b",
            slug: "b",
            agentKey: "acme.core.b",
            mandates: 2,
          }),
          agentRow({
            id: "agt_c",
            slug: "c",
            agentKey: "acme.core.c",
            mandates: 0,
          }),
          agentRow({
            id: "agt_d",
            slug: "d",
            agentKey: "acme.core.d",
            mandates: 1,
          }),
          agentRow({
            id: "agt_e",
            slug: "e",
            agentKey: "acme.core.e",
            mandates: 1,
          }),
        ],
        null,
        { holdingMandate: 4 },
      ),
    });
    expect(tiles()[2]?.textContent).toBe(
      "Holding a mandate4acme.core.release-bot · in Core platform, acme.core.b · in Core platform, acme.core.d · in Core platform, acme.core.e · in Core platform · counted in Core platform only",
    );
    expect(tiles()[2]?.textContent).not.toContain("more in");
  });

  it("prints the mandate tile as not recorded when the read carries no count (negative)", async () => {
    await renderAgents({
      list: agentPage([agentRow()], null, { holdingMandate: null }),
    });
    expect(tiles()[2]?.textContent).toBe(
      "Holding a mandatenot recordednot recorded",
    );
  });

  it("opens on Composition, with the Columns group, its subtext, the source line and the footer note", async () => {
    await renderAgents({ list: agentPage([agentRow()]) });
    const group = screen.getByRole("group", { name: "Columns" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Composition",
      "Operations",
    ]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
    ]);
    expect(
      screen.getByRole("heading", { name: "Registered in Core platform" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Each row names the reusable objects this agent holds a reference to.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/^\.oxagen\/agents\/ @/)).toHaveTextContent(
      ".oxagen/agents/ @ not recorded",
    );
    expect(headers()).toEqual(COMPOSITION);
    expect(
      screen.getByText(
        "An agent has one principal and runs on one runtime. Its steering, its toolbelts and its tools are workspace objects it refers to, so changing one changes every agent that refers to it.",
      ),
    ).toBeInTheDocument();
  });

  it("draws a Composition row from the record, and the unbacked columns as not recorded", async () => {
    await renderAgents({ list: agentPage([agentRow()]) });
    expect(cellsOf(only(rows()))).toEqual([
      "reacme.core.release-botClaude Code",
      "Cuts releases and opens their pull requests.",
      "MBMarcus Bell",
      "not recorded",
      "not recorded",
      // The host over "<kind> · <tier>": no store records the kind.
      "build-01not recorded · gateway",
      "prn_91",
      "healthyenrolled, and its latest wrapped session recorded the gateway tier",
      "42runs 30d",
      "EditRolesDeregister",
    ]);
    // Each unbacked cell names the store it is waiting for.
    const gaps = [...only(rows()).querySelectorAll("[data-gap]")].map((el) => [
      el.getAttribute("data-gap"),
      el.getAttribute("title"),
    ]);
    expect(gaps).toEqual([
      [
        "steering",
        "No store records the steering assembled for each agent yet.",
      ],
      [
        "toolbelt",
        "No store records toolbelts or their assignments to agents yet.",
      ],
      [
        "runtimeKind",
        "No store records a runtime's kind yet. A host row is one enrollment, not a machine.",
      ],
    ]);
  });

  it("reads Health in the spec's order and never says healthy without a recorded tier", async () => {
    await renderAgents({
      list: agentPage([
        agentRow({ id: "agt_a", slug: "a", tamperIncidents: 2 }),
        agentRow({
          id: "agt_b",
          slug: "b",
          status: "unenrolled",
          principalId: null,
          host: null,
          enforcementTier: null,
        }),
        agentRow({ id: "agt_c", slug: "c", enforcementTier: "observe" }),
        agentRow({ id: "agt_d", slug: "d", enforcementTier: "contained" }),
        agentRow({ id: "agt_e", slug: "e", enforcementTier: null }),
      ]),
    });
    expect(rows().map((row) => cellsOf(row)[7])).toEqual([
      "tamper2 open incidents",
      "not enrolledno hook is installed, so its runs are recorded only",
      "observeenrolled, and nothing is delivered or refused yet",
      "healthyenrolled, and its latest wrapped session recorded the contained tier",
      "not recorded",
    ]);
    const pending = rows()[1];
    if (pending === undefined) throw new Error("no row");
    expect(cellsOf(pending)[5]).toBe("—not recorded · not recorded");
    expect(cellsOf(pending)[6]).toBe("prn_pending");
  });

  it("switches to Operations over the same agents, with its subtext and columns", async () => {
    await renderAgents({
      list: agentPage([
        agentRow({
          mandates: 2,
          tamperIncidents: 1,
          tamperIncidentsRecorded: 3,
        }),
        agentRow({
          id: "agt_b",
          slug: "b",
          agentKey: "acme.core.b",
          spend30d: null,
          tokens30d: null,
          mandates: 0,
          enforcementTier: null,
        }),
      ]),
    });
    const before = rows().map((row) => row.dataset.agent);
    operations();
    expect(screen.getByRole("button", { name: "Operations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByText(
        "Each row is what this agent did and what it cost over the last 30 days.",
      ),
    ).toBeInTheDocument();
    expect(headers()).toEqual(OPERATIONS);
    expect(rows().map((row) => row.dataset.agent)).toEqual(before);
    const [first, second] = rows();
    if (first === undefined || second === undefined) throw new Error("rows");
    expect(cellsOf(first)).toEqual([
      "reacme.core.release-botCuts releases and opens their pull requests.",
      "Claude Codeclaude-code",
      "MBMarcus Bell",
      "enrolled",
      "gateway",
      "not recorded",
      "42",
      // Spend names who observed it and that it is the wrapped sessions'.
      "$12.50client attested · wrapped sessions",
      "1,840,00062% cached · wrapped sessions",
      "2",
      // Every tamper incident recorded on its hosts, open or resolved.
      "3",
      "EditRolesDeregister",
    ]);
    expect(
      [...first.querySelectorAll("[data-basis]")].map((el) => [
        el.getAttribute("data-basis"),
        el.getAttribute("title"),
      ]),
    ).toEqual([
      [
        "wrapped_sessions",
        "Priced wrapped sessions in the last 30 days. Ledger runs and unpriced sessions are not in this figure.",
      ],
      [
        "wrapped_sessions",
        "40 wrapped sessions, as the harness reported them. Ledger runs' tokens are not in this total.",
      ],
    ]);
    expect(first.querySelector('[data-gap="belt"]')).toHaveAttribute(
      "title",
      "list_agents does not compute each agent's belt yet (#3852). The agent's own page shows the belt its grants give it.",
    );
    expect(cellsOf(second).slice(4, 11)).toEqual([
      "not recorded",
      "not recorded",
      "42",
      "not recorded",
      "not recorded",
      "—",
      "0",
    ]);
  });

  it("links Edit to the definition tab, opens the role dialog from Roles, and draws Deregister as the danger action", async () => {
    await renderAgents({ list: agentPage([agentRow()]) });
    const row = only(rows());
    expect(within(row).getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/definition",
    );
    expect(
      within(row).getByRole("button", { name: "Deregister" }).className,
    ).toBe(buttonDanger);
    fireEvent.click(within(row).getByRole("button", { name: "Roles" }));
    expect(await screen.findByTestId("assign-role")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("offers no role or deregister action on a retired agent (negative)", async () => {
    await renderAgents({ list: agentPage([agentRow({ status: "retired" })]) });
    expect(cellsOf(only(rows())).at(-1)).toBe("Edit");
  });

  it("opens the agent when a row is clicked anywhere but its actions", async () => {
    await renderAgents({ list: agentPage([agentRow()]) });
    fireEvent.click(
      within(only(rows())).getByText(
        "Cuts releases and opens their pull requests.",
      ),
    );
    expect(push).toHaveBeenCalledWith("/acme/core-platform/agents/release-bot");
  });
});

describe("Agents list controls", () => {
  const many = () =>
    agentPage(
      Array.from({ length: 12 }, (_, i) => {
        const n = String(i).padStart(2, "0");
        return agentRow({
          id: `agt_a${n}`,
          slug: `agent-${n}`,
          agentKey: `acme.core.agent-${n}`,
          runs30d: i,
          operatorName: i % 2 === 0 ? "Marcus Bell" : "Sana Moreau",
          status: i % 3 === 0 ? "unenrolled" : "enrolled",
        });
      }),
    );

  it("pages ten rows at a time with a range and numbered pages, and Rows changes the page size", async () => {
    await renderAgents({ list: many() });
    expect(rows()).toHaveLength(10);
    expect(screen.getByText("1–10 of 12")).toBeInTheDocument();
    const pager = screen.getByRole("navigation", { name: "Pages" });
    fireEvent.click(within(pager).getByRole("button", { name: "Page 2" }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByText("11–12 of 12")).toBeInTheDocument();
    const size = screen.getByRole("combobox", { name: "Rows" });
    expect(
      within(size)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["5", "10", "25", "50", "All"]);
    fireEvent.change(size, { target: { value: "0" } });
    expect(rows()).toHaveLength(12);
  });

  it("searches the rows and says when nothing matches, in a row of the table", async () => {
    await renderAgents({ list: many() });
    const search = screen.getByRole("searchbox", { name: "Search this list" });
    fireEvent.change(search, { target: { value: "agent-07" } });
    expect(rows().map((row) => row.dataset.agent)).toEqual(["agent-07"]);
    fireEvent.change(search, { target: { value: "nothing like it" } });
    expect(rows()).toHaveLength(0);
    const empty = screen.getByTestId("agents-no-match");
    expect(empty).toHaveTextContent("No rows match.");
    expect(empty.closest("tbody")).not.toBeNull();
    expect(empty.querySelector("td")).toHaveAttribute("colspan", "10");
  });

  it("sorts by a header and says so with aria-sort", async () => {
    await renderAgents({ list: many() });
    const header = () =>
      screen
        .getAllByRole("columnheader")
        .find((th) => th.textContent === "Activity");
    expect(header()).toHaveAttribute("aria-sort", "none");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Activity" }));
    expect(header()).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Activity" }));
    expect(header()).toHaveAttribute("aria-sort", "descending");
    expect(rows()[0]?.dataset.agent).toBe("agent-11");
    // Every header sorts, as the design's list controls do, the unbacked
    // ones included; only the action column does not.
    expect(
      screen
        .getAllByRole("columnheader")
        .map((th) => th.hasAttribute("aria-sort")),
    ).toEqual([true, true, true, true, true, true, true, true, true, false]);
  });

  it("sorts Operations by the token total, an agent with none recorded last", async () => {
    await renderAgents({
      list: agentPage([
        agentRow({ id: "agt_a", slug: "a", tokens30d: null }),
        agentRow({
          id: "agt_b",
          slug: "b",
          tokens30d: { total: 10, cacheReadRate: null, sessions: 1 },
        }),
        agentRow({ id: "agt_c", slug: "c" }),
      ]),
    });
    operations();
    fireEvent.click(screen.getByRole("button", { name: "Sort by Tokens 30d" }));
    expect(rows().map((row) => row.dataset.agent)).toEqual(["b", "c", "a"]);
    expect(cellsOf(only(rows()))[8]).toBe(
      "10cache rate not recorded · wrapped sessions",
    );
  });

  const facets = () =>
    screen
      .getAllByRole("combobox")
      .map((select) => select.getAttribute("aria-label"))
      .filter((label) => label !== null);

  it("derives its facets from the columns in view, status-like first, so they change with the column set", async () => {
    const TIERS = ["observe", "harness", "gateway"] as const;
    const HARNESSES = ["claude-code", "stella", "codex", "cursor"] as const;
    await renderAgents({
      list: agentPage(
        Array.from({ length: 12 }, (_, i) => {
          const n = String(i).padStart(2, "0");
          return agentRow({
            id: `agt_a${n}`,
            slug: `agent-${n}`,
            agentKey: `acme.core.agent-${n}`,
            operatorName: i % 2 === 0 ? "Marcus Bell" : "Sana Moreau",
            status: i % 3 === 0 ? "unenrolled" : "enrolled",
            enforcementTier: TIERS[i % 3] ?? null,
            harness: HARNESSES[i % 4] ?? "custom",
          });
        }),
      ),
    });
    // The design's ltFacets: a status-like column (Health) before Owner.
    expect(facets()).toEqual(["Filter by Health", "Filter by Owner"]);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter by Owner" }),
      { target: { value: "Sana Moreau" } },
    );
    expect(screen.getByText("1–6 of 6")).toBeInTheDocument();
    operations();
    // Status and Tier first, then the column with fewer values; three at
    // most, so Harness (four values) is cut and the Tier facet stays.
    expect(facets()).toEqual([
      "Filter by Status",
      "Filter by Tier",
      "Filter by Operator",
    ]);
    expect(
      within(screen.getByRole("combobox", { name: "Filter by Tier" }))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All · Tier", "gateway", "harness", "observe"]);
    // The Owner facet left the view, so it no longer filters.
    expect(screen.getByText("1–10 of 12")).toBeInTheDocument();
  });

  it("offers no facet on a list of fewer than four rows (negative)", async () => {
    await renderAgents({
      list: agentPage([
        agentRow({ id: "agt_a", slug: "a", operatorName: "Marcus Bell" }),
        agentRow({ id: "agt_b", slug: "b", operatorName: "Sana Moreau" }),
        agentRow({ id: "agt_c", slug: "c", status: "unenrolled" }),
      ]),
    });
    expect(facets()).toEqual([]);
  });

  it("links the agents beyond the read's page by its cursor", async () => {
    await renderAgents({ list: agentPage([agentRow()], "c2") }, "c1");
    const beyond = screen.getByRole("navigation", {
      name: "Agents beyond this page",
    });
    expect(
      within(beyond).getByRole("link", { name: "More agents" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents?cursor=c2");
    expect(
      within(beyond).getByRole("link", { name: "First agents" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents");
  });
});

describe("Agents header actions", () => {
  it("draws New agent, Register an agent and Wrap Claude Code in order, with Wrap the one gold action", () => {
    render(
      <IntlProvider>
        <AgentsCreate org="acme" ws="core-platform" />
      </IntlProvider>,
    );
    expect(
      [...document.querySelectorAll("button, a")].map((el) => el.textContent),
    ).toEqual(["New agent", "Register an agent", "Wrap Claude Code"]);
    const wrap = screen.getByRole("link", { name: "Wrap Claude Code" });
    expect(wrap).toHaveAttribute("href", "/acme/core-platform/register/name");
    expect(wrap.className).toBe(buttonPrimary);
    expect(
      [...document.querySelectorAll("button, a")].filter(
        (el) => el.className === buttonPrimary,
      ),
    ).toHaveLength(1);
  });
});

describe("Agents, not loaded", () => {
  it("draws the empty state with its copy and the two actions, and no header", async () => {
    await renderAgents({ list: agentPage([]) });
    const empty = screen.getByTestId("agents-empty");
    expect(
      within(empty).getByRole("heading", {
        name: "No agent registered in Core platform",
      }),
    ).toBeInTheDocument();
    expect(empty).toHaveTextContent(
      "An agent's identity lives in Postgres; its definition is a file in .oxagen/agents/ in the main repo. Registering one opens a Context PR — nothing is written to Postgres first.",
    );
    expect(
      [...empty.querySelectorAll("button, a")].map((el) => el.textContent),
    ).toEqual(["Wrap Claude Code", "Register an agent"]);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps a later page that came back empty as a table, not the empty state", async () => {
    await renderAgents({ list: agentPage([]) }, "c9");
    expect(screen.queryByTestId("agents-empty")).toBeNull();
    expect(table()).toBeInTheDocument();
  });

  it("names the code on error and offers Try again", async () => {
    await renderAgents({ list: readError("iam_principals_unavailable", 503) });
    const error = screen.getByTestId("agents-error");
    expect(
      within(error).getByRole("heading", { name: t("states.error.title") }),
    ).toBeInTheDocument();
    expect(error).toHaveTextContent(
      "The control plane answered 503 iam_principals_unavailable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    // trace · region · instant: the read carries only the instant.
    expect(screen.getByTestId("agents-trace").textContent).toMatch(
      /^trace not recorded · region not recorded · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
    );
    expect(
      [...error.querySelectorAll('[data-gap="trace"]')].map((el) =>
        el.getAttribute("title"),
      ),
    ).toEqual([
      "A failed read does not carry its trace id or region yet.",
      "A failed read does not carry its trace id or region yet.",
    ]);
    const retry = within(error).getByRole("button", { name: "Try again" });
    expect(retry.className).toBe(buttonPrimary);
    expect(
      [...error.querySelectorAll("button, a")].map((el) => el.textContent),
    ).toEqual(["Try again", "Open an incident"]);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    fireEvent.click(
      within(error).getByRole("button", { name: "Open an incident" }),
    );
    const incident = await screen.findByTestId("agents-incident-dialog");
    expect(
      within(incident).getByRole("heading", { name: "Open an incident" }),
    ).toBeInTheDocument();
    expect(incident).toHaveTextContent(
      "An incident would record this failure, the code 503 iam_principals_unavailable, and when it happened",
    );
    expect(incident.querySelector("[data-gap]")).toHaveAttribute(
      "data-gap",
      "#3847",
    );
  });

  it("names the missing permission when denied, with who is signed in and what decided it", async () => {
    await renderAgents({
      list: { ok: false, reason: "denied", permission: "agent.read" },
    });
    const denied = screen.getByTestId("agents-denied");
    expect(
      within(denied).getByRole("heading", {
        name: "You cannot see the agents in this workspace",
      }),
    ).toBeInTheDocument();
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include agent.read on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(
      within(denied)
        .getAllByRole("term")
        .map((dt) => dt.textContent),
    ).toEqual(["Signed in as", "Needed", "Decided by"]);
    expect(
      within(denied)
        .getAllByRole("definition")
        .map((dd) => dd.textContent),
    ).toEqual([
      "Marcus Bell · workspace.member · core-platform",
      "agent.read on core-platform",
      "policy not recorded · deny wins over every allow",
    ]);
    expect(denied.querySelector('[data-gap="policy"]')).toHaveAttribute(
      "title",
      "The read's refusal does not name the policy that decided it.",
    );
    expect(
      [...denied.querySelectorAll("button, a")].map((el) => el.textContent),
    ).toEqual(["Request access", "Back to Fleet"]);
    expect(
      within(denied).getByRole("button", { name: "Request access" }).className,
    ).toBe(buttonPrimary);
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    fireEvent.click(
      within(denied).getByRole("button", { name: "Request access" }),
    );
    const request = await screen.findByTestId("agents-request-access-dialog");
    expect(within(request).getByLabelText("Role requested")).toHaveValue(
      "agent.read on core-platform",
    );
    expect(request).toHaveTextContent(
      "No capability records a request yet, so ask an owner directly.",
    );
    expect(
      within(request).getByRole("link", { name: "Open Roles" }),
    ).toHaveAttribute("href", "/acme/roles");
    expect(request.querySelector("[data-gap]")).toHaveAttribute(
      "data-gap",
      "#3820",
    );
  });

  it("names the access request a parked read is waiting on", async () => {
    await renderAgents({
      list: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_12",
      },
    });
    expect(screen.getByTestId("agents-pending")).toHaveTextContent(
      "Access request acr_12",
    );
  });

  it("draws the loading skeleton with no figures", () => {
    render(
      <IntlProvider>
        <AgentsLoading />
      </IntlProvider>,
    );
    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Loading agents");
    expect(loading.textContent).not.toMatch(/\d/);
  });
});

describe("Agents at phone width", () => {
  it("keeps the Columns toggle on one row, leaves the action cells unlabelled, and makes every control a 44px target", async () => {
    const phone = phoneWidth();
    try {
      await renderAgents(
        { list: agentPage([agentRow()]) },
        null,
        phone.container,
      );
      const group = within(phone.container).getByRole("group", {
        name: "Columns",
      });
      expect(group.className).toContain("flex-nowrap");
      // The action header is empty, so the card-table labelling the shell
      // runs (features/shell/card-tables.ts) gives its cells no label; the
      // header keeps its name for assistive technology.
      const actionsHeader = within(phone.container)
        .getAllByRole("columnheader")
        .at(-1);
      expect(actionsHeader?.textContent).toBe("");
      expect(actionsHeader).toHaveAttribute("aria-label", "Row actions");
      // The list controls are 44px targets too: the search box and the Rows
      // select, beside the buttons.
      expect(
        within(phone.container).getByRole("searchbox", {
          name: "Search this list",
        }),
      ).toHaveAttribute("data-touch-target");
      expect(
        within(phone.container).getByRole("combobox", { name: "Rows" }),
      ).toHaveAttribute("data-touch-target");
      const targets = phone.container.querySelectorAll("[data-touch-target]");
      expect(targets.length).toBeGreaterThan(1);
      for (const target of targets)
        expect(getComputedStyle(target).minHeight).toBe("44px");
    } finally {
      phone.restore();
    }
  });
});
