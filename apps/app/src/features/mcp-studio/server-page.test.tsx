// @vitest-environment jsdom
// A Studio server's page (#4678) on a fake DataSource. The page makes four
// reads and asks two seams. A failed registry read draws the Tools error in
// place of the page, and a server the workspace does not hold draws its own
// state. The header names the server and says who turned it off, with a
// toggle only for an org owner or admin and only when the switch board
// loaded. The tab strip marks the current tab, counts the tools the page
// lists and the draft's edits, and each tab draws in its own tabpanel. The
// findings seam is asked only on the Changes tab. The tab internals have
// their own suites; this one drives studio-tabs.tsx and not-recorded.tsx
// through the page. axe checks the state each test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";
import { readError, readOk } from "@/data/read";
// Type-only, so the `server-only` module is not pulled into the jsdom run.
import type { WsRole } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { StudioRecord } from "./model";
import type {
  ListStudioFindings,
  listStudioTools,
  StudioToolsList,
} from "./studio-calls";
import type { StudioTab } from "./route";
import type { RecordReader } from "./seams";

// The switch dialog's pickers read their lists through these server actions.
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
  cloneToolbelt: vi.fn(),
  updateToolbelt: vi.fn(),
  deleteToolbelt: vi.fn(),
  setToolState: vi.fn(),
}));
vi.mock("../tools/actions", () => actions);
// The Changes tab's Review calls go through Studio's own server actions, and
// the Tools tab's discovery section reads the server's discovery on mount,
// which answers "none yet" here.
vi.mock("./actions", () => ({
  saveStudioDraftAction: vi.fn(),
  saveNewStudioServerAction: vi.fn(),
  getStudioDraftAction: vi.fn(),
  openStudioReviewAction: vi.fn(),
  getStudioDiscoveryAction: vi.fn(() =>
    Promise.resolve({ ok: true, value: { discovery: null } }),
  ),
  startStudioDiscoveryAction: vi.fn(),
}));
// The Tools barrel also exports the OAuth callback route handler, which
// imports the completion action and two server-only Next modules.
vi.mock("../tools/provider-auth-actions", () => ({
  searchRegistry: vi.fn(),
  startProviderAuthorization: vi.fn(),
  completeProviderAuthorization: vi.fn(),
  providerRedirectUrl: vi.fn().mockResolvedValue({
    ok: true,
    value: { redirectUrl: "https://app.oxagen.sh/api/v1/mcp/oauth/callback" },
  }),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: vi.fn() }));

// Imported once, at module scope: the page pulls the Tools barrel in behind
// it, and paying that inside the first test would spend its time budget.
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { StudioLoading, StudioServer } = await import("./server-page");
const { STUDIO_TABS, studioHref } = await import("./route");
const {
  BILLING,
  FLIPPER,
  GITHUB,
  SCRATCH,
  STRIPE,
  WAREHOUSE,
  WAREHOUSE_PAGE_2,
  draftKey,
  findingsAnswer,
  idDraftKey,
  offSwitch,
  recordOf,
  seedDraft,
  studioBoard,
  studioFindings,
  studioMembers,
  studioSource,
  warehouseVersions,
} = await import("./studio.builders");

type Reads = NonNullable<Parameters<typeof studioSource>[0]>;
type FindingsCall = ListStudioFindings["call"];
type ToolsListCall = (typeof listStudioTools)["call"];

const AT = { org: "acme", ws: "core-platform" };

/** The roster's one member, by the public id a switch row names its flipper with. */
const DANA = "usr_01k5m1";

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

function withIntl(element: ReactNode) {
  return render(<IntlProvider>{element}</IntlProvider>);
}

/** The element or a failure naming what was missing: the tests assert, they never cast. */
function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}

/**
 * The page on the Studio fakes: each read answers its fixture unless `reads`
 * says otherwise, the record seam answers each server's record fixture unless
 * `record` says otherwise, list_studio_findings answers the three fixture
 * findings, and list_studio_tools refuses, so a test that wants the Tools
 * tab's counts passes an answer.
 */
