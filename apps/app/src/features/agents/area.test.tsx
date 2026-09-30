// @vitest-environment jsdom
// The Agents page (roadmap mockups `agents`), which absorbed the Tools page
// and the Runtimes list, over a fake DataSource: which tab a `?tab=` names,
// the five tabs in order with their hrefs and the counts the record can stand
// behind, the one header over every tab with Connect an agent last and the
// only gold action, and the body each tab draws. The header and the strip stay
// when a tab's body cannot be read. Each tab's body has its own suite
// (agents.test.tsx, features/tools/*.test.tsx, features/runtimes). The page
// holds async Server Components below its Suspense boundary, so it is
// prerendered rather than mounted, and axe checks every state (INV-26).
import { screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";
import { readError, readOk } from "@/data/read";
import type { AgentsPageTab } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { renderPage } from "@/test/render-page";
import {
  enrollment,
  runtimeList,
  runtimesSource,
} from "../runtimes/runtimes.builders";
import {
  killSwitchBoard,
  mcpServerList,
  toolsSource,
  toolVersionPage,
} from "../tools/tools.builders";
import { agentPage, agentRow } from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
// The client islands' server actions and record pickers; this suite writes
// nothing and opens no picker.
vi.mock("@/features/shell/client", () => {
  const none = () =>
    Promise.resolve({ ok: true, value: { options: [], partial: false } });
  return {
    chooseAgents: vi.fn(none),
    chooseApprovers: vi.fn(none),
    chooseMcpServers: vi.fn(none),
    chooseModels: vi.fn(none),
    chooseRuns: vi.fn(none),
    chooseServerTools: vi.fn(none),
    chooseSwitchTargets: vi.fn(none),
    chooseToolPatterns: vi.fn(none),
    openApprovals: vi.fn(),
  };
});
vi.mock("./actions", () => ({
  retireAgent: vi.fn(),
  rotateAgentCredential: vi.fn(),
  setAgentSuspended: vi.fn(),
  readAssignableRoles: vi.fn(() => new Promise(() => {})),
  readAgentRoleNames: vi.fn(() => new Promise(() => {})),
  assignAgentRole: vi.fn(),
  revokeAgentRole: vi.fn(),
}));
vi.mock("../tools/actions", () => ({
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
  cloneToolbelt: vi.fn(),
  updateToolbelt: vi.fn(),
  deleteToolbelt: vi.fn(),
  setToolState: vi.fn(),
}));
vi.mock("../tools/provider-auth-actions", () => ({
  searchRegistry: vi.fn(),
  startProviderAuthorization: vi.fn(),
  providerRedirectUrl: vi.fn(),
}));
vi.mock("../runtimes/actions", () => ({
  unenrollRuntime: vi.fn(),
  createRuntime: vi.fn(),
  setRuntimeContainment: vi.fn(),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { AgentsArea, areaTabOf, parseAgentsPageTab } = await import("./area");

function viewer(orgRole: OrgRole) {
  return unsafeMint(WsCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole: "member",
  });
}

const owner = viewer("owner");

type Reads = Parameters<typeof toolsSource>[0];

/**
 * The Agents page on one tab: the Tools reads default to their fixtures, the
 * agents read to one agent, and the runtimes read to one enrolled host.
 */
async function renderArea(
  tab: AgentsPageTab = "agents",
  reads: Reads = {},
  ctx = owner,
  searchParams: Record<string, string> = {},
) {
  const { source, calls } = toolsSource({
    agents: agentPage([agentRow()]),
    ...reads,
  });
  source.runtimes = runtimesSource({
    list: runtimeList([enrollment()]),
  }).source.runtimes;
  await renderPage(
    await AgentsArea({
      ctx,
      source,
      tab,
      searchParams,
      viewerName: "Marcus Bell",
    }),
  );
  return calls;
}

/** The element or a failure naming what was missing: the tests assert, they never cast. */
function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}

const header = () => element(document.querySelector("header"), "header");
const tabs = () =>
  within(screen.getByRole("tablist", { name: "Agents sections" })).getAllByRole(
    "tab",
  );
/** The header's controls, in the order it draws them. */
const actions = () =>
  [...header().querySelectorAll("button, a")].map((el) => el.textContent);
/** Every gold (`.btn.primary`) control in the header. */
const golds = () => [
  ...header().querySelectorAll('[class*="bg-button-primary-bg"]'),
];

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    document.body.replaceChildren();
  }
});

