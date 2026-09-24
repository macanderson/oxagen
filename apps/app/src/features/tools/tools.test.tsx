// @vitest-environment jsdom
// The Tools page (mockup `tools.md`) on a fake DataSource: the header and its
// one gold action, the five tabs as path segments with the counts the record
// can stand behind, the page's not-loaded states replacing the whole body, and
// the Tools, Toolbelts, Providers and Kill switches tabs. The Policy tab has
// its own suite (policy.test.tsx). Every element with no store behind it is
// asserted to say so and to carry the issue that owns the store. axe checks
// the state each test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";
import { readError, readOk } from "@/data/read";
// Type-only, so the `server-only` module is not pulled into the jsdom run.
import type { WsCtx as WsCtxType, WsRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { GrantEffect } from "@oxagen/oxagen";
import { killSwitchSet } from "@oxagen/oxagen/contracts/kill_switch.set";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import { toolImport } from "@oxagen/oxagen/contracts/tool.import";

// The record pickers read their lists through these server actions; each
// answers an empty list unless a test says otherwise.
const { choices } = vi.hoisted(() => {
  const none = () =>
    Promise.resolve({ ok: true, value: { options: [], partial: false } });
  return {
    choices: {
      chooseAgents: vi.fn(none),
      chooseApprovers: vi.fn(none),
      chooseMcpServers: vi.fn(none),
      chooseModels: vi.fn(none),
      chooseRuns: vi.fn(none),
      chooseSwitchTargets: vi.fn(none),
      chooseToolPatterns: vi.fn(none),
    },
  };
});
vi.mock("@/features/shell/client", () => ({
  ...choices,
  openApprovals: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const actions = vi.hoisted(() => ({
  importTools: vi.fn(),
  setToolClassification: vi.fn(),
  flipKillSwitch: vi.fn(),
  saveApprovalRule: vi.fn(),
  setApprovalRuleEnabled: vi.fn(),
  deleteApprovalRule: vi.fn(),
  addConnection: vi.fn(),
  readConnection: vi.fn(),
  registerServer: vi.fn(),
  removeProvider: vi.fn(),
}));
vi.mock("./actions", () => actions);

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Tools, ToolsLoading } = await import("./tools");
const {
  credentialGrantPage,
  killSwitchBoard,
  mcpServerList,
  toolsSource,
  toolVersionPage,
} = await import("./tools.builders");
const { TOOLS_TABS } = await import("./view");

type Tab = (typeof TOOLS_TABS)[number];

/** A viewer of this workspace; the two roles are independent memberships (#3143). */
function viewer(orgRole: OrgRole, wsRole: WsRole = "member") {
  return unsafeMint(WsCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole,
  });
}

const owner = viewer("owner");
const member = viewer("member");

function withIntl(element: ReactNode) {
  return render(<IntlProvider>{element}</IntlProvider>);
}

/** The element or a failure naming what was missing: the tests assert, they never cast. */
function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}
const rowOf = (node: HTMLElement) => element(node.closest("tr"), "row");
const cardOf = (selector: string) =>
  element(document.querySelector(selector), selector);

type Query = Readonly<Record<string, string | string[] | undefined>>;

async function renderTools(
  reads: Parameters<typeof toolsSource>[0] = {},
  tab: Tab = "tools",
  query: Query = {},
  ctx = owner,
) {
  const { source, calls } = toolsSource(reads);
  const view = withIntl(await Tools({ ctx, source, tab, searchParams: query }));
  return { ...view, calls };
}

/** Every gold (`.btn.primary`) control on the screen. */
const golds = () => [
  ...document.querySelectorAll('[class*="bg-button-primary-bg"]'),
];

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Tools › header", () => {
  it("names the workspace over the h1 with the design's subtext, and its three actions in order", async () => {
    await renderTools();
    const header = element(document.querySelector("header"), "header");
    expect(within(header).getByText("Core platform")).toBeVisible();
    expect(
      within(header).getByRole("heading", { level: 1, name: "Tools" }),
    ).toBeVisible();
    expect(
      within(header).getByText(
        "The registry is the only source of tools an agent can see.",
      ),
    ).toBeVisible();
    expect(
      within(header)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Import a provider", "New tool", "Flip a kill switch"]);
  });

  it.each([
    ["tools", "New tool"],
    ["switches", "New tool"],
    ["toolbelts", "New toolbelt"],
    ["providers", "Add a provider"],
  ] as const)(
    "draws exactly one gold action on %s, and it is %s",
    async (tab, gold) => {
      await renderTools({}, tab);
      expect(golds().map((node) => node.textContent)).toEqual([gold]);
    },
  );

  it("opens the tool wizard's stub, which says what it would do and saves nothing", async () => {
    await renderTools();
    fireEvent.click(screen.getByTestId("tools-new-tool-open"));
    const dialog = await screen.findByTestId("tools-new-tool");
    expect(
      within(dialog).getByText(/The tool wizard is not built yet/),
    ).toHaveAttribute("data-gap", "#3924");
    expect(within(dialog).getByTestId("tools-new-tool-confirm")).toBeDisabled();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(5);
  });

  it("offers a member none of the header's actions", async () => {
    await renderTools({}, "tools", {}, member);
    const header = element(document.querySelector("header"), "header");
    expect(within(header).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("Tools › tabs", () => {
  it("draws the five tabs as a tablist of path segments, the current one selected", async () => {
    await renderTools({}, "providers");
    const tabs = within(
      screen.getByRole("tablist", { name: "Tools sections" }),
    );
    const all = tabs.getAllByRole("tab");
    expect(all.map((tab) => tab.getAttribute("data-tab"))).toEqual([
      "tools",
      "toolbelts",
      "providers",
      "policy",
      "switches",
    ]);
    expect(all.map((tab) => tab.getAttribute("href"))).toEqual([
      "/acme/core-platform/tools",
      "/acme/core-platform/tools/toolbelts",
      "/acme/core-platform/tools/providers",
      "/acme/core-platform/tools/policy",
      "/acme/core-platform/tools/switches",
    ]);
    const current = tabs.getByRole("tab", { selected: true });
    expect(current).toHaveAttribute("data-tab", "providers");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      current.id,
    );
  });

  it("counts the registry's versions, the providers and the switches denying, and nothing for the two unstored tabs", async () => {
    await renderTools();
    const count = (tab: string) =>
      document.querySelector(`[data-count="${tab}"]`)?.textContent ?? null;
    expect(count("tools")).toBe("2");
    expect(count("providers")).toBe("2");
    expect(count("switches")).toBe("1 on");
    expect(count("toolbelts")).toBeNull();
    expect(count("policy")).toBeNull();
  });

  it("marks the versions count as a floor while the registry has a later page", async () => {
    await renderTools({
      versions: readOk(toolVersionPage({ nextCursor: "c2" })),
    });
    expect(document.querySelector('[data-count="tools"]')?.textContent).toBe(
      "2+",
    );
  });

  it("marks the switch count as a floor when the board came back full", async () => {
    await renderTools({ killSwitches: readOk(killSwitchBoard({}, 3)) });
    expect(document.querySelector('[data-count="switches"]')?.textContent).toBe(
      "1 or more on",
    );
  });

  it("shows no provider count when the roster did not answer, and still draws the registry", async () => {
    await renderTools({
      mcpServers: readError("tool_registry_unavailable", 503),
    });
    expect(document.querySelector('[data-count="providers"]')).toBeNull();
    expect(document.querySelector('[data-count="tools"]')?.textContent).toBe(
      "2",
    );
    // A registry holding versions is not the empty state, whatever the
    // roster said.
    expect(screen.getByRole("table", { name: "Tools" })).toBeVisible();
  });

  it("is not the empty state when the registry is empty but the roster did not answer", async () => {
    await renderTools({
      versions: readOk(toolVersionPage({ items: [] })),
      mcpServers: readError("tool_registry_unavailable", 503),
    });
    // Nothing says the workspace has no provider: the roster could not say.
    expect(screen.queryByTestId("tools-empty")).not.toBeInTheDocument();
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(document.querySelector('[data-count="providers"]')).toBeNull();
  });

  it("shows no switch count when the board did not answer", async () => {
    await renderTools({
      killSwitches: readError("tool_registry_unavailable", 503),
    });
    expect(document.querySelector('[data-count="switches"]')).toBeNull();
  });

  it.each(TOOLS_TABS.map((tab) => [tab]))(
    "renders a body behind the %s tab",
    async (tab) => {
      await renderTools({}, tab);
      expect(screen.getByRole("tabpanel").childElementCount).toBeGreaterThan(0);
    },
  );
});

describe("Tools › not loaded", () => {
  it("replaces the whole body when the registry read is denied, naming the permission and who decides", async () => {
    await renderTools({
      versions: { ok: false, reason: "denied", permission: "tools.read" },
    });
    const panel = within(screen.getByTestId("tools-denied"));
    expect(panel.getByText("You cannot see the tool registry")).toBeVisible();
    expect(screen.getByTestId("tools-denied").textContent).toContain(
      "Your roles on Acme Robotics do not include tools.read on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(panel.getByText("Signed in as")).toBeVisible();
    expect(panel.getAllByText("tools.read on core-platform")).toHaveLength(2);
    expect(
      panel.getByText(
        "The workspace’s decision rules. Deny wins over every allow.",
      ),
    ).toBeVisible();
    expect(panel.getByRole("link", { name: "Back to Fleet" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    // The body is replaced: no header, no tabs.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();

    fireEvent.click(panel.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByTestId("tools-request-access");
    expect(
      within(dialog).getByTestId("tools-request-access-confirm"),
    ).toBeDisabled();
    expect(
      element(dialog.querySelector('[data-state="not-backed"]'), "note"),
    ).toHaveAttribute("data-gap", "#3820");
  });

  it("names the code, says nothing was changed, and offers Try again on this tab and Open an incident", async () => {
    await renderTools(
      { versions: readError("tool_registry_unavailable", 503) },
      "switches",
    );
    const panel = screen.getByTestId("tools-error");
    expect(within(panel).getByText("Tools could not be loaded")).toBeVisible();
    expect(panel.textContent).toContain(
      "The control plane answered 503 tool_registry_unavailable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    expect(
      within(panel).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/acme/core-platform/tools/switches");
    fireEvent.click(
      within(panel).getByRole("button", { name: "Open an incident" }),
    );
    const dialog = await screen.findByTestId("tools-incident");
    expect(within(dialog).getByTestId("tools-incident-confirm")).toBeDisabled();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("names the access request while one is waiting", async () => {
    await renderTools({
      versions: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_01k5",
      },
    });
    expect(
      within(screen.getByTestId("tools-pending")).getByText(/acr_01k5/),
    ).toBeVisible();
  });

  it("is the empty state when no provider is registered and the registry holds nothing", async () => {
    await renderTools({
      versions: readOk(toolVersionPage({ items: [], nextCursor: null })),
      mcpServers: readOk(mcpServerList({ servers: [] })),
    });
    const panel = screen.getByTestId("tools-empty");
    expect(within(panel).getByText("No provider is registered")).toBeVisible();
    expect(panel.textContent).toContain(
      "Until a provider is imported, no agent in this workspace has a toolbelt, and every call by name is unknown_tool. Importing a provider pulls its tool list, versions each tool, and stores both schemas.",
    );
    expect(golds().map((node) => node.textContent)).toEqual([
      "Import a provider",
    ]);
    expect(
      within(panel).getByRole("button", { name: "Add a connection" }),
    ).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("offers a member the empty state's words and none of its writes", async () => {
    await renderTools(
      {
        versions: readOk(toolVersionPage({ items: [], nextCursor: null })),
        mcpServers: readOk(mcpServerList({ servers: [] })),
      },
      "tools",
      {},
      member,
    );
    expect(
      within(screen.getByTestId("tools-empty")).queryAllByRole("button"),
    ).toHaveLength(0);
  });
});

describe("ToolsLoading", () => {
  it("is a busy skeleton of four tiles and a panel of seven rows, with no figure in it", () => {
    withIntl(<ToolsLoading />);
    const skeleton = screen.getByRole("status", { name: "Loading tools" });
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.querySelectorAll('[data-skeleton="tile"]')).toHaveLength(4);
    expect(skeleton.querySelectorAll('[data-skeleton="row"]')).toHaveLength(7);
    expect(skeleton.textContent).toBe("");
  });
});

describe("Tools › tools tab", () => {
  it("draws the design's columns in order", async () => {
    await renderTools();
    const table = screen.getByRole("table", { name: "Tools" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Tool version",
      "Provider",
      "Category",
      "Hazard",
      "Gate today",
      "Egress",
      "Financial",
      "Schema origin",
      "Digest",
      "Toolbelts",
      "Agents",
      "Calls 30d",
    ]);
  });

  it("prints each version with what its record carries, and the belt cells as not recorded", async () => {
    await renderTools();
    const money = rowOf(screen.getByText("Create payment"));
    const cells = within(money);
    expect(cells.getByText("stripe__create_payment@4")).toBeInTheDocument();
    expect(cells.getByRole("button", { name: "Open Stripe" })).toBeVisible();
    expect(cells.getAllByText("moves_money").length).toBe(2);
    expect(cells.getByText("Critical")).toBeInTheDocument();
    expect(cells.getByText("irreversible")).toBeInTheDocument();
    expect(cells.getByText("Kill switch on its class")).toBeInTheDocument();
    expect(cells.getByText("third party")).toBeInTheDocument();
    expect(cells.getByText("Imported")).toBeInTheDocument();
    expect(cells.getByText("a1b2c3d4e5f6")).toBeInTheDocument();
    expect(cells.getByText("1,204")).toBeInTheDocument();
    const belts = money.querySelectorAll('[data-gap="#3852"]');
    expect(belts).toHaveLength(2);
  });

  it("says what an unclassified version does not carry rather than inventing it", async () => {
    await renderTools();
    const plain = rowOf(screen.getByText("Get file contents"));
    expect(within(plain).getByText("Unclassified")).toBeVisible();
    // Egress, Financial, Toolbelts, Agents and Calls: none prints a zero or a no.
    expect(within(plain).getAllByText("not recorded")).toHaveLength(5);
    expect(within(plain).queryByText("0")).not.toBeInTheDocument();
  });

  it("states that observed output schemas are not recorded, so nothing waits on approval", async () => {
    await renderTools();
    expect(screen.getByTestId("tools-observed-schemas")).toHaveAttribute(
      "data-gap",
      "#3921",
    );
    expect(screen.queryByText(/to approve/)).not.toBeInTheDocument();
  });

  it("counts what is shown against the registry, and toggles labels and API names with aria-pressed", async () => {
    await renderTools({}, "tools", { names: "api" });
    expect(screen.getByTestId("tools-shown")).toHaveTextContent("2 of 2 shown");
    const toggle = within(screen.getByRole("group", { name: "Tool names" }));
    expect(toggle.getByRole("button", { name: "API names" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(toggle.getByRole("button", { name: "Labels" }));
    expect(router.push).toHaveBeenCalledWith("/acme/core-platform/tools");
  });

  it("asks the kernel for the tag a chip picks, and a pressed chip clears it", async () => {
    const { calls } = await renderTools({}, "tools", {
      category: "moves_money",
    });
    expect(calls.versions).toContainEqual([
      owner,
      { category: "moves_money", cursor: null },
    ]);
    const chips = within(
      screen.getByRole("group", { name: "Filter by category" }),
    );
    const picked = chips.getByRole("button", { name: /moves_money/ });
    expect(picked).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(picked);
    expect(router.push).toHaveBeenCalledWith("/acme/core-platform/tools");
  });

  it("says the chip matched nothing rather than that the registry is empty", async () => {
    await renderTools(
      {
        versions: (q) =>
          q.category === null
            ? readOk(toolVersionPage())
            : readOk(toolVersionPage({ items: [], nextCursor: null })),
      },
      "tools",
      { category: "destroys_data" },
    );
    expect(
      screen.getByText("No tool version on this page carries that tag."),
    ).toBeVisible();
  });

  it("links a later page when the read carried a cursor", async () => {
    await renderTools({
      versions: readOk(toolVersionPage({ nextCursor: "c2" })),
    });
    expect(screen.getByTestId("tools-next-page")).toHaveAttribute(
      "href",
      "/acme/core-platform/tools?cursor=c2",
    );
  });

  it("closes on the gate note, naming the order the record decides in", async () => {
    await renderTools();
    expect(
      screen.getByText(
        "The gate shown is today’s: the version’s own kill switch, then its provider’s, then its class’s. A toolbelt decides which agents are shown the tool; the gate decides whether the call survives. Open a provider on any row to see what it imported and the connection it is reached with.",
      ),
    ).toBeVisible();
  });

  it("explains the categories in their own dialog, and says the ten-category taxonomy is not recorded", async () => {
    await renderTools();
    fireEvent.click(screen.getByTestId("tools-categories-open"));
    const dialog = await screen.findByTestId("tools-categories");
    expect(within(dialog).getByText("moves_money")).toBeVisible();
    expect(
      within(dialog).getByText(
        /Category is a registry attribute, not a policy/,
      ),
    ).toBeVisible();
  });

  it("opens the provider from a tool row, showing only that provider's versions", async () => {
    await renderTools();
    fireEvent.click(screen.getByRole("button", { name: "Open Stripe" }));
    const dialog = await screen.findByTestId("provider-dialog");
    const tools = within(dialog).getByRole("table", {
      name: "Tools imported from Stripe",
    });
    expect(within(tools).getByText("Create payment")).toBeVisible();
    expect(
      within(tools).queryByText("Get file contents"),
    ).not.toBeInTheDocument();
  });
});

describe("Tools › toolbelts tab", () => {
  it("keeps both panels and says toolbelts and assignments are not stored, rather than drawing an empty table", async () => {
    await renderTools({}, "toolbelts");
    const belts = screen.getByRole("region", { name: "Toolbelts" });
    expect(
      within(belts).getByText(
        "A toolbelt is a named set of tool versions assigned to agents. It decides what a model is shown, and nothing else.",
      ),
    ).toBeVisible();
    expect(
      within(belts).getByTestId("tools-toolbelts-not-backed"),
    ).toHaveAttribute("data-gap", "#3852");
    expect(within(belts).queryByRole("table")).not.toBeInTheDocument();
    expect(
      within(belts).getByText(/Assigning a belt is not a permission/),
    ).toBeVisible();
    const assignments = screen.getByRole("region", { name: "Assignments" });
    expect(
      within(assignments).getByTestId("tools-assignments-not-backed"),
    ).toHaveAttribute("data-gap", "#3852");
    expect(
      within(assignments).getByTestId("tools-assignments-agents"),
    ).toHaveAttribute("href", "/acme/core-platform/agents");
  });

  it("opens New toolbelt with the three owners, and saves nothing", async () => {
    await renderTools({}, "toolbelts");
    fireEvent.click(screen.getByTestId("tools-belt-new-open"));
    const dialog = await screen.findByTestId("tools-belt-new");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["platform", "finops", "security"]);
    expect(within(dialog).getByTestId("tools-belt-new-confirm")).toBeDisabled();
  });

  it("offers a member no New toolbelt", async () => {
    await renderTools({}, "toolbelts", {}, member);
    expect(screen.queryByTestId("tools-belt-new-open")).not.toBeInTheDocument();
  });
});

describe("Tools › providers tab", () => {
  it("captions the roster with counts read off the rows, and draws the design's columns", async () => {
    await renderTools({}, "providers");
    expect(screen.getByTestId("tools-providers-caption")).toHaveTextContent(
      "2 providers hold 2 tool versions.",
    );
    const table = screen.getByRole("table", { name: "Providers" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Provider",
      "Transport",
      "Tools",
      "Toolbelts",
      "Agents",
      "Health",
      "Connection",
      "Authorization",
      "Last import",
      "Actions",
    ]);
  });

  it("names a provider by its system and carries the transport as a column value", async () => {
    await renderTools({}, "providers");
    const stripe = within(
      rowOf(screen.getByRole("button", { name: "Open Stripe" })),
    );
    expect(stripe.getByText("mcp")).toBeVisible();
    expect(
      stripe.getByText("streamable-http · https://mcp.stripe.example/v1"),
    ).toBeVisible();
    expect(stripe.getByText("12 pinned at last check")).toBeVisible();
    expect(stripe.getByText("ok")).toBeVisible();
    // Toolbelts, Agents, Connection, Authorization, Last import.
    expect(stripe.getAllByText("not recorded")).toHaveLength(5);
    // No heading, column or button on the tab calls a provider a server.
    expect(document.body.textContent).not.toMatch(/MCP servers?|Tool server/);
  });

  it("says it cannot count connections needing attention, and keeps the transport note", async () => {
    await renderTools({}, "providers");
    expect(screen.getByTestId("tools-providers-attention")).toHaveAttribute(
      "data-gap",
      "#3918",
    );
    expect(
      screen.getByText(/MCP is one transport among several/),
    ).toBeVisible();
  });

  it("opens the drill-down with the provider's facts, its authorization gap and only its versions", async () => {
    await renderTools({}, "providers");
    fireEvent.click(screen.getByTestId("provider-open-mcs_01k5s1"));
    const dialog = within(await screen.findByTestId("provider-dialog"));
    for (const term of [
      "System",
      "Transport",
      "Registry name",
      "Schemas",
      "Tool versions",
      "Toolbelts",
      "Agents reached",
      "Last import",
    ]) {
      expect(dialog.getByText(term)).toBeVisible();
    }
    expect(dialog.getByText("Authorization")).toBeVisible();
    expect(
      dialog.getByRole("button", { name: "Connect with OAuth" }),
    ).toBeVisible();
    expect(dialog.getByText("Create payment")).toBeVisible();
    expect(dialog.queryByText("Get file contents")).not.toBeInTheDocument();
  });

  it("warns on a degraded provider's drill-down", async () => {
    await renderTools(
      {
        mcpServers: readOk(
          mcpServerList({
            servers: [
              {
                publicId: "mcs_01k5s1",
                name: "Stripe",
                transportType: "streamable-http",
                endpointUrl: "https://mcp.stripe.example/v1",
                healthStatus: "degraded",
                lastHealthcheckAt: null,
                toolCount: 1,
              },
            ],
          }),
        ),
      },
      "providers",
    );
    fireEvent.click(screen.getByTestId("provider-open-mcs_01k5s1"));
    expect(await screen.findByTestId("provider-health-warning")).toBeVisible();
  });

  it("removes a provider after saying what stops and what is kept, and re-reads the tab", async () => {
    actions.removeProvider.mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });
    await renderTools({}, "providers");
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    const dialog = within(await screen.findByTestId("provider-remove-dialog"));
    expect(
      dialog.getByText(/Its tools stop registering at once/),
    ).toBeVisible();
    expect(dialog.getByText(/kept for at least 365 days/)).toBeVisible();
    fireEvent.click(dialog.getByTestId("provider-remove-confirm"));
    await vi.waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/core-platform/tools/providers",
      );
    });
    expect(actions.removeProvider).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "mcs_01k5s1",
    );
  });

  it("says nothing was removed when the provider was already gone (negative)", async () => {
    actions.removeProvider.mockResolvedValue({
      ok: true,
      value: { deleted: false },
    });
    await renderTools({}, "providers");
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    fireEvent.click(await screen.findByTestId("provider-remove-confirm"));
    expect(
      await screen.findByTestId("provider-remove-not-found"),
    ).toBeVisible();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a refused removal where the person acted", async () => {
    actions.removeProvider.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await renderTools({}, "providers");
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    fireEvent.click(await screen.findByTestId("provider-remove-confirm"));
    expect(
      await screen.findByTestId("provider-remove-failure"),
    ).toHaveTextContent("organization Owner or Admin");
  });

  it("re-imports a provider's tools from its drill-down and says what changed", async () => {
    actions.importTools.mockResolvedValue({
      ok: true,
      value: { importDigest: "d1", published: 1, unchanged: 3 },
    });
    await renderTools({}, "providers");
    fireEvent.click(screen.getByTestId("provider-open-mcs_01k5s1"));
    fireEvent.click(await screen.findByTestId("provider-reimport-mcs_01k5s1"));
    expect(
      await screen.findByTestId("provider-reimport-done"),
    ).toHaveTextContent("1 new version, 3 already registered.");
    expect(actions.importTools).toHaveBeenCalledWith("acme", "core-platform", {
      serverId: "mcs_01k5s1",
      tools: [],
    });
  });

  it("offers every transport and wire in Edit, which saves nothing yet", async () => {
    await renderTools({}, "providers");
    fireEvent.click(screen.getByTestId("provider-open-mcs_01k5s1"));
    fireEvent.click(await screen.findByTestId("provider-edit-mcs_01k5s1-open"));
    const dialog = within(
      await screen.findByTestId("provider-edit-mcs_01k5s1"),
    );
    const transport = element(
      document.querySelector("#edit-transport-mcs_01k5s1"),
      "transport",
    );
    expect(
      [...transport.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual([
      "mcp",
      "http",
      "graphql",
      "sdk",
      "cli",
      "native",
      "local",
      "rpc",
    ]);
    expect(
      document.querySelectorAll("#edit-wire-mcs_01k5s1 option"),
    ).toHaveLength(5);
    expect(
      dialog.getByTestId("provider-edit-mcs_01k5s1-confirm"),
    ).toBeDisabled();
  });

  it("keeps the connections and the credential grants log with the design's columns", async () => {
    await renderTools({}, "providers", { cursor: "g1" });
    expect(screen.getByRole("table", { name: "Connections" })).toBeVisible();
    const log = screen.getByRole("table", { name: "Credential grants log" });
    expect(
      within(log)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Grant",
      "Tool version",
      "Agent and run",
      "Connection",
      "Scope",
      "TTL",
      "State",
    ]);
    const github = within(rowOf(within(log).getByText("mcgr_01k5g1")));
    expect(github.getByText("from github")).toBeVisible();
    expect(github.getByText("arun_01k5r7")).toBeVisible();
    expect(github.getByText("5m")).toBeVisible();
  });

  it("links a later page of the grants log on this tab", async () => {
    await renderTools(
      { grants: readOk(credentialGrantPage({ nextCursor: "g2" })) },
      "providers",
    );
    expect(screen.getByTestId("tools-next-page")).toHaveAttribute(
      "href",
      "/acme/core-platform/tools/providers?cursor=g2",
    );
  });

  it("offers a member no provider write", async () => {
    await renderTools({}, "providers", {}, member);
    expect(screen.queryAllByTestId("tools-import-open")).toHaveLength(0);
    expect(
      screen.queryByTestId("provider-remove-open-mcs_01k5s1"),
    ).not.toBeInTheDocument();
  });
});

describe("Tools › kill switches tab", () => {
  it("draws the class switches with the deny generation, and the two the contract cannot write as not recorded", async () => {
    await renderTools({}, "switches");
    const classes = screen.getByRole("region", { name: /Class switches/ });
    expect(
      within(classes).getByTestId("tools-deny-generation"),
    ).toHaveTextContent("deny generation 12");
    const money = cardOf('[data-switch="emd_01k5c1"]');
    expect(within(money).getByText("every moves_money tool")).toBeVisible();
    expect(
      within(money).getByRole("switch", {
        name: /Allow every moves_money tool again/,
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(money).getByText(
        "Suspected compromise of the Stripe restricted key.",
      ),
    ).toBeVisible();
    for (const which of ["irreversible", "egress"]) {
      expect(
        screen.getByTestId(`tools-switch-unbacked-${which}`),
      ).toHaveAttribute("data-gap", "#3922");
    }
  });

  it("prints who flipped a switch by the id the record holds when the org roster did not answer", async () => {
    await renderTools(
      {
        members: readError("org_unavailable", 503),
        agents: readError("agents_unavailable", 503),
      },
      "switches",
    );
    const money = cardOf('[data-switch="emd_01k5c1"]');
    const flippedBy = money.querySelector('[data-fact="flippedBy"] dd');
    expect(flippedBy).toHaveTextContent("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    // The board itself is a separate read and is still drawn in full.
    expect(
      screen.getByRole("region", { name: /Scoped switches/ }),
    ).toBeVisible();
  });

  it("ships the organization and workspace switches, named by what they stop, allowing until flipped", async () => {
    await renderTools(
      { killSwitches: readOk(killSwitchBoard({ switches: [] })) },
      "switches",
    );
    const scoped = within(
      screen.getByRole("region", { name: "Scoped switches" }),
    );
    const org = scoped.getByRole("switch", { name: "Deny Acme Robotics" });
    expect(org).toHaveAttribute("aria-checked", "false");
    expect(
      scoped.getByRole("switch", { name: "Deny Core platform" }),
    ).toHaveAttribute("aria-checked", "false");
    // Shipped switches carry neither Edit nor Remove.
    expect(
      scoped.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
    // Its toggle opens the confirmation, which states the blast radius first.
    fireEvent.click(org);
    const dialog = within(await screen.findByTestId("tools-flip-dialog"));
    expect(dialog.getByTestId("tools-flip-blast-radius")).toHaveTextContent(
      "Every agent in every workspace of this organization.",
    );
  });

  it("puts a recorded workspace switch on the workspace card rather than a second one", async () => {
    await renderTools({}, "switches");
    expect(
      document.querySelectorAll('[data-switch^="workspace"]'),
    ).toHaveLength(0);
    const workspace = cardOf('[data-switch="emd_01k5c2"]');
    expect(within(workspace).getByText("Core platform")).toBeVisible();
    expect(workspace.textContent).not.toContain(
      "7b000000-0000-4000-8000-000000000001",
    );
  });

  it("carries Edit and Remove on a switch someone flipped, neither of which has a write yet", async () => {
    await renderTools({}, "switches");
    const provider = cardOf('[data-switch="emd_01k5c3"]');
    expect(within(provider).getByText("Provider")).toBeVisible();
    fireEvent.click(
      within(provider).getByTestId("tools-switch-remove-emd_01k5c3-open"),
    );
    const dialog = within(
      await screen.findByTestId("tools-switch-remove-emd_01k5c3"),
    );
    expect(
      dialog.getByText(/Removing a switch is not built yet/),
    ).toBeVisible();
    expect(
      dialog.getByTestId("tools-switch-remove-emd_01k5c3-confirm"),
    ).toBeDisabled();
  });

  it("refuses to remove a switch that is denying and says to clear it first", async () => {
    const board = killSwitchBoard({
      switches: [
        {
          id: "emd_01k5d1",
          target: { kind: "agent", id: "agt_invoicebot" },
          scope: "workspace",
          on: true,
          reason: "Paying the wrong vendor.",
          flippedBy: null,
          flippedAt: "2026-09-11T15:02:00.000Z",
          clearedAt: null,
          clearedBy: null,
        },
      ],
    });
    await renderTools({ killSwitches: readOk(board) }, "switches");
    const card = cardOf('[data-switch="emd_01k5d1"]');
    // The agent is named by its slug off the workspace's agents.
    expect(within(card).getByText("invoice-bot")).toBeVisible();
    fireEvent.click(
      within(card).getByTestId("tools-switch-remove-emd_01k5d1-open"),
    );
    expect(
      await screen.findByText(/This switch is denying. Clear it first/),
    ).toBeVisible();
  });

  it("offers Create a switch over the three scopes an incident names, saving nothing yet", async () => {
    await renderTools({}, "switches");
    fireEvent.click(screen.getByTestId("tools-switch-new-open"));
    const dialog = await screen.findByTestId("tools-switch-new");
    const scope = element(dialog.querySelector("#switch-scope"), "scope");
    expect(
      [...scope.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(["Agent", "Enrolled device", "Operator’s agents"]);
    expect(
      within(dialog).getByTestId("tools-switch-new-confirm"),
    ).toBeDisabled();
  });

  it("says the board is its newest page when the read came back full", async () => {
    await renderTools(
      { killSwitches: readOk(killSwitchBoard({}, 3)) },
      "switches",
    );
    expect(
      element(document.querySelector('[data-state="truncated"]'), "truncation"),
    ).toHaveTextContent("the count on the tab is a floor");
  });

  it("shows a member each switch's state as a word, with no toggle", async () => {
    await renderTools({}, "switches", {}, member);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(
      within(cardOf('[data-switch="emd_01k5c1"]')).getByText("denying"),
    ).toBeVisible();
    expect(
      screen.queryByTestId("tools-switch-new-open"),
    ).not.toBeInTheDocument();
  });
});

// The three writes #2958 gated, each named by the capability it invokes.
const TOOLS_WRITES = [
  ["import_tools", toolImport],
  ["set_tool_classification", toolClassificationSet],
  ["set_kill_switch", killSwitchSet],
] as const;

type ToolsWrite = (typeof TOOLS_WRITES)[number][0];
type ToolsWriteContract = (typeof TOOLS_WRITES)[number][1];

/**
 * Whether this capability admits this viewer in practice, read off its own
 * `defaultRoles.org`, the object each handler asserts. The workspace clause
 * is not read: no human principal can hold a workspace-scoped IAM assignment,
 * so it admits nobody (#3143, #3198).
 */
function enforceablyGrants(
  contract: ToolsWriteContract,
  ctx: WsCtxType,
): boolean {
  const org: Partial<Record<string, GrantEffect>> = contract.defaultRoles.org;
  return Object.entries(org)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role.toLowerCase())
    .includes(ctx.orgRole);
}

/** Which of the three write controls the page offers this viewer. */
async function offered(ctx: WsCtxType): Promise<Record<ToolsWrite, boolean>> {
  await renderTools({}, "tools", {}, ctx);
  // The header and the Tools panel each carry the import control.
  const importOffered = screen.queryAllByTestId("tools-import-open").length > 0;
  const flipOffered = screen.queryByTestId("tools-flip-open") !== null;
  fireEvent.click(screen.getByText("Create payment"));
  const dialog = within(await screen.findByTestId("tool-dialog"));
  const classifyOffered =
    dialog.queryByRole("button", { name: "Reclassify this version" }) !== null;
  expect(
    dialog.queryByText(
      "Reclassifying a tool version needs an organization Owner or Admin.",
    ) === null,
  ).toBe(classifyOffered);
  cleanup();
  return {
    import_tools: importOffered,
    set_tool_classification: classifyOffered,
    set_kill_switch: flipOffered,
  };
}

describe("Tools › write gates", () => {
  it.each([
    ["member", "owner"],
    ["member", "member"],
    ["owner", "member"],
    ["admin", "owner"],
    ["billing", "viewer"],
    ["compliance", "member"],
  ] as const)(
    "gates each write on exactly the org roles its contract grants, for an org %s holding %s in the workspace",
    async (orgRole, wsRole) => {
      const ctx = viewer(orgRole, wsRole);
      expect(await offered(ctx)).toEqual(
        Object.fromEntries(
          TOOLS_WRITES.map(([name, contract]) => [
            name,
            enforceablyGrants(contract, ctx),
          ]),
        ),
      );
    },
  );
});