async function renderStudio({
  serverId = STRIPE,
  tab = "tools",
  orgRole = "owner",
  wsRole = "member",
  reads = {},
  record = recordOf,
  findings = () => Promise.resolve(findingsAnswer()),
  toolsList = () =>
    Promise.resolve({ ok: false, reason: "failed", code: "denied" }),
}: {
  serverId?: string;
  tab?: StudioTab;
  orgRole?: OrgRole;
  wsRole?: WsRole;
  reads?: Reads;
  record?: (serverId: string) => StudioRecord | null;
  findings?: FindingsCall;
  toolsList?: ToolsListCall;
} = {}) {
  const ctx = viewer(orgRole, wsRole);
  const { source, calls } = studioSource(reads);
  const readRecord = vi.fn<RecordReader>((_ctx, server) =>
    Promise.resolve(record(server.id)),
  );
  const readFindings = vi.fn<FindingsCall>(findings);
  const readTools = vi.fn<ToolsListCall>(toolsList);
  withIntl(
    await StudioServer({
      ctx,
      source,
      route: { serverId, tab },
      readRecord,
      findings: { name: "list_studio_findings", call: readFindings },
      toolsList: { name: "list_studio_tools", call: readTools },
    }),
  );
  return { ctx, calls, readRecord, readFindings, readTools };
}

/** The handler's words for a tools.toml that did not compile. The page never shows them. */
const COMPILE_ERROR = "tools.toml line 3: expected '=' after key";

/** list_studio_tools' answer for Stripe as lane M10 will return it. */
function toolsListOf(over: Partial<StudioToolsList> = {}): StudioToolsList {
  return {
    server: "stripe",
    mcpServerId: null,
    snapshotId: null,
    capturedAt: null,
    exposure: { mode: "direct", budget: 8000 },
    tokens: { definitions: 1150, budget: 8000 },
    imported: 2,
    offered: 5,
    searchRecommended: true,
    compileError: COMPILE_ERROR,
    tools: [],
    ...over,
  };
}

/** The page's own header, not a section header inside a tab or a dialog. */
function pageHeader(): HTMLElement {
  return element(
    document.querySelector('[data-testid="studio-server"] > header'),
    "page header",
  );
}

function tabLink(tab: StudioTab): HTMLElement {
  return element(
    document.querySelector(`[role="tab"][data-tab="${tab}"]`),
    `${tab} tab`,
  );
}

function countOf(tab: StudioTab): string | null {
  const node = document.querySelector(`[data-count="${tab}"]`);
  return node === null ? null : node.textContent;
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    window.sessionStorage.clear();
  }
});

describe("StudioServer reads", () => {
  it("reads the registry page of this server alone, the board, the roster and the record once each, and no findings off the Changes tab", async () => {
    const { ctx, calls, readRecord, readFindings } = await renderStudio();
    expect(calls.mcpServers).toEqual([[ctx]]);
    expect(calls.versions).toEqual([
      [ctx, { category: null, cursor: null, serverId: STRIPE }],
    ]);
    expect(calls.killSwitches).toEqual([[ctx]]);
    expect(calls.members).toEqual([[ctx]]);
    expect(readRecord).toHaveBeenCalledTimes(1);
    expect(readRecord).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ id: STRIPE }),
    );
    expect(readFindings).not.toHaveBeenCalled();
    expect(screen.getByTestId("studio-server")).toBeInTheDocument();
  });

  it("reads the findings for this server on the Changes tab and lists them", async () => {
    const { readFindings } = await renderStudio({ tab: "changes" });
    expect(readFindings).toHaveBeenCalledTimes(1);
    expect(readFindings).toHaveBeenCalledWith(AT, { server: "stripe" });
    const findings = screen.getByTestId("studio-changes-findings");
    expect(within(findings).getAllByTestId("studio-finding")).toHaveLength(
      studioFindings().length,
    );
  });

  it.each([
    {
      answer: "a refusal",
      result: { ok: false, reason: "failed", code: "denied" },
    },
    {
      answer: "an unknown folder",
      result: { ok: false, reason: "failed", code: "not_found" },
    },
  ] as const)(
    "shows no findings when the call answers $answer",
    async ({ result }) => {
      const { readFindings } = await renderStudio({
        tab: "changes",
        findings: () => Promise.resolve(result),
      });
      expect(readFindings).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("studio-findings-missing")).toHaveAttribute(
        "data-gap",
        "#4678",
      );
      expect(screen.queryByTestId("studio-finding")).toBeNull();
    },
  );
});