describe("parseAgentsPageTab", () => {
  it("is Agents when the URL names no tab", () => {
    expect(parseAgentsPageTab(undefined)).toBe("agents");
  });

  it.each([
    "agents",
    "servers",
    "policies",
    "runtimes",
    "switches",
    "tools",
    "toolbelts",
  ] as const)("serves ?tab=%s as itself", (tab) => {
    expect(parseAgentsPageTab(tab)).toBe(tab);
  });

  it("lands the Tools page's own tab ids on the tab that holds them", () => {
    expect(parseAgentsPageTab("providers")).toBe("servers");
    expect(parseAgentsPageTab("policy")).toBe("policies");
  });

  it.each(["registry", "", "Servers", "agents/x"])(
    "reads ?tab=%j, which the page does not serve, as Agents (negative)",
    (raw) => {
      expect(parseAgentsPageTab(raw)).toBe("agents");
    },
  );
});

describe("areaTabOf", () => {
  it("lights Tool servers for the registry and the toolbelts, its other two views", () => {
    expect(areaTabOf("tools")).toBe("servers");
    expect(areaTabOf("toolbelts")).toBe("servers");
  });

  it.each(["agents", "servers", "policies", "runtimes", "switches"] as const)(
    "lights %s for itself",
    (tab) => {
      expect(areaTabOf(tab)).toBe(tab);
    },
  );
});

