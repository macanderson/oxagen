// @vitest-environment jsdom
// One agent over a fake DataSource (spec pages/agent.md): the header and its
// badges, the seven tabs with their live counts and the rev1 aliases, the
// not-loaded states, and each tab's panels in the design's order, with what
// the record does not hold named rather than drawn as a zero. Axe runs after
// every test. The Toolbelt tab's interactive panels, the mandates panel and
// the belt and runtime controls (ADR-198) have their own files.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";
import {
  agentDetail,
  agentsSource,
  incident,
  incidentPage,
  roleCatalog,
  runPage,
  runRow,
  spendBudgets,
  spendFindings,
  spendReport,
  spendRow,
  steeringDeliveries,
  toolbelt,
} from "./agents.builders";

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
vi.mock("./actions", () => ({
  retireAgent: vi.fn(),
  rotateAgentCredential: vi.fn(),
  setAgentSuspended: vi.fn(),
  pauseAgent: vi.fn(),
  readAssignableRoles: vi.fn(),
  assignAgentRole: vi.fn(),
  revokeAgentRole: vi.fn(),
  readCostCenters: vi.fn(),
  setAgentCostCenter: vi.fn(),
  revokeHostEnrollment: vi.fn(),
  issueAgentEnrollmentToken: vi.fn(),
  moveAgent: vi.fn(),
  assignAgentToolbelt: vi.fn(),
  requestMandate: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
// The Configuration tab's tool pickers read the registry's patterns on mount
// when the file already names tools. An empty list draws each chip by its value.
vi.mock("@/features/shell/client", () => ({
  chooseToolPatterns: vi.fn(() =>
    Promise.resolve({ ok: true, value: { options: [], partial: false } }),
  ),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Agent } = await import("./agent");

const CTX_FIELDS = {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
} as const;

const ctx = unsafeMint(WsCtx, CTX_FIELDS);

type Reads = Parameters<typeof agentsSource>[0];

/** Every read the page can make, answered; a test overrides what it is about. */
function allReads(overrides: Reads = {}): Reads {
  return {
    get: readOk(agentDetail()),
    toolbelt: readOk(toolbelt()),
    mandates: mandateList([]),
    incidents: incidentPage([incident()]),
    runs: runPage([runRow()]),
    spend: spendReport([spendRow()]),
    deliveries: steeringDeliveries(),
    findings: spendFindings([{}]),
    budgets: readOk(spendBudgets()),
    roles: roleCatalog(),
    ...overrides,
  };
}

async function renderAgent(
  reads: Reads = {},
  tab: string | null = null,
  viewer = ctx,
) {
  const { source, calls } = agentsSource(allReads(reads));
  const element = await Agent({
    ctx: viewer,
    source,
    agent: "release-bot",
    tab,
    cursor: null,
  });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

const region = (name: string) => screen.getByRole("region", { name });
const tabs = () =>
  within(screen.getByRole("tablist", { name: "Agent sections" })).getAllByRole(
    "tab",
  );
const selected = () =>
  tabs()
    .filter((tab) => tab.getAttribute("aria-selected") === "true")
    .map((tab) => tab.getAttribute("data-tab"));

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Agent header", () => {
  it("draws the eyebrow, the agent card, the four recorded badges, the description and the writes", async () => {
    const calls = await renderAgent();
    expect(calls.get).toEqual([[ctx, "release-bot"]]);
    const header = screen.getByTestId("agent-header");
    expect(within(header).getByText("Agent")).toBeInTheDocument();
    expect(within(header).getByRole("heading", { level: 1 })).toHaveTextContent(
      "acme.core.release-bot",
    );
    const badges = screen.getByTestId("agent-badges");
    expect(badges).toHaveTextContent("enrolled");
    // The tier badge prints the tier's own word, with the longer reading on
    // hover, as the mockup's `tierBadge` draws it on every page.
    expect(badges).toHaveTextContent("harness");
    expect(within(badges).getByText("harness")).toHaveAttribute(
      "title",
      "observed at the harness",
    );
    expect(badges).toHaveTextContent("replay fork");
    expect(badges).toHaveTextContent("operator Marcus Bell");
    expect(header).toHaveTextContent(
      "Cuts releases and opens their pull requests.",
    );
    const labels = within(screen.getByTestId("agent-header-actions"))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels.slice(0, 4)).toEqual([
      "Edit avatar",
      "Rotate credential",
      "Suspend",
      "Deregister",
    ]);
    // No gold on this page: the one gold action of the workspace is on Agents.
    expect(
      within(header)
        .getAllByRole("button")
        .filter((b) => b.className.includes("bg-button-primary-bg")),
    ).toEqual([]);
  });

  it("says not recorded for the tier, replay and operator when no run of the agent is read (negative)", async () => {
    await renderAgent({ runs: runPage([]) });
    const badges = screen.getByTestId("agent-badges");
    expect(badges).toHaveTextContent("tier not recorded");
    expect(badges).toHaveTextContent("replay not recorded");
    expect(badges).toHaveTextContent("operator not recorded");
  });

  it("opens Edit avatar as a sheet that says no store holds an avatar yet", async () => {
    await renderAgent();
    await userEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
    expect(screen.getByTestId("edit-avatar-sheet")).toHaveTextContent(
      "No store holds an agent avatar yet",
    );
  });
});

describe("Agent tabs", () => {
  it("draws the seven tabs in order as a tablist of links, Overview selected by default", async () => {
    await renderAgent();
    expect(
      tabs().map((tab) => [
        tab.firstChild?.textContent,
        tab.getAttribute("href"),
      ]),
    ).toEqual(
      [
        ["Overview", "overview"],
        ["Identity", "identity"],
        ["Steering", "steering"],
        ["Toolbelt", "toolbelt"],
        ["Runtime", "runtime"],
        ["Permissions", "permissions"],
        ["Activity", "activity"],
      ].map(([label, id]) => [
        label,
        `/acme/core-platform/agents/release-bot/${String(id)}`,
      ]),
    );
    expect(selected()).toEqual(["overview"]);
  });

  it("counts the belt width and the tamper incidents, and draws no badge for zero mandates", async () => {
    await renderAgent();
    expect(screen.getByTestId("tab-count-toolbelt")).toHaveTextContent("2");
    expect(screen.getByTestId("tab-count-activity")).toHaveTextContent("1");
    expect(screen.queryByTestId("tab-count-permissions")).toBeNull();
  });

  it("counts no tamper for an incident that is not tamper (negative)", async () => {
    await renderAgent({
      incidents: incidentPage([incident({ kind: "telemetry_gap" })]),
    });
    expect(screen.queryByTestId("tab-count-activity")).toBeNull();
  });

  it.each([
    ["mandates", "permissions"],
    ["budgets", "permissions"],
    ["runs", "activity"],
    ["incidents", "activity"],
    ["enrollment", "runtime"],
    // The definition file went with ADR-198; a link to it lands on Toolbelt.
    ["definition", "toolbelt"],
    ["no-such-tab", "overview"],
  ])("lands the rev1 id %s on %s", async (alias, tab) => {
    await renderAgent({}, alias);
    expect(selected()).toEqual([tab]);
  });
});

describe("Agent not-loaded states", () => {
  it("is a 404 for an agent the workspace does not have (negative)", async () => {
    const { source } = agentsSource({ get: readError("not_found", 404) });
    await expect(
      Agent({ ctx, source, agent: "nobody", tab: null, cursor: null }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("replaces the body with the denied state, naming the permission (negative)", async () => {
    await renderAgent({
      get: { ok: false, reason: "denied", permission: "agent.read" },
    });
    const denied = screen.getByTestId("agent-denied");
    expect(denied).toHaveTextContent("You cannot see this agent");
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include agent.read on core-platform.",
    );
    expect(denied).toHaveTextContent("Signed in as");
    expect(denied).toHaveTextContent("Decided by");
    expect(
      within(denied).getByRole("button", { name: "Request access" }),
    ).toBeVisible();
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("replaces the body with the error state, naming the code (negative)", async () => {
    await renderAgent(
      { get: readError("iam_principals_unavailable", 503) },
      "identity",
    );
    const error = screen.getByTestId("agent-error");
    expect(error).toHaveTextContent("This agent could not be loaded");
    expect(error).toHaveTextContent(
      "The control plane answered 503 iam_principals_unavailable. Nothing was changed.",
    );
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/identity",
    );
    expect(
      within(error).getByRole("button", { name: "Open an incident" }),
    ).toBeVisible();
    expect(screen.getByTestId("state-trace")).toHaveTextContent(
      "503 iam_principals_unavailable · read at",
    );
  });

  it("shows the never-run state on Overview for an enrolled agent with no frame, keeping the header and tabs", async () => {
    await renderAgent({
      get: readOk(agentDetail({ identity: { firstFrameAt: null } })),
    });
    const empty = screen.getByTestId("agent-empty");
    expect(empty).toHaveTextContent("This agent has never run");
    expect(empty).toHaveTextContent(
      "It is registered and enrolled, but no frame has arrived. Its belt is computed at run start, so there is nothing yet to show for tools either.",
    );
    expect(
      within(empty).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    expect(screen.getByTestId("agent-header")).toBeInTheDocument();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });
});

describe("Agent never-run rule", () => {
  it("shows the never-run state for an unenrolled identity that still has a host and no frame", async () => {
    await renderAgent({
      get: readOk(
        agentDetail({ identity: { firstFrameAt: null, status: "unenrolled" } }),
      ),
    });
    expect(screen.getByTestId("agent-empty")).toBeInTheDocument();
  });

  it("draws the Overview for a registered identity with no host, no enrollment and no frame (negative)", async () => {
    await renderAgent({
      get: readOk(
        agentDetail({
          identity: { firstFrameAt: null, status: "unenrolled" },
          hosts: [],
        }),
      ),
    });
    expect(screen.queryByTestId("agent-empty")).toBeNull();
    expect(screen.getByTestId("agent-overview")).toBeInTheDocument();
  });
});

describe("Overview", () => {
  it("draws the 30-day token use from the agent's own rollup, and the input classes as not recorded", async () => {
    const calls = await renderAgent();
    expect(calls.spend).toHaveLength(1);
    const panel = region("30-day token use");
    expect(screen.getByTestId("token-badge")).toHaveTextContent(
      "6,000 tok · $12.50 · gateway_observed",
    );
    const classes = within(screen.getByTestId("token-classes")).getAllByRole(
      "listitem",
    );
    expect(classes.map((li) => li.getAttribute("data-class"))).toEqual([
      "conversation",
      "toolResults",
      "contextFrames",
      "toolDefinitions",
      "steering",
      "system",
      "output",
      "reasoning",
    ]);
    expect(classes[0]).toHaveTextContent("Conversationnot recorded");
    expect(classes[6]).toHaveTextContent("Output800");
    expect(panel).toHaveTextContent("Cache hit rate60%");
    expect(panel).toHaveTextContent("Basisobserved by the gateway proxy");
  });

  it("says the rollup holds no row rather than drawing zeros (negative)", async () => {
    await renderAgent({ spend: spendReport([]) });
    expect(region("30-day token use")).toHaveTextContent(
      "The 30-day rollup holds no row for this agent.",
    );
    expect(screen.queryByTestId("token-badge")).toBeNull();
  });

  it("names coaching as waiting on the token classes and links the workspace's coaching", async () => {
    await renderAgent();
    const coaching = region("Coaching");
    expect(within(coaching).getByTestId("not-backed")).toHaveAttribute(
      "data-gap",
      "G3",
    );
    expect(
      within(coaching).getByRole("link", {
        name: "All coaching for this workspace →",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/spend");
  });

  it("badges the composition with the health verdict and opens each row's owner", async () => {
    await renderAgent({ incidents: incidentPage([]) });
    const composition = region("Composition");
    expect(composition).toHaveTextContent("healthy");
    expect(composition).toHaveTextContent("prn_91");
    expect(composition).toHaveTextContent("6 items · 2,600 tok");
    expect(composition).toHaveTextContent("build-01");
    expect(composition).toHaveTextContent("Marcus Bell");
    expect(composition).toHaveTextContent("1 role · no mandate");
    expect(
      within(composition)
        .getAllByRole("link", { name: "Open" })
        .map((a) => a.getAttribute("href")),
    ).toEqual(
      ["identity", "steering", "toolbelt", "runtime", "permissions"].map(
        (tab) => `/acme/core-platform/agents/release-bot/${tab}`,
      ),
    );
  });

  it("badges an open tamper incident as tamper (negative)", async () => {
    await renderAgent();
    expect(within(region("Composition")).getByText("tamper")).toHaveAttribute(
      "data-health",
      "tamper",
    );
  });

  it("draws the last 30 days with its link, and the agent's versions (ADR-198)", async () => {
    await renderAgent();
    const last30 = region("Last 30 days");
    expect(last30).toHaveTextContent("Runs4");
    expect(last30).toHaveTextContent("Tokens6,000");
    expect(
      within(last30).getByRole("link", { name: "Open activity" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/activity",
    );
    const versions = region("Versions");
    expect(within(versions).getAllByTestId("agent-version")).toHaveLength(1);
    expect(versions).toHaveTextContent("Registered");
    expect(versions).toHaveTextContent("Build box");
    expect(versions).toHaveTextContent("All tools");
    expect(
      screen.queryByRole("region", { name: "Definition in git" }),
    ).toBeNull();
  });

  it("names the belt the agent carries and the runtime it runs on in Composition", async () => {
    await renderAgent();
    const composition = region("Composition");
    expect(
      within(composition).getByTestId("composition-belt"),
    ).toHaveTextContent("All tools");
    expect(
      within(composition).getByTestId("composition-runtime"),
    ).toHaveTextContent("Build box");
  });
});

describe("Toolbelt and Runtime controls (ADR-198)", () => {
  it("offers the workspace's belts on the Toolbelt tab with the current one chosen", async () => {
    const calls = await renderAgent({}, "toolbelt");
    expect(calls.belts).toHaveLength(1);
    const choice = region("Assigned toolbelt");
    expect(within(choice).getByTestId("agent-belt-current")).toHaveTextContent(
      "It carries All tools.",
    );
    expect(
      within(choice).getByRole("radio", { name: /All tools/ }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(choice).getByRole("radio", { name: /Review belt/ }),
    ).toBeInTheDocument();
  });

  it("offers the runtimes on the Runtime tab, the current one and a runtime already running the harness disabled", async () => {
    const calls = await renderAgent({}, "runtime");
    expect(calls.runtimes).toHaveLength(1);
    const move = region("Runtime placement");
    expect(
      within(move).getByRole("radio", { name: /Build box/ }),
    ).toHaveAttribute("aria-disabled", "true");
    const taken = within(move).getByRole("radio", { name: /Mac's laptop/ });
    expect(taken).toHaveAttribute("aria-disabled", "true");
    expect(taken).toHaveAccessibleDescription(
      "Claude Code already runs on Mac's laptop as mac-claude.",
    );
    expect(
      within(move).getByRole("radio", { name: /GPU box/ }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("shows a member the binding and no control (negative)", async () => {
    await renderAgent(
      {},
      "toolbelt",
      unsafeMint(WsCtx, { ...CTX_FIELDS, orgRole: "member" }),
    );
    const choice = region("Assigned toolbelt");
    expect(within(choice).queryByRole("radiogroup")).toBeNull();
    expect(choice).toHaveTextContent(
      "An organization owner or admin can change it.",
    );
  });

  it("reads neither the belts nor the runtimes off their tabs", async () => {
    const calls = await renderAgent({}, "identity");
    expect(calls.belts).toEqual([]);
    expect(calls.runtimes).toEqual([]);
  });
});

describe("Identity", () => {
  it("draws the four panels in order with the principal's facts", async () => {
    await renderAgent({}, "identity");
    const facts = region("Identity");
    expect(facts).toHaveTextContent("Agent keyacme.core.release-bot");
    expect(facts).toHaveTextContent("Principalprn_91");
    expect(facts).toHaveTextContent("RuntimeBuild box build-box");
    expect(facts).toHaveTextContent("OperatorMarcus Bell");
    expect(facts).toHaveTextContent(
      "Deregistering retires the principal and never deletes it",
    );
    const credentials = region("Credentials");
    expect(
      within(screen.getByTestId("credential-pairs"))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "API keynone",
      "OAuth tokennone",
      "Cloud rolenone",
      "GitHub tokennone",
      "Run tokenone, and it reaches Oxagen only",
    ]);
    expect(
      within(credentials).getByRole("link", {
        name: "See the connections that mint them",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/tools/providers");
    const run = region("Run credential");
    expect(run).toHaveTextContent("oxa_ag_7f…");
    expect(run).toHaveTextContent("Purpose locknot recorded");
    expect(run).toHaveTextContent("sha256:ab12cd34");
    expect(
      within(run).getByRole("button", { name: "Revoke credential" }),
    ).toHaveAttribute("data-stub", "agent_credential_revoke");
    const trust = region("Trust relationships");
    expect(trust).toHaveTextContent("subagents narrow, never widen");
    expect(trust).toHaveTextContent("1 · hooks_removed");
    expect(
      within(trust).getByRole("link", { name: "Read them" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/activity",
    );
    expect(
      within(trust).getByRole("link", { name: "Open its permissions" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/permissions",
    );
  });

  it("marks a credential whose expiry has passed as expired, never active (negative)", async () => {
    const [credential] = agentDetail().credentials;
    await renderAgent(
      {
        get: readOk(
          agentDetail({
            credentials: credential
              ? [{ ...credential, expiresAt: "2020-01-01T10:00:00.000Z" }]
              : [],
          }),
        ),
      },
      "identity",
    );
    const run = region("Run credential");
    expect(run).toHaveTextContent("expired");
    expect(run).not.toHaveTextContent("active");
  });
});

describe("Steering", () => {
  it("draws the two meters and the two tables from the newest manifest, naming what is not stored", async () => {
    await renderAgent({}, "steering");
    expect(screen.getByTestId("steering-budget")).toHaveTextContent(
      "2,600 of 4,000 tok",
    );
    expect(screen.queryByTestId("steering-observe")).toBeNull();
    const reaches = region("What reaches this agent");
    expect(
      within(reaches)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Item",
      "Kind",
      "Force",
      "Scope",
      "Body",
      "Source",
      "Where it lands",
      "Token cost",
    ]);
    expect(
      within(reaches).getByRole("link", { name: "Change what is assigned" }),
    ).toHaveAttribute("href", "/acme/core-platform/steering");
    expect(region("Cut for this agent")).toHaveTextContent("3 cut");
  });

  it("warns on the observe tier that nothing below reaches the agent", async () => {
    await renderAgent(
      { runs: runPage([runRow({ enforcementTier: "observe" })]) },
      "steering",
    );
    expect(screen.getByTestId("steering-observe")).toHaveTextContent(
      "Nothing below reaches this agent today.",
    );
  });

  it("is one panel with Open the library when nothing is assembled (negative)", async () => {
    await renderAgent({ deliveries: steeringDeliveries([]) }, "steering");
    const empty = screen.getByTestId("steering-empty");
    expect(empty).toHaveTextContent("No steering is assembled for this agent");
    expect(
      within(empty).getByRole("link", { name: "Open the library" }),
    ).toHaveAttribute("href", "/acme/core-platform/steering");
  });
});

describe("Runtime", () => {
  it("draws the host from its enrollment and marks this agent's rung on the ladder", async () => {
    await renderAgent({}, "runtime");
    const host = screen.getByTestId("host-panel");
    expect(host).toHaveTextContent("build-01");
    expect(host).toHaveTextContent("sha256:ab12cd34");
    expect(host).toHaveTextContent("Hook binarynot recorded");
    const ladder = screen.getByRole("list", {
      name: "Enforcement tiers, weakest first",
    });
    expect(
      within(ladder)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("data-rung")),
    ).toEqual(["observe", "harness", "gateway", "contained"]);
    expect(
      within(ladder)
        .getAllByRole("listitem")
        .filter((li) => li.getAttribute("aria-current") === "step")
        .map((li) => li.getAttribute("data-rung")),
    ).toEqual(["harness"]);
    expect(screen.getByTestId("unenroll-command")).toHaveTextContent(
      "oxagen agent unenroll",
    );
    expect(
      screen.getByRole("button", { name: "Unenroll build-01" }),
    ).toBeVisible();
  });

  it("is the empty state with Wrap it and Show the CLI path when no host is enrolled (negative)", async () => {
    await renderAgent({ get: readOk(agentDetail({ hosts: [] })) }, "runtime");
    const empty = screen.getByTestId("runtime-empty");
    expect(empty).toHaveTextContent("No runtime is enrolled for this agent");
    expect(within(empty).getByRole("link", { name: "Wrap it" })).toBeVisible();
    expect(
      within(empty).getByRole("button", { name: "Show the CLI path" }),
    ).toBeVisible();
    // Enrolling needs the CLI on the host, and the app is what installs it.
    expect(
      within(screen.getByTestId("agent-runtime-tab")).getByRole("link", {
        name: ".deb (Debian, Ubuntu)",
      }),
    ).toHaveAttribute(
      "href",
      "https://downloads.oxagen.sh/latest/Oxagen_amd64.deb",
    );
  });
});

describe("Permissions", () => {
  it("draws the roles with their permissions, the ceilings and no mandate with its denial chain", async () => {
    const calls = await renderAgent({}, "permissions");
    expect(calls.roles).toHaveLength(1);
    expect(calls.budgets).toHaveLength(1);
    const roles = region("Roles");
    expect(roles).toHaveTextContent("repo.write · pr.open");
    expect(roles).toHaveTextContent("Resource scopenot recorded");
    // The agent's own budget is on its version, which get_agent does not return (ADR-198).
    expect(roles).toHaveTextContent("Spend ceilingnot recorded");
    expect(roles).toHaveTextContent(
      "Can move moneynono mandate, so a financial call is denied before dispatch",
    );
    expect(roles).toHaveTextContent("Assigning a toolbelt grants nothing.");
    expect(
      within(roles).getByRole("button", { name: "Assign a role" }),
    ).toBeVisible();
    expect(
      within(region("Budgets")).queryByRole("link", { name: "Set budget" }),
    ).toBeNull();
    expect(screen.getByTestId("denial-chain")).toHaveTextContent("no_mandate");
    expect(screen.getByTestId("mandate-badge")).toHaveTextContent(
      "cannot move money",
    );
  });

  it("measures no run against the per-run ceiling when the runs could not be read (negative)", async () => {
    await renderAgent(
      { runs: readError("runs_unavailable", 503) },
      "permissions",
    );
    expect(region("Budgets")).toHaveTextContent(
      "no priced run of this agent on the newest page of runs",
    );
  });

  it("offers no role writes to an organization Member (negative)", async () => {
    await renderAgent(
      {},
      "permissions",
      unsafeMint(WsCtx, { ...CTX_FIELDS, orgRole: "member" }),
    );
    expect(screen.queryByRole("button", { name: "Assign a role" })).toBeNull();
  });
});

describe("Activity", () => {
  it("draws the runs, the token accounting, the last 30 days with a finding, and one panel per incident", async () => {
    const calls = await renderAgent({}, "activity");
    expect(calls.findings).toHaveLength(1);
    const runs = region("Runs");
    expect(
      within(runs)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Run", "Status", "Tokens", "Cost", "Frames", "Started"]);
    expect(
      within(runs).getByRole("link", { name: "arun_7k2m9q" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_7k2m9q");
    const accounting = region("Token accounting");
    expect(accounting).toHaveTextContent("Input, cache read3,000");
    expect(accounting).toHaveTextContent("Tool definitions");
    expect(accounting).toHaveTextContent("counted as input");
    const last30 = screen.getByTestId("agent-findings");
    expect(last30).toHaveTextContent("Duplicate tool calls");
    expect(
      within(last30).getByRole("link", { name: "Evidence" }),
    ).toBeVisible();
    expect(within(last30).getByRole("link", { name: "Fix" })).toBeVisible();
    const [panel] = screen.getAllByTestId("incident-panel");
    if (panel === undefined) throw new Error("no incident panel rendered");
    expect(panel).toHaveTextContent("hooks_removed");
    expect(panel).toHaveTextContent("Incidenttin_1");
    expect(
      within(panel).getByRole("link", { name: "Open on Audit" }),
    ).toHaveAttribute("href", "/acme/audit");
  });

  it("names the empty runs and incidents with their way out (negative)", async () => {
    await renderAgent(
      {
        runs: runPage([]),
        incidents: incidentPage([]),
        findings: spendFindings([]),
      },
      "activity",
    );
    const runs = screen.getByTestId("runs-empty");
    expect(runs).toHaveTextContent("It has 4 in the last 30 days");
    expect(
      within(runs).getByRole("link", { name: "Open the audit record" }),
    ).toHaveAttribute("href", "/acme/audit");
    const incidents = screen.getByTestId("incidents-empty");
    expect(incidents).toHaveTextContent("hooks_removed, config_change");
    expect(
      within(incidents).getByRole("link", {
        name: "Open the incident register",
      }),
    ).toBeVisible();
    expect(
      screen.getByText("No finding is open against this agent."),
    ).toBeVisible();
  });
});

describe("Agent tab bodies", () => {
  it("draws the Toolbelt tab from the belt read", async () => {
    await renderAgent({}, "toolbelt");
    expect(selected()).toEqual(["toolbelt"]);
    expect(screen.getByTestId("agent-toolbelt-tab")).toBeInTheDocument();
  });

  it("names the failed belt read on the Toolbelt tab and draws no count (negative)", async () => {
    await renderAgent(
      { toolbelt: readError("toolbelt_unavailable", 503) },
      "toolbelt",
    );
    expect(screen.queryByTestId("agent-toolbelt-tab")).toBeNull();
    expect(region("Toolbelt")).toHaveTextContent("toolbelt_unavailable");
    expect(screen.queryByTestId("tab-count-toolbelt")).toBeNull();
  });

  it.each(["admin", "billing"] as const)(
    "offers the cost-center write on Identity to an organization %s",
    async (orgRole) => {
      await renderAgent(
        {},
        "identity",
        unsafeMint(WsCtx, { ...CTX_FIELDS, orgRole }),
      );
      expect(
        screen.getByRole("button", { name: "Change cost center" }),
      ).toBeVisible();
    },
  );

  it("offers no cost-center write to a Member, or to an Owner on a retired agent (negative)", async () => {
    await renderAgent(
      {},
      "identity",
      unsafeMint(WsCtx, { ...CTX_FIELDS, orgRole: "member" }),
    );
    expect(
      screen.queryByRole("button", { name: "Change cost center" }),
    ).toBeNull();
    cleanup();
    await renderAgent(
      { get: readOk(agentDetail({ identity: { status: "retired" } })) },
      "identity",
    );
    expect(
      screen.queryByRole("button", { name: "Change cost center" }),
    ).toBeNull();
  });

  it("asks for no rollup and matches no run for an identity with no agent key (negative)", async () => {
    const calls = await renderAgent({
      get: readOk(agentDetail({ identity: { agentKey: null } })),
    });
    // The rollup is keyed by agent key, so it is not asked for at all.
    expect(calls.spend).toEqual([]);
    const badges = screen.getByTestId("agent-badges");
    expect(badges).toHaveTextContent("tier not recorded");
    expect(region("30-day token use")).toHaveTextContent(
      "The 30-day rollup holds no row for this agent.",
    );
  });

  it("says the runs could not be read on Activity and keeps the header standing (negative)", async () => {
    await renderAgent({ runs: readError("runs_unavailable", 503) }, "activity");
    expect(region("Runs")).toHaveTextContent("runs_unavailable");
    expect(screen.getByTestId("agent-badges")).toHaveTextContent(
      "tier not recorded",
    );
  });

  it("reads the incidents at the cursor on Activity only", async () => {
    const { source, calls } = agentsSource(allReads());
    const element = await Agent({
      ctx,
      source,
      agent: "release-bot",
      tab: "activity",
      cursor: "cur_2",
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(calls.incidents[0]?.[2]).toEqual({ cursor: "cur_2" });
  });

  it("counts the mandates in effect on the Permissions tab", async () => {
    await renderAgent({ mandates: mandateList([mandateRow()]) });
    expect(screen.getByTestId("tab-count-permissions")).toHaveTextContent("1");
  });

  it("draws no Activity count when the incidents could not be read (negative)", async () => {
    await renderAgent({ incidents: readError("tacho_unavailable", 503) });
    expect(screen.queryByTestId("tab-count-activity")).toBeNull();
  });

  it("replaces the body with the pending state while access waits on approval (negative)", async () => {
    await renderAgent({
      get: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_77",
      },
    });
    const pending = screen.getByTestId("agent-pending");
    expect(pending).toHaveTextContent("acr_77");
    expect(
      within(pending).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
