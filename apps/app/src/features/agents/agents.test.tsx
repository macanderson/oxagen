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
) {
  const { source, calls } = agentsSource(reads);
  const element = await Agents({ ctx, source, cursor, header: HEADER });
  render(<IntlProvider>{element}</IntlProvider>);
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
  "Row actions",
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
  "Row actions",
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
      "Agents here7organization count not recorded · 7 listed below",
      "Enrolled25 not yet enrolled",
      "Holding a mandate1acme.core.release-bot · in Core platform",
      "Tamper incidents33 open in Core platform",
    ]);
    expect(tiles()[3]?.querySelector("[data-critical]")).not.toBeNull();
  });

  it("names the observe tier on Enrolled when every agent is enrolled, and says when nobody holds a mandate or an incident is open", async () => {
    await renderAgents({
      list: agentPage(
        [
          agentRow({ enforcementTier: "observe" }),
          agentRow({ id: "agt_b", slug: "b", enforcementTier: "harness" }),
        ],
        null,
        { identities: 2, enrolled: 2, holdingMandate: 0, tamperIncidents: 0 },
      ),
    });
    expect(tiles().map((tile) => tile.textContent)).toEqual([
      "Agents here2organization count not recorded · 2 listed below",
      "Enrolled21 listed here on the observe tier",
      "Holding a mandate0no agent holds one",
      "Tamper incidents0none open in Core platform",
    ]);
    expect(tiles()[3]?.querySelector("[data-critical]")).toBeNull();
  });

  it("names the holders it has and counts the rest", async () => {
    await renderAgents({
      list: agentPage([agentRow({ mandates: 1 })], null, {
        holdingMandate: 3,
      }),
    });
    expect(tiles()[2]?.textContent).toBe(
      "Holding a mandate3acme.core.release-bot · in Core platform, 2 more in Core platform",
    );
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
      "build-01gateway",
      "prn_91",
      "healthyframes arriving, chain intact",
      "42runs 30d",
      "EditRolesDeregister",
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
      "healthyframes arriving, chain intact",
      "not recorded",
    ]);
    const pending = rows()[1];
    if (pending === undefined) throw new Error("no row");
    expect(cellsOf(pending)[5]).toBe("—not recorded");
    expect(cellsOf(pending)[6]).toBe("prn_pending");
  });

  it("switches to Operations over the same agents, with its subtext and columns", async () => {
    await renderAgents({
      list: agentPage([
        agentRow({ mandates: 2, tamperIncidents: 1 }),
        agentRow({
          id: "agt_b",
          slug: "b",
          agentKey: "acme.core.b",
          spend30d: null,
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
      "$12.50client_attested",
      "not recorded",
      "2",
      "1",
      "EditRolesDeregister",
    ]);
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
    expect(screen.getByText("1-10 of 12")).toBeInTheDocument();
    const pager = screen.getByRole("navigation", { name: "Pages" });
    fireEvent.click(within(pager).getByRole("button", { name: "Page 2" }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByText("11-12 of 12")).toBeInTheDocument();
    const size = screen.getByRole("combobox", { name: "Rows" });
    expect(
      within(size)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["5", "10", "25", "50", "All"]);
    fireEvent.change(size, { target: { value: "0" } });
    expect(rows()).toHaveLength(12);
  });

  it("searches the rows and says when nothing matches", async () => {
    await renderAgents({ list: many() });
    const search = screen.getByRole("searchbox", { name: "Search this list" });
    fireEvent.change(search, { target: { value: "agent-07" } });
    expect(rows().map((row) => row.dataset.agent)).toEqual(["agent-07"]);
    fireEvent.change(search, { target: { value: "nothing like it" } });
    expect(rows()).toHaveLength(0);
    expect(
      screen.getByText("No agent matches this search."),
    ).toBeInTheDocument();
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
    expect(
      screen
        .getAllByRole("columnheader")
        .find((th) => th.textContent === "Steering"),
    ).not.toHaveAttribute("aria-sort");
  });

  it("derives its facets from the columns in view, so they change with the column set", async () => {
    await renderAgents({ list: many() });
    const facets = () =>
      screen
        .getAllByRole("combobox")
        .map((select) => select.getAttribute("aria-label"))
        .filter((label) => label !== null);
    expect(facets()).toEqual(["Filter by Owner", "Filter by Health"]);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter by Owner" }),
      { target: { value: "Sana Moreau" } },
    );
    expect(screen.getByText("1-6 of 6")).toBeInTheDocument();
    operations();
    expect(facets()).toEqual(["Filter by Operator", "Filter by Status"]);
    // The Owner facet left the view, so it no longer filters.
    expect(screen.getByText("1-10 of 12")).toBeInTheDocument();
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
      "An agent's identity lives in Postgres. Its definition is a file in .oxagen/agents/ in the main repo. Registering one opens a Context PR, and nothing is written to Postgres first.",
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
    expect(error).toHaveTextContent(/read at /);
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
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
      "Your roles on Acme Robotics do not include agent.read on core-platform. An organization owner can grant it. The grant is a governed action and lands in the audit record with your name on it.",
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
      "workspace.member · core-platform",
      "agent.read on core-platform",
      "the workspace's decision rules · deny wins over every allow",
    ]);
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
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