describe("StudioServer tool counts", () => {
  it("asks list_studio_tools for this server on the Tools tab and shows its counts", async () => {
    const { readTools } = await renderStudio({
      toolsList: () => Promise.resolve({ ok: true, ...toolsListOf() }),
    });
    expect(readTools).toHaveBeenCalledTimes(1);
    expect(readTools).toHaveBeenCalledWith(AT, { server: "stripe" });
    const listed = screen.getByTestId("studio-tools-listed");
    expect(listed).toHaveTextContent(
      "2 imported of 5 the last discovery listed",
    );
    expect(within(listed).getByTestId("studio-tools-search")).toHaveTextContent(
      "These definitions would fit the budget better behind tool search.",
    );
    // The tab names the failure in its own words and never the handler's.
    expect(
      within(listed).getByTestId("studio-tools-compile-error"),
    ).toHaveTextContent("The server's tools.toml did not compile.");
    expect(listed).not.toHaveTextContent(COMPILE_ERROR);
  });

  it("leaves out the search note and the compile alert when neither applies", async () => {
    await renderStudio({
      toolsList: () =>
        Promise.resolve({
          ok: true,
          ...toolsListOf({ searchRecommended: false, compileError: null }),
        }),
    });
    const listed = screen.getByTestId("studio-tools-listed");
    expect(within(listed).queryByTestId("studio-tools-search")).toBeNull();
    expect(
      within(listed).queryByTestId("studio-tools-compile-error"),
    ).toBeNull();
  });

  it("asks nothing off the Tools tab", async () => {
    const { readTools } = await renderStudio({ tab: "changes" });
    expect(readTools).not.toHaveBeenCalled();
  });

  it("shows no counts when the read is refused", async () => {
    const { readTools } = await renderStudio();
    expect(readTools).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("studio-tools-listed")).toBeNull();
  });
});