describe("Agents page › header", () => {
  it("names the workspace over the h1 with the page's description", async () => {
    await renderArea();
    expect(within(header()).getByText("Core platform")).toBeInTheDocument();
    expect(
      within(header()).getByRole("heading", { level: 1, name: "Agents" }),
    ).toBeInTheDocument();
    expect(
      within(header()).getByText(
        "Your agents, the tool servers they call, the policies that decide each call, where they run, and the off switches.",
      ),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("draws the Tools actions, then Add a runtime, then Connect an agent last as the one gold action", async () => {
    await renderArea();
    expect(actions()).toEqual([
      "Import a provider",
      "New tool",
      "Add a runtime",
      "Connect an agent",
    ]);
    const connect = within(header()).getByRole("link", {
      name: "Connect an agent",
    });
    expect(connect).toHaveAttribute(
      "href",
      "/acme/core-platform/register/name",
    );
    expect(golds()).toEqual([connect]);
  });

  it("adds Flip a kill switch on Off switches alone, before Add a runtime", async () => {
    await renderArea("switches");
    expect(actions()).toEqual([
      "Import a provider",
      "New tool",
      "Flip a kill switch",
      "Add a runtime",
      "Connect an agent",
    ]);
    expect(golds().map((node) => node.textContent)).toEqual([
      "Connect an agent",
    ]);
  });

  it.each(["agents", "servers", "tools", "toolbelts", "policies", "runtimes"] as const)(
    "carries no Flip a kill switch on the %s tab",
    async (tab) => {
      await renderArea(tab);
      expect(
        within(header()).queryByTestId("tools-flip-open"),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["member", "billing", "compliance"] as const)(
    "offers an org %s only Connect an agent (negative)",
    async (role) => {
      await renderArea("switches", {}, viewer(role));
      expect(actions()).toEqual(["Connect an agent"]);
      expect(golds().map((node) => node.textContent)).toEqual([
        "Connect an agent",
      ]);
    },
  );

  it("offers an org Admin every action an Owner has", async () => {
    await renderArea("switches", {}, viewer("admin"));
    expect(actions()).toEqual([
      "Import a provider",
      "New tool",
      "Flip a kill switch",
      "Add a runtime",
      "Connect an agent",
    ]);
  });
});

describe("Agents page › tabs", () => {
  it("draws the five tabs in order as a tablist of ?tab= links, Agents on the bare path and selected", async () => {
    await renderArea();
    const all = tabs();
    expect(all.map((tab) => tab.getAttribute("href"))).toEqual([
      "/acme/core-platform/agents",
      "/acme/core-platform/agents?tab=servers",
      "/acme/core-platform/agents?tab=policies",
      "/acme/core-platform/agents?tab=runtimes",
      "/acme/core-platform/agents?tab=switches",
    ]);
    expect(all.map((tab) => tab.firstChild?.textContent)).toEqual([
      "Agents",
      "Tool servers",
      "Policies",
      "Runtimes",
      "Off switches",
    ]);
    expect(all.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "id",
      "agents-panel-agents",
    );
  });

  it.each([
    ["servers", 1],
    ["tools", 1],
    ["toolbelts", 1],
    ["policies", 2],
    ["runtimes", 3],
    ["switches", 4],
  ] as const)(
    "selects the tab ?tab=%s lights, and only it",
    async (tab, index) => {
      await renderArea(tab);
      const selected = tabs().map(
        (node) => node.getAttribute("aria-selected") === "true",
      );
      expect(selected).toEqual([0, 1, 2, 3, 4].map((i) => i === index));
      expect(tabs()[index]).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("tabpanel")).toHaveAttribute(
        "id",
        `agents-panel-${areaTabOf(tab)}`,
      );
    },
  );

  it("counts the providers on Tool servers and the switches denying on Off switches, and nothing on the other three", async () => {
    await renderArea();
    const [agents, servers, policies, runtimes, switches] = tabs();
    expect(servers).toHaveTextContent(/^Tool servers2$/);
    const on = element(
      switches?.querySelector('[data-count="switches"]'),
      "switch count",
    );
    expect(on).toHaveTextContent("1 on");
    // A switch denying waits on a person, so its count is drawn in the error ink.
    expect(on).toHaveClass("text-error-ink");
    for (const plain of [agents, policies, runtimes])
      expect(element(plain, "tab").children).toHaveLength(0);
  });

  it("draws no error ink when no switch is denying", async () => {
    await renderArea("agents", {
      killSwitches: readOk(killSwitchBoard({ switches: [] })),
    });
    const on = element(
      document.querySelector('[data-count="switches"]'),
      "switch count",
    );
    expect(on).toHaveTextContent("0 on");
    expect(on).not.toHaveClass("text-error-ink");
  });

  it("marks the switch count as a floor when the board came back full", async () => {
    await renderArea("agents", {
      killSwitches: readOk(killSwitchBoard({}, 3)),
    });
    expect(document.querySelector('[data-count="switches"]')).toHaveTextContent(
      "1 or more on",
    );
  });

  it("prints no count a read did not answer, rather than a zero (negative)", async () => {
    await renderArea("agents", {
      mcpServers: readError("tool_registry_unavailable", 503),
      killSwitches: readError("tool_registry_unavailable", 503),
    });
    const [, servers, , , switches] = tabs();
    expect(servers).toHaveTextContent(/^Tool servers$/);
    expect(switches).toHaveTextContent(/^Off switches$/);
    expect(document.querySelector('[data-count="switches"]')).toBeNull();
  });
});

describe("Agents page › bodies", () => {
  it("draws the agents table on Agents, read at the URL's cursor", async () => {
    const calls = await renderArea("agents", {}, owner, { cursor: "c2" });
    expect(
      screen.getByRole("table", { name: "Agents registered in Core platform" }),
    ).toBeInTheDocument();
    expect(calls.agents).toEqual([
      [owner, { cursor: "c2", includeRetired: false }],
    ]);
  });

  it("lists retired agents on Agents when the URL asks for them", async () => {
    const calls = await renderArea("agents", {}, owner, {
      deregistered: "show",
    });
    expect(calls.agents).toEqual([
      [owner, { cursor: null, includeRetired: true }],
    ]);
  });

  it("draws the servers list under the views row on Tool servers", async () => {
    await renderArea("servers");
    const row = screen.getByRole("navigation", { name: "Tool server views" });
    expect(
      within(row).getByRole("link", { current: "page" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents?tab=servers");
    expect(screen.getByRole("table", { name: "Providers" })).toBeInTheDocument();
  });

  it("draws the registry on ?tab=tools and the toolbelts on ?tab=toolbelts", async () => {
    await renderArea("tools");
    expect(screen.getByRole("table", { name: "Tools" })).toBeInTheDocument();
    document.body.replaceChildren();
    await renderArea("toolbelts");
    expect(screen.getByRole("region", { name: "Toolbelts" })).toBeInTheDocument();
  });

  it("draws the policy versions and the ledger on Policies", async () => {
    await renderArea("policies");
    expect(
      screen.getByRole("region", { name: "Policy versions" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Tool server views" }),
    ).toBeNull();
  });

  it("draws the hosts on Runtimes, and reads no agents", async () => {
    const calls = await renderArea("runtimes");
    expect(screen.getByTestId("runtimes-tiles")).toBeInTheDocument();
    expect(calls.agents).toEqual([]);
  });

  it("draws the switch board on Off switches", async () => {
    await renderArea("switches");
    expect(
      screen.getByRole("region", { name: /Class switches/ }),
    ).toBeInTheDocument();
  });
});

describe("Agents page › a body that cannot be read", () => {
  it("keeps the header and the strip when the agents read fails", async () => {
    await renderArea("agents", {
      agents: readError("iam_principals_unavailable", 503),
    });
    expect(screen.getByTestId("agents-error")).toBeInTheDocument();
    expect(
      within(header()).getByRole("heading", { level: 1, name: "Agents" }),
    ).toBeInTheDocument();
    expect(tabs()).toHaveLength(5);
  });

  it("keeps the header and the strip when the registry read is denied on Tool servers", async () => {
    await renderArea("servers", {
      versions: { ok: false, reason: "denied", permission: "tools.read" },
    });
    expect(screen.getByTestId("tools-denied")).toBeInTheDocument();
    expect(tabs()).toHaveLength(5);
    expect(actions().at(-1)).toBe("Connect an agent");
  });

  it("keeps the header and the strip when the runtimes read fails", async () => {
    const { source } = toolsSource({ agents: agentPage([agentRow()]) });
    source.runtimes = runtimesSource({
      list: readError("collector_unreachable", 503),
    }).source.runtimes;
    await renderPage(
      await AgentsArea({
        ctx: owner,
        source,
        tab: "runtimes",
        searchParams: {},
        viewerName: "Marcus Bell",
      }),
    );
    expect(screen.getByTestId("runtimes-error")).toBeInTheDocument();
    expect(tabs()).toHaveLength(5);
  });

  it("shows the empty state on Tool servers when no provider is registered, under the same header", async () => {
    await renderArea("servers", {
      versions: readOk(toolVersionPage({ items: [], nextCursor: null })),
      mcpServers: readOk(mcpServerList({ servers: [] })),
    });
    expect(screen.getByTestId("tools-empty")).toBeInTheDocument();
    expect(tabs()).toHaveLength(5);
    // The roster answered with none, so the tab counts a zero it can stand behind.
    expect(tabs()[1]).toHaveTextContent(/^Tool servers0$/);
    // The empty state's Import a provider is drawn in the default style.
    expect(
      [...document.querySelectorAll('[class*="bg-button-primary-bg"]')].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Connect an agent"]);
  });
});