describe("StudioServer failed reads", () => {
  it("draws the Tools error in place of the page when the server list fails, with a retry to this tab", async () => {
    await renderStudio({
      tab: "connection",
      reads: { mcpServers: readError("TOOLS_UNAVAILABLE", 503) },
    });
    const failure = screen.getByTestId("tools-error");
    expect(
      within(failure).getByRole("heading", { name: "Tools could not be loaded" }),
    ).toBeInTheDocument();
    expect(
      within(failure).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", studioHref(AT, STRIPE, "connection"));
    expect(screen.queryByTestId("studio-server")).toBeNull();
  });

  it("draws the Tools error in place of the page when the version page fails", async () => {
    await renderStudio({
      reads: { versions: readError("TOOLS_UNAVAILABLE", 503) },
    });
    const failure = screen.getByTestId("tools-error");
    expect(
      within(failure).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", studioHref(AT, STRIPE));
    expect(screen.queryByTestId("studio-server")).toBeNull();
  });

  it("draws the Tools error in place of the page when a later version page fails", async () => {
    const { calls } = await renderStudio({
      serverId: WAREHOUSE,
      reads: {
        versions: (query) =>
          query.cursor === null
            ? readOk(warehouseVersions())
            : readError("TOOLS_UNAVAILABLE", 503),
      },
    });
    expect(calls.versions).toHaveLength(2);
    const failure = screen.getByTestId("tools-error");
    expect(
      within(failure).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", studioHref(AT, WAREHOUSE));
    expect(screen.queryByTestId("studio-server")).toBeNull();
  });

  it("says a server the workspace does not hold is not found, and links back to the providers", async () => {
    await renderStudio({ serverId: "mcs_01k5zz" });
    const missing = screen.getByTestId("studio-missing");
    expect(
      within(missing).getByRole("heading", { name: "Server not found" }),
    ).toBeInTheDocument();
    expect(missing).toHaveTextContent(
      "This workspace holds no MCP server with that id. It may have been removed.",
    );
    expect(
      within(missing).getByRole("link", { name: "Back to providers" }),
    ).toHaveAttribute(
      "href",
      routes.tools(AT.org, AT.ws, { tab: "providers" }),
    );
    expect(screen.queryByTestId("studio-server")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("StudioServer header", () => {
  it("names the server and the workspace, and says what the page is for", async () => {
    await renderStudio();
    const header = pageHeader();
    expect(
      within(header).getByRole("heading", { level: 1, name: "Stripe" }),
    ).toBeInTheDocument();
    expect(within(header).getByText("Core platform")).toBeInTheDocument();
    expect(
      within(header).getByText(
        "Choose which of this server's tools agents can call, and how each one is described and shaped.",
      ),
    ).toBeInTheDocument();
  });

  it("says who turned the server off and back on, and offers an owner the toggle to deny it again", async () => {
    await renderStudio();
    const header = pageHeader();
    // The Tools fixture's server switch was cleared, so no badge says Off.
    expect(within(header).queryByTestId("studio-server-off")).toBeNull();
    const facts = within(header).getByTestId("studio-switch-facts-emd_01k5c3");
    expect(within(facts).getByText("Turned off by")).toBeInTheDocument();
    expect(within(facts).getByText("Reason")).toBeInTheDocument();
    expect(
      within(facts).getByText("The vendor rotated the manifest without a pin."),
    ).toBeInTheDocument();
    expect(within(facts).getByText("Turned back on by")).toBeInTheDocument();
    // The roster holds nobody by the id the fixture wrote, so the id stands.
    expect(within(facts).getAllByText(FLIPPER)).toHaveLength(2);
    const toggle = within(header).getByRole("switch", { name: "Deny Stripe" });
    expect(toggle).toHaveAttribute("data-testid", "tools-flip-emd_01k5c3");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("marks a server that is off with a badge, and offers the toggle to allow it again", async () => {
    await renderStudio({
      reads: {
        killSwitches: readOk(
          studioBoard([offSwitch("emd_01k5d2", "tool_server", STRIPE)]),
        ),
      },
    });
    const header = pageHeader();
    expect(within(header).getByTestId("studio-server-off")).toHaveTextContent(
      "Off",
    );
    const facts = within(header).getByTestId("studio-switch-facts-emd_01k5d2");
    expect(
      within(facts).getByText("Refunds ran twice in the sandbox."),
    ).toBeInTheDocument();
    expect(within(facts).queryByText("Turned back on by")).toBeNull();
    expect(
      within(header).queryByTestId("studio-switch-facts-emd_01k5c3"),
    ).toBeNull();
    const toggle = within(header).getByRole("switch", {
      name: "Allow Stripe again",
    });
    expect(toggle).toHaveAttribute("data-testid", "tools-flip-emd_01k5d2");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("names the member who turned the server off from the roster", async () => {
    await renderStudio({
      reads: {
        members: readOk(studioMembers()),
        killSwitches: readOk(
          studioBoard([
            {
              ...offSwitch("emd_01k5d2", "tool_server", STRIPE),
              flippedBy: DANA,
            },
          ]),
        ),
      },
    });
    const facts = within(pageHeader()).getByTestId(
      "studio-switch-facts-emd_01k5d2",
    );
    expect(within(facts).getByText("Dana Reyes")).toBeInTheDocument();
    expect(within(facts).queryByText(DANA)).toBeNull();
  });

  it("prints the flipper's id when the roster read fails, and still draws the page and its toggles", async () => {
    await renderStudio({
      reads: {
        members: readError("MEMBERS_UNAVAILABLE", 503),
        killSwitches: readOk(
          studioBoard([
            {
              ...offSwitch("emd_01k5d2", "tool_server", STRIPE),
              flippedBy: DANA,
            },
          ]),
        ),
      },
    });
    const header = pageHeader();
    const facts = within(header).getByTestId("studio-switch-facts-emd_01k5d2");
    expect(within(facts).getByText(DANA)).toBeInTheDocument();
    expect(within(facts).queryByText("Dana Reyes")).toBeNull();
    expect(
      within(header).getByRole("switch", { name: "Allow Stripe again" }),
    ).toBeInTheDocument();
  });

  it("says not recorded when the record names no flipper, and leaves out a reason nobody gave", async () => {
    await renderStudio({
      reads: {
        killSwitches: readOk(
          studioBoard([
            {
              ...offSwitch("emd_01k5d2", "tool_server", STRIPE),
              flippedBy: null,
              reason: "",
            },
          ]),
        ),
      },
    });
    const facts = within(pageHeader()).getByTestId(
      "studio-switch-facts-emd_01k5d2",
    );
    expect(within(facts).getByText("Turned off by")).toBeInTheDocument();
    expect(within(facts).getByText("not recorded")).toBeInTheDocument();
    expect(within(facts).queryByText("Reason")).toBeNull();
  });

  it("offers an admin a toggle aimed at a server with no switch yet, and no facts", async () => {
    await renderStudio({ serverId: BILLING, orgRole: "admin" });
    const header = pageHeader();
    expect(
      within(header).getByRole("heading", { level: 1, name: "Billing" }),
    ).toBeInTheDocument();
    const toggle = within(header).getByRole("switch", { name: "Deny Billing" });
    expect(toggle).toHaveAttribute(
      "data-testid",
      `tools-flip-tool_server-${BILLING}`,
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      header.querySelector('[data-testid^="studio-switch-facts-"]'),
    ).toBeNull();
    expect(within(header).queryByTestId("studio-server-off")).toBeNull();
  });
});

describe("StudioServer switch board", () => {
  it("adds no note when the board loaded whole", async () => {
    await renderStudio();
    expect(screen.queryByTestId("studio-board-failed")).toBeNull();
    expect(screen.queryByTestId("studio-board-truncated")).toBeNull();
  });

  it("says the board did not load and draws no toggle and no switch facts anywhere", async () => {
    await renderStudio({
      reads: { killSwitches: readError("BOARD_UNAVAILABLE", 503) },
    });
    expect(screen.getByTestId("studio-board-failed")).toHaveTextContent(
      "The kill switch board did not load, so this page cannot show which switches are on or turn one off.",
    );
    expect(screen.queryByTestId("studio-board-truncated")).toBeNull();
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(document.querySelector('[data-testid^="tools-flip-"]')).toBeNull();
    expect(
      document.querySelector('[data-testid^="studio-switch-facts-"]'),
    ).toBeNull();
    // The page itself still draws.
    expect(screen.getByTestId("studio-tools")).toBeInTheDocument();
  });

  it("says a switch may be missing when the board read came back full, and still draws the toggles", async () => {
    // The base board holds three switches, so a limit of three fills it.
    await renderStudio({ reads: { killSwitches: readOk(studioBoard([], 3)) } });
    expect(screen.getByTestId("studio-board-truncated")).toHaveTextContent(
      "The kill switch board holds more switches than one read returns, so a switch on this server may be missing here.",
    );
    expect(screen.queryByTestId("studio-board-failed")).toBeNull();
    expect(
      within(pageHeader()).getByRole("switch", { name: "Deny Stripe" }),
    ).toBeInTheDocument();
  });
});

describe("StudioServer tool switches", () => {
  it("gives an owner a toggle for each listed tool with a registry version, and none for a tool without one", async () => {
    await renderStudio();
    const payment = screen.getByTestId("studio-tool-create_payment");
    const toggle = within(payment).getByRole("switch", {
      name: "Deny create_payment",
    });
    expect(toggle).toHaveAttribute(
      "data-testid",
      "tools-flip-tool_version-tlv_01k5a1",
    );
    const customers = screen.getByTestId("studio-tool-list_customers");
    expect(within(customers).queryByRole("switch")).toBeNull();
    expect(within(customers).getByText("—")).toBeInTheDocument();
    // The server's toggle and create_payment's: no other listed tool has a version.
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });

  it("shows who turned a tool off in its panel, beside its toggle", async () => {
    await renderStudio({
      reads: {
        killSwitches: readOk(
          studioBoard([offSwitch("emd_01k5d1", "tool_version", "tlv_01k5a1")]),
        ),
      },
    });
    const row = screen.getByTestId("studio-tool-create_payment");
    expect(
      within(row).getByRole("switch", { name: "Allow create_payment again" }),
    ).toHaveAttribute("data-testid", "tools-flip-emd_01k5d1");
    // The row draws the toggle only; the facts wait for the panel.
    expect(
      within(row).queryByTestId("studio-switch-facts-emd_01k5d1"),
    ).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "create_payment" }));
    const panel = await screen.findByTestId("studio-tool-panel");
    const facts = within(panel).getByTestId("studio-switch-facts-emd_01k5d1");
    expect(within(facts).getByText("Turned off by")).toBeInTheDocument();
    expect(
      within(facts).getByText("Refunds ran twice in the sandbox."),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("switch", { name: "Allow create_payment again" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("draws no toggle for a member, marks a tool that is off, and still says who turned the server off", async () => {
    await renderStudio({
      orgRole: "member",
      reads: {
        killSwitches: readOk(
          studioBoard([offSwitch("emd_01k5d1", "tool_version", "tlv_01k5a1")]),
        ),
      },
    });
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(document.querySelector('[data-testid^="tools-flip-"]')).toBeNull();
    const row = screen.getByTestId("studio-tool-create_payment");
    expect(within(row).getByText("Off")).toBeInTheDocument();
    expect(within(row).queryByRole("checkbox")).toBeNull();
    expect(
      within(pageHeader()).getByTestId("studio-switch-facts-emd_01k5c3"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only an organization owner or admin, or a workspace owner or admin, can import tools or change their classification.",
      ),
    ).toBeInTheDocument();
  });
});

// The Definition of done of #5228: MCP Studio shows every workspace action to
// the workspace's Owner and Admin, whatever their org role. The actions are
// the off switches on the server and its tools and the import checkboxes on
// Tools, the credential form on Connection, and Open steering PR on Changes.
// A workspace Member whose org role is Member is offered none of them.
describe("StudioServer workspace Owner or Admin (#5228)", () => {
  /** Which workspace actions the Tools, Connection and Changes tabs offer. */
  async function offered(orgRole: OrgRole, wsRole: WsRole) {
    await renderStudio({ orgRole, wsRole });
    const tools = {
      switches: screen.queryAllByRole("switch").length,
      importTool: screen.queryByTestId("studio-import-create_payment") !== null,
    };
    cleanup();
    await renderStudio({ tab: "connection", orgRole, wsRole });
    const credential = screen.queryByTestId("studio-credential-form") !== null;
    cleanup();
    await renderStudio({ tab: "changes", orgRole, wsRole });
    const openPr = screen.queryByTestId("studio-pr-open") !== null;
    return { ...tools, credential, openPr };
  }

  it.each(["owner", "admin"] as const)(
    "offers every workspace action to the workspace's %s whose org role is Member",
    async (wsRole) => {
      expect(await offered("member", wsRole)).toEqual({
        // The server's switch and create_payment's, as an org Owner gets.
        switches: 2,
        importTool: true,
        credential: true,
        openPr: true,
      });
    },
  );

  it("offers none of them to a workspace Member whose org role is Member (negative)", async () => {
    expect(await offered("member", "member")).toEqual({
      switches: 0,
      importTool: false,
      credential: false,
      openPr: false,
    });
  });
});

describe("StudioServer tabs", () => {
  const PANELS: readonly { tab: StudioTab; landmark: string }[] = [
    { tab: "tools", landmark: "studio-tools" },
    { tab: "connection", landmark: "studio-connection" },
    { tab: "try", landmark: "studio-try" },
    { tab: "changes", landmark: "studio-changes" },
  ];

  it.each(PANELS)(
    "draws the $tab tab alone, in a tabpanel its tab labels and controls",
    async ({ tab, landmark }) => {
      await renderStudio({ tab });
      expect(
        screen.getByRole("tablist", { name: "Server sections" }),
      ).toBeInTheDocument();
      const panel = screen.getByRole("tabpanel");
      expect(panel).toHaveAttribute("id", "studio-panel");
      expect(panel).toHaveAttribute("aria-labelledby", tabLink(tab).id);
      expect(within(panel).getByTestId(landmark)).toBeInTheDocument();
      for (const other of PANELS) {
        if (other.tab !== tab) {
          expect(screen.queryByTestId(other.landmark)).toBeNull();
        }
      }
      for (const each of STUDIO_TABS) {
        const link = tabLink(each);
        expect(link).toHaveAttribute("role", "tab");
        expect(link).toHaveAttribute("href", studioHref(AT, STRIPE, each));
        // One selected state: a tab carries no `aria-current`.
        expect(link).not.toHaveAttribute("aria-current");
        if (each === tab) {
          expect(link).toHaveAttribute("aria-selected", "true");
          expect(link).toHaveAttribute("aria-controls", "studio-panel");
          expect(link).toHaveAttribute("tabindex", "0");
        } else {
          expect(link).toHaveAttribute("aria-selected", "false");
          expect(link).not.toHaveAttribute("aria-controls");
          expect(link).toHaveAttribute("tabindex", "-1");
        }
      }
    },
  );

  it("names the four tabs in order", async () => {
    await renderStudio();
    // The label is the link's first text; a count follows it in its own span,
    // and jsdom runs the two together in the accessible name.
    const names = STUDIO_TABS.map(
      (tab) => tabLink(tab).childNodes[0]?.textContent,
    );
    expect(names).toEqual(["Tools", "Connection", "Test", "Changes"]);
  });

  it("counts the tools the page lists, and no edits while the draft is empty", async () => {
    await renderStudio();
    expect(countOf("tools")).toBe("23");
    expect(countOf("changes")).toBeNull();
    expect(countOf("connection")).toBeNull();
    expect(countOf("try")).toBeNull();
  });

  it("counts the draft's edits once the draft holds one", async () => {
    seedDraft(draftKey("stripe"), {
      revision: 0,
      ops: [{ kind: "import", tool: "create_refund" }],
    });
    await renderStudio();
    expect(countOf("tools")).toBe("23");
    expect(countOf("changes")).toBe("1");
  });

  it("follows the server's registry cursor to the last page and counts every tool", async () => {
    const { calls, ctx } = await renderStudio({
      serverId: WAREHOUSE,
      tab: "connection",
    });
    expect(calls.versions).toEqual([
      [ctx, { category: null, cursor: null, serverId: WAREHOUSE }],
      [ctx, { category: null, cursor: WAREHOUSE_PAGE_2, serverId: WAREHOUSE }],
    ]);
    expect(countOf("tools")).toBe("600");
  });

  it("counts the versions on every registry page when the server has no record", async () => {
    await renderStudio({
      serverId: WAREHOUSE,
      tab: "connection",
      record: () => null,
    });
    expect(countOf("tools")).toBe("200");
  });

  it("stops at 20 registry pages and marks the Tools count as a floor", async () => {
    // A registry that always hands back a cursor: the page reads 20 pages,
    // 1,000 versions at list_tool_versions' default page size, and stops.
    const { calls } = await renderStudio({
      serverId: WAREHOUSE,
      tab: "connection",
      reads: { versions: readOk(warehouseVersions()) },
    });
    expect(calls.versions).toHaveLength(20);
    expect(countOf("tools")).toBe("600+");
  });

  it("counts zero tools for a server that offers none, and says so", async () => {
    await renderStudio({ serverId: SCRATCH });
    expect(countOf("tools")).toBe("0");
    const empty = screen.getByTestId("studio-tools-empty");
    expect(
      within(empty).getByRole("heading", { name: "No tools" }),
    ).toBeInTheDocument();
  });
});

describe("StudioServer without a Studio record", () => {
  it("says what the record does not hold yet, and keys the draft by the server's id", async () => {
    seedDraft(idDraftKey(GITHUB), {
      revision: 0,
      ops: [{ kind: "remove", tool: "get_file_contents" }],
    });
    const { ctx, readRecord } = await renderStudio({ serverId: GITHUB });
    expect(readRecord).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ id: GITHUB }),
    );
    const budget = screen.getByTestId("studio-budget-missing");
    expect(budget).toHaveAttribute("role", "note");
    expect(budget).toHaveAttribute("data-state", "not-recorded");
    expect(budget).toHaveAttribute("data-gap", "#4678");
    expect(budget).toHaveTextContent(
      "The definition budget is set in tools.toml, and Oxagen has not read this server's tools.toml yet.",
    );
    expect(screen.queryByTestId("studio-budget")).toBeNull();
    expect(screen.getByTestId("studio-tools-missing")).toHaveAttribute(
      "data-gap",
      "#4678",
    );
    const row = screen.getByTestId("studio-tool-get_file_contents");
    const tokens = within(row).getByText("not recorded");
    expect(tokens).toHaveAttribute("data-state", "not-recorded");
    expect(tokens).toHaveAttribute("data-gap", "#4678");
    expect(
      within(row).getByRole("switch", { name: "Deny get_file_contents" }),
    ).toHaveAttribute("data-testid", "tools-flip-tool_version-tlv_01k5a2");
    expect(countOf("tools")).toBe("1");
    expect(countOf("changes")).toBe("1");
  });

  it("on Changes, asks for no findings and says the draft has no folder to open a PR from", async () => {
    const { readFindings } = await renderStudio({
      serverId: GITHUB,
      tab: "changes",
    });
    expect(readFindings).not.toHaveBeenCalled();
    const missing = screen.getByTestId("studio-findings-missing");
    expect(missing).toHaveAttribute("data-state", "not-recorded");
    expect(missing).toHaveAttribute("data-gap", "#4678");
    expect(screen.queryByTestId("studio-finding")).toBeNull();
    expect(screen.getByTestId("studio-pr-no-server")).toHaveAttribute(
      "data-gap",
      "#4678",
    );
  });

  it("draws the record's budget for a server that has one", async () => {
    await renderStudio();
    expect(screen.getByTestId("studio-budget")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-budget-missing")).toBeNull();
    expect(screen.queryByTestId("studio-tools-missing")).toBeNull();
  });
});

describe("StudioLoading", () => {
  it("announces the server as loading, with four tiles and seven rows", () => {
    withIntl(<StudioLoading />);
    const status = screen.getByRole("status", { name: "Loading the server" });
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("data-state", "loading");
    expect(status.querySelectorAll('[data-skeleton="tile"]')).toHaveLength(4);
    expect(status.querySelectorAll('[data-skeleton="row"]')).toHaveLength(7);
  });
});
