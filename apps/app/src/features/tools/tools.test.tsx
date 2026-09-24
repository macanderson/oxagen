// @vitest-environment jsdom
// The Tools page body in each of its states on a fake DataSource: the loaded
// registry, the grants log, the switch board, the mandates ledger, the
// auto-approval rules, each tab's empty state and every refusal a read can
// answer. A registry row prints what the record carries and nothing it does
// not — an unclassified version says so, a call count the
// store did not answer stays "not recorded" — and axe checks the state each
// test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPage } from "@/data/contracts/agents";
import type { OrgRole } from "@/data/contracts/common";
import type { MandateList } from "@/data/contracts/mandates";
import type { ApprovalRuleSet as ApprovalRuleSetView } from "@/data/contracts/tools";
import { type Read, readError, readOk } from "@/data/read";
// Type-only, so the `server-only` module is not pulled into the jsdom run:
// the values come from the dynamic import below, as they already did.
import type { WsCtx as WsCtxType, WsRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { GrantEffect } from "@oxagen/oxagen";
import { approvalRuleDelete } from "@oxagen/oxagen/contracts/approval_rule.delete";
import { approvalRuleEnabledSet } from "@oxagen/oxagen/contracts/approval_rule.enabled.set";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { approvalRuleSet as approvalRuleSetContract } from "@oxagen/oxagen/contracts/approval_rule.set";
import { killSwitchSet } from "@oxagen/oxagen/contracts/kill_switch.set";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import { toolImport } from "@oxagen/oxagen/contracts/tool.import";
import {
  callsAuthority,
  mandateAuthority,
  mandateList,
  mandateRow,
} from "@/test/mandate-views";

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Tools, ToolsLoading } = await import("./tools");
const {
  agentPage,
  agentPageRow,
  approvalRuleSet,
  credentialGrantPage,
  killSwitchBoard,
  toolsSource,
  toolVersionPage,
} = await import("./tools.builders");
const { TOOLS_TABS } = await import("./view");

/**
 * A viewer of this workspace. The two roles are independent memberships, and
 * the gate suite varies both to prove the page reads only the one the handler
 * can honour; the other suites take the default (#3143).
 */
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
  reads: Parameters<typeof toolsSource>[0],
  query: Query = {},
  ctx = owner,
) {
  const { source, calls } = toolsSource(reads);
  const view = withIntl(await Tools({ ctx, source, searchParams: query }));
  return { ...view, calls };
}

/** The reads a tab that is not open never makes are still handed the switch board. */
const board = () => readOk(killSwitchBoard());

/**
 * The Mandates tab (#2957) on the #2958 shell. The tab strip counts the
 * switches that are denying on every tab, so the board is handed over even
 * here; `mandates` is the only read the tab body itself makes.
 */
async function renderLedger(
  mandates: Read<MandateList>,
  as: OrgRole = "billing",
) {
  return renderTools(
    { mandates, killSwitches: board() },
    { tab: "mandates" },
    viewer(as),
  );
}

const ledger = () => screen.getByRole("region", { name: "Mandates ledger" });

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Tools › tabs", () => {
  // The strip maps TOOLS_TABS and the body switches on it, joined by nothing
  // but agreement — and this page was assembled from two lanes, #2958's shell
  // and #2957's ledger, each of which knew only its own half. A tab whose case
  // never landed renders the strip over nothing, which reads as "no tools
  // here" rather than as a bug. So the shape is counted rather than eyeballed:
  // the shell is the nav and exactly one body, for every tab the strip offers.
  it.each(TOOLS_TABS.map((tab) => [tab]))(
    "renders a body behind the %s tab",
    async (tab) => {
      const { container } = await renderTools(
        {
          versions: readOk(toolVersionPage()),
          grants: readOk(credentialGrantPage()),
          killSwitches: board(),
          mandates: mandateList([mandateRow()]),
          approvalRules: readOk(approvalRuleSet()),
        },
        { tab },
      );
      const shell = element(container.firstElementChild, "tools shell");
      expect(shell.firstElementChild?.tagName).toBe("NAV");
      expect(shell.children).toHaveLength(2);
    },
  );

  it("marks the registry as the default tab and counts the switches that are denying", async () => {
    await renderTools({
      versions: readOk(toolVersionPage()),
      killSwitches: board(),
    });
    const tabs = screen.getByRole("navigation", { name: "Tools sections" });
    expect(within(tabs).getByRole("link", { name: /^Tools$/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(tabs).getByText("1 on")).toBeInTheDocument();
  });

  it("shows no count when nothing is denying", async () => {
    await renderTools({
      versions: readOk(toolVersionPage()),
      killSwitches: readOk(
        killSwitchBoard({
          switches: killSwitchBoard().switches.map((s) => ({
            ...s,
            on: false,
            target: { kind: s.target.kind, id: s.target.ref },
            flippedBy: s.flippedByRef,
            clearedBy: s.clearedByRef,
          })),
        }),
      ),
      grants: readOk(credentialGrantPage()),
    });
    expect(screen.queryByText(/\d+ on/)).not.toBeInTheDocument();
  });

  it("shows no count when the switch read did not answer", async () => {
    await renderTools({
      versions: readOk(toolVersionPage()),
      killSwitches: readError("tool_registry_unavailable", 503),
    });
    expect(screen.queryByText(/\d+ on/)).not.toBeInTheDocument();
  });
});

describe("Tools › registry", () => {
  it("prints each version with its classification, gate, origin, digest and calls", async () => {
    await renderTools({
      versions: readOk(toolVersionPage()),
      killSwitches: board(),
    });
    const table = screen.getByRole("table", { name: "Tool versions" });
    const rows = within(table).getAllByRole("row");
    // header + two versions
    expect(rows).toHaveLength(3);

    const money = within(rowOf(within(table).getByText("Create payment")));
    expect(money.getByText("stripe__create_payment@4")).toBeInTheDocument();
    expect(money.getByText("moves_money")).toBeInTheDocument();
    expect(money.getByText("Critical")).toBeInTheDocument();
    expect(money.getByText("irreversible")).toBeInTheDocument();
    expect(money.getByText("Killed · its class")).toBeInTheDocument();
    expect(money.getByText("third party")).toBeInTheDocument();
    expect(money.getByText("Moves money")).toBeInTheDocument();
    expect(money.getByText("Imported")).toBeInTheDocument();
    expect(money.getByText("a1b2c3d4e5f6")).toBeInTheDocument();
    expect(money.getByText("1,204")).toBeInTheDocument();
  });

  it("says what an unclassified version does not carry rather than inventing it", async () => {
    await renderTools({
      versions: readOk(toolVersionPage()),
      killSwitches: board(),
    });
    const plain = rowOf(screen.getByText("Get file contents"));
    expect(within(plain).getByText("Unclassified")).toBeInTheDocument();
    // Egress, calls, and now Financial: the read carries only the classified
    // half of the consequence tags, and the union is what a money tag lives
    // in, so the column confirms or says nothing — it never prints "no".
    expect(within(plain).getAllByText("not recorded")).toHaveLength(3);
    expect(within(plain).queryByText("0")).not.toBeInTheDocument();
  });

  it("counts nothing on All while a tag narrows the page, and says what the chips are", async () => {
    await renderTools(
      { versions: readOk(toolVersionPage()), killSwitches: board() },
      { category: "moves_money" },
    );
    const chips = screen.getByRole("navigation", {
      name: "Filter by consequence tag",
    });
    // The kernel already narrowed the page, so a count here would be the match
    // count wearing the word "All", and no unfiltered total was read.
    const all = element(
      chips.querySelector('[data-category="all"]'),
      "all chip",
    );
    expect(all.textContent).toBe("All");
    expect(
      element(
        document.querySelector('[data-state="facets-filtered"]'),
        "filter note",
      ),
    ).toHaveTextContent("not the registry's");
    expect(
      element(
        document.querySelector('[data-state="facets-declared"]'),
        "declared note",
      ),
    ).toHaveTextContent("never rule one out");
  });

  it("offers a chip per consequence tag with its count, and asks the kernel for the one picked", async () => {
    const { calls } = await renderTools(
      { versions: readOk(toolVersionPage()), killSwitches: board() },
      { category: "moves_money" },
    );
    expect(calls.versions[0]?.[1]).toEqual({
      category: "moves_money",
      cursor: null,
    });
    const chips = screen.getByRole("navigation", {
      name: "Filter by consequence tag",
    });
    expect(
      within(chips).getByRole("link", { name: /moves_money/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(chips).getByRole("link", { name: /^All/ })).toHaveAttribute(
      "href",
      "/acme/core-platform/tools",
    );
  });

  it("swaps the label and the API name on the names toggle", async () => {
    await renderTools(
      { versions: readOk(toolVersionPage()), killSwitches: board() },
      { names: "api" },
    );
    const toggle = screen.getByRole("navigation", { name: "Tool names" });
    expect(
      within(toggle).getByRole("link", { name: "API names" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("links a later page when the read carried a cursor", async () => {
    await renderTools({
      versions: readOk(toolVersionPage({ nextCursor: "c2" })),
      killSwitches: board(),
    });
    expect(screen.getByTestId("tools-next-page")).toHaveAttribute(
      "href",
      "/acme/core-platform/tools?cursor=c2",
    );
  });

  it("calls the category chips this page's when a later page exists", async () => {
    await renderTools({
      versions: readOk(toolVersionPage({ nextCursor: "c2" })),
      killSwitches: board(),
    });
    const chips = screen.getByRole("navigation", {
      name: "Filter by consequence tag",
    });
    // `list_tool_versions` offers no facet aggregate, so the tally is a tally
    // of what was read and says so rather than standing in for the registry.
    expect(within(chips).getByText("All on this page")).toBeInTheDocument();
    expect(
      element(
        document.querySelector('[data-state="facets-partial"]'),
        "facet note",
      ),
    ).toHaveTextContent("this page of the registry");
  });

  it("calls the chips the registry's when the page is the whole registry", async () => {
    await renderTools({
      versions: readOk(toolVersionPage({ nextCursor: null })),
      killSwitches: board(),
    });
    const chips = screen.getByRole("navigation", {
      name: "Filter by consequence tag",
    });
    expect(within(chips).getByText("All")).toBeInTheDocument();
    expect(document.querySelector('[data-state="facets-partial"]')).toBeNull();
  });

  it("says the registry is empty, with the import action, when nothing is registered", async () => {
    await renderTools({
      versions: readOk(toolVersionPage({ items: [], nextCursor: null })),
      killSwitches: board(),
    });
    expect(screen.getByText("No tool version is registered")).toBeVisible();
    expect(screen.getByTestId("tools-import-open")).toBeVisible();
  });

  it("says the chip matched nothing rather than that the registry is empty", async () => {
    await renderTools(
      {
        versions: readOk(toolVersionPage({ items: [], nextCursor: null })),
        killSwitches: board(),
      },
      { category: "moves_money" },
    );
    expect(
      screen.getByText("No tool version on this page carries that tag."),
    ).toBeVisible();
  });

  it("offers no write action to a member", async () => {
    await renderTools(
      { versions: readOk(toolVersionPage()), killSwitches: board() },
      {},
      member,
    );
    expect(screen.queryByTestId("tools-import-open")).not.toBeInTheDocument();
  });
});

describe("Tools › connections", () => {
  it("keeps provider registration, connections, and credential grants on one tab", async () => {
    const { calls } = await renderTools(
      { grants: readOk(credentialGrantPage()), killSwitches: board() },
      { tab: "connections" },
    );
    expect(
      screen.getByRole("table", { name: "Providers" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("server-register-open")).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "Credential grants" }),
    ).toBeInTheDocument();
    expect(calls.mcpServers).toHaveLength(1);
  });

  it("prints each grant with the connection, the scope, its TTL and its state", async () => {
    await renderTools(
      { grants: readOk(credentialGrantPage()), killSwitches: board() },
      { tab: "connections" },
    );
    const table = screen.getByRole("table", { name: "Credential grants" });
    const github = rowOf(within(table).getByText("mcgr_01k5g1"));
    expect(within(github).getByText("github")).toBeInTheDocument();
    expect(within(github).getByText("arun_01k5r7")).toBeInTheDocument();
    expect(within(github).getByText("mcrd_01k5c9")).toBeInTheDocument();
    expect(within(github).getByText("token exchange")).toBeInTheDocument();
    expect(within(github).getByText("5m")).toBeInTheDocument();
    expect(within(github).getByText("Expired")).toBeInTheDocument();

    const stripe = rowOf(within(table).getByText("mcgr_01k5g2"));
    expect(within(stripe).getByText("Outside a run")).toBeInTheDocument();
    expect(within(stripe).getByText("Revoked")).toBeInTheDocument();
  });

  it("says nothing has been put to use when the log is empty", async () => {
    await renderTools(
      {
        grants: readOk(credentialGrantPage({ items: [], nextCursor: null })),
        killSwitches: board(),
      },
      { tab: "connections" },
    );
    expect(screen.getByText("No credential has been put to use")).toBeVisible();
  });

  it("links a later page of the log", async () => {
    await renderTools(
      {
        grants: readOk(credentialGrantPage({ nextCursor: "g2" })),
        killSwitches: board(),
      },
      { tab: "connections" },
    );
    expect(screen.getByTestId("tools-next-page")).toHaveAttribute(
      "href",
      "/acme/core-platform/tools?tab=connections&cursor=g2",
    );
  });
});

describe("Tools › kill switches", () => {
  it("draws every level, the deny generation, and each recorded switch with its blast radius", async () => {
    await renderTools({ killSwitches: board() }, { tab: "switches" });
    for (const level of [
      "Consequence class",
      "Organization",
      "Tool server",
      "Tool version",
      "Connection",
      "Agent",
      "Operator",
    ]) {
      expect(screen.getAllByText(level).length).toBeGreaterThan(0);
    }
    expect(
      screen.getByText(
        "Deny generation: 12 organization-wide, 4 in this workspace.",
      ),
    ).toBeVisible();

    const card = within(cardOf('[data-switch="emd_01k5c1"]'));
    expect(card.getByText("denying")).toBeInTheDocument();
    expect(card.getByText("moves_money")).toBeInTheDocument();
    expect(
      card.getByText(
        "Every tool version carrying this consequence tag, across the organization — including one imported tomorrow.",
      ),
    ).toBeInTheDocument();
    expect(
      card.getByText("Suspected compromise of the Stripe restricted key."),
    ).toBeInTheDocument();
  });

  it("does not print the uuid of a target its heading already names", async () => {
    await renderTools({ killSwitches: board() }, { tab: "switches" });
    const workspace = cardOf('[data-switch="emd_01k5c2"]');
    // One organization and one workspace are in view, so the heading names the
    // target and the uuid the record carries is not printed as a label.
    expect(within(workspace).getByText("Workspace")).toBeInTheDocument();
    expect(workspace.textContent).not.toContain(
      "7b000000-0000-4000-8000-000000000001",
    );
    expect(within(workspace).getByText("allowing")).toBeInTheDocument();
  });

  it("prints the uuid of a sibling workspace's switch, which the heading does not name", async () => {
    const sibling = killSwitchBoard({
      switches: [
        {
          id: "emd_01k5c9",
          target: {
            kind: "workspace",
            id: "7b000000-0000-4000-8000-0000000000ff",
          },
          // Every workspace switch is recorded org-wide, so one flipped in a
          // sibling workspace reaches this board too.
          scope: "org",
          on: true,
          reason: "Contained while the incident runs.",
          flippedBy: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          flippedAt: "2026-09-11T15:02:00.000Z",
          clearedAt: null,
          clearedBy: null,
        },
        {
          id: "emd_01k5ca",
          target: {
            kind: "org",
            id: "7a000000-0000-4000-8000-0000000000a1",
          },
          scope: "org",
          on: true,
          reason: "Everything stops until the review lands.",
          flippedBy: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          flippedAt: "2026-09-11T16:00:00.000Z",
          clearedAt: null,
          clearedBy: null,
        },
      ],
    });
    await renderTools({ killSwitches: readOk(sibling) }, { tab: "switches" });
    const card = cardOf('[data-switch="emd_01k5c9"]');
    expect(card.textContent).toContain("7b000000-0000-4000-8000-0000000000ff");
    // The organization in view is the only one a switch can name, so its uuid
    // adds nothing the heading has not said.
    expect(cardOf('[data-switch="emd_01k5ca"]').textContent).not.toContain(
      "7a000000-0000-4000-8000-0000000000a1",
    );
  });

  it("says the board is its newest page when the read came back full, and calls the tab's count a floor", async () => {
    // The fixture's three switches, read with a limit of three: the contract
    // carries no cursor, so a full answer is all the page can know.
    await renderTools(
      { killSwitches: readOk(killSwitchBoard({}, 3)) },
      { tab: "switches" },
    );
    expect(
      element(document.querySelector('[data-state="truncated"]'), "truncation"),
    ).toHaveTextContent("the count on the tab is a floor");
    const tabs = screen.getByRole("navigation", { name: "Tools sections" });
    expect(within(tabs).getByText("1 or more on")).toBeInTheDocument();
  });

  it("names who lifted a deny, and keeps who imposed it and why", async () => {
    await renderTools({ killSwitches: board() }, { tab: "switches" });
    const cleared = within(cardOf('[data-switch="emd_01k5c2"]'));
    // Lifting a deny restores access, so the actor is named the way the
    // imposing actor is.
    expect(
      cleared.getByText("7c9e6679-7425-40de-944b-e07fc1f90ae7"),
    ).toBeInTheDocument();
    // Clearing a switch rewrites neither the deny's reason nor who made it,
    // so a cleared card still carries the whole history.
    expect(cleared.getByText("not recorded")).toBeInTheDocument();
    expect(
      cleared.getByText("Rotation confirmed; the security owner signed off."),
    ).toBeInTheDocument();
  });

  it("says nothing has ever been flipped when the board is empty", async () => {
    await renderTools(
      { killSwitches: readOk(killSwitchBoard({ switches: [] })) },
      { tab: "switches" },
    );
    expect(
      screen.getByText(
        "No kill switch has ever been flipped in this workspace. Flip one to record the first.",
      ),
    ).toBeVisible();
  });

  it("offers the flip action to an owner and to nobody else", async () => {
    await renderTools({ killSwitches: board() }, { tab: "switches" });
    expect(screen.getByTestId("tools-flip-open")).toBeVisible();
    cleanup();
    await renderTools({ killSwitches: board() }, { tab: "switches" }, member);
    expect(screen.queryByTestId("tools-flip-open")).not.toBeInTheDocument();
  });
});

// The three writes the Tools page offers, each named by the capability it
// invokes. Two of them grant org roles only; `import_tools` grants a workspace
// role beside them, which is the case #3143 is about.
const TOOLS_WRITES = [
  ["import_tools", toolImport],
  ["set_tool_classification", toolClassificationSet],
  ["set_kill_switch", killSwitchSet],
] as const;

type ToolsWrite = (typeof TOOLS_WRITES)[number][0];
type ToolsWriteContract = (typeof TOOLS_WRITES)[number][1];

/**
 * Whether this capability admits this viewer **in practice**, read off the
 * capability's own `defaultRoles.org` — the object each handler asserts
 * verbatim with `assertOrgRole({ org: [...], … })`. Reading it rather than
 * restating it is the point: a gate compared against a second copy of the
 * answer written in the test agrees with whatever the test author believed,
 * while this comparison fails the moment the gate and the capability part
 * company in either direction.
 *
 * `defaultRoles.workspace` is deliberately NOT read, and that is the whole
 * finding behind #3143. `assertOrgRole` resolves a workspace role from
 * `iam.principal_role_assignments`, and nothing in the tree writes one for a
 * human principal, so a contract's workspace clause admits nobody and is not
 * part of what the gate can honour (see the comment on `canImportTools`, and
 * #3198 for the decision). Folding it in here would assert the declared
 * mandate rather than the enforced one, and would have this suite demand a
 * gate that offers a control the handler refuses.
 *
 * The contract names roles in TitleCase (`Owner`) and the viewer carries them
 * lowercased, which `systemLookups` settles once; the casing is folded here
 * for the same reason.
 */
function enforceablyGrants(
  contract: ToolsWriteContract,
  ctx: WsCtxType,
): boolean {
  // Widened to the declared type before reading. All three of these contracts
  // happen to say `allow` for every role they name, so TypeScript infers a
  // literal type where `effect === "allow"` is statically true and
  // `no-unnecessary-condition` rejects the comparison. The filter is not
  // redundant — `GrantEffect` admits `deny`, and a contract that later denies a
  // role must not be read as granting it — so the type is relaxed rather than
  // the check removed.
  const org: Partial<Record<string, GrantEffect>> = contract.defaultRoles.org;
  return Object.entries(org)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role.toLowerCase())
    .includes(ctx.orgRole);
}

/**
 * Which of the three write controls the page actually offers this viewer.
 * Import and flip are section actions; classification is written from inside
 * the version dialog, so the row is opened to see whether the form or the
 * refusal sentence is behind it, and the two are cross-checked against each
 * other so a renamed control cannot read as a refusal.
 */
async function offered(ctx: WsCtxType): Promise<Record<ToolsWrite, boolean>> {
  await renderTools(
    { versions: readOk(toolVersionPage()), killSwitches: board() },
    {},
    ctx,
  );
  const importOffered = screen.queryByTestId("tools-import-open") !== null;

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

  await renderTools({ killSwitches: board() }, { tab: "switches" }, ctx);
  const flipOffered = screen.queryByTestId("tools-flip-open") !== null;

  return {
    import_tools: importOffered,
    set_tool_classification: classifyOffered,
    set_kill_switch: flipOffered,
  };
}

describe("Tools › write gates", () => {
  // The pair #3143 asks for, answered the way the platform actually answers it.
  // The issue expected a workspace Owner holding org `member` to be offered the
  // import control, on the reading that `import_tools`' `workspace: ["Owner"]`
  // clause admits them. It does not admit anybody: no human principal can hold
  // a workspace-scoped IAM assignment, so the handler refuses them and this
  // page declines to promise otherwise (#3198). Each test names all three
  // writes rather than the one it is about, because a gate that showed every
  // control to everyone — or hid every control from everyone — would satisfy
  // half of this on its own.
  it("offers a workspace Owner holding org member none of the three, because no role the handlers can resolve admits them", async () => {
    expect(await offered(viewer("member", "owner"))).toEqual({
      import_tools: false,
      set_tool_classification: false,
      set_kill_switch: false,
    });
  });

  it("offers an org member who is no workspace Owner none of the three", async () => {
    expect(await offered(viewer("member", "member"))).toEqual({
      import_tools: false,
      set_tool_classification: false,
      set_kill_switch: false,
    });
  });

  // The other half of the pair, and the reason the two above prove anything: a
  // gate stuck at `false` would pass both of them and fail here.
  it("offers an org Admin holding no workspace role all three", async () => {
    expect(await offered(viewer("admin", "member"))).toEqual({
      import_tools: true,
      set_tool_classification: true,
      set_kill_switch: true,
    });
  });

  // What the tests above do NOT show, and must not be read as showing. They
  // force `versions: readOk(...)` in order to ask what the gate does given a
  // successful read. The org `member` never gets one: `list_tool_versions`
  // asserts `{ org: ["Owner","Admin"], workspace: ["Owner","Member","Viewer"] }`
  // and resolves the workspace half from `iam.principal_role_assignments`,
  // which holds nothing for a human principal, so the read is denied and
  // `Registry` answers `ToolsReadFailure` before any control is reached. A suite
  // that only ever hands this viewer an `ok` read passes on a world where
  // `assertOrgRole` does not exist.
  it("answers a workspace Owner holding org member the denied read, not a control, because the registry read refuses them first", async () => {
    await renderTools(
      {
        versions: { ok: false, reason: "denied", permission: "tools.read" },
        killSwitches: board(),
      },
      {},
      viewer("member", "owner"),
    );
    expect(screen.getByTestId("tools-denied")).toBeVisible();
    expect(screen.queryByTestId("tools-import-open")).not.toBeInTheDocument();
  });

  // And the same question asked of the contracts rather than of this file, so
  // that a gate drifting from the roles its capability names — in either
  // direction — fails here instead of in production.
  it.each([
    ["member", "owner"],
    ["member", "member"],
    ["owner", "member"],
    ["admin", "owner"],
    ["billing", "viewer"],
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

describe("Tools › not loaded", () => {
  it("names the role held, the permission needed and who decides when the read is denied", async () => {
    await renderTools({
      versions: {
        ok: false,
        reason: "denied",
        permission: "tools.read",
      },
      killSwitches: board(),
    });
    const panel = screen.getByTestId("tools-denied");
    expect(
      within(panel).getByText("You cannot see the tool registry"),
    ).toBeVisible();
    expect(within(panel).getByText("Signed in as: Owner")).toBeVisible();
    expect(within(panel).getByText("tools.read")).toBeVisible();
    expect(
      within(panel).getByText(
        "Decided by: the workspace’s decision rules — deny wins over every allow.",
      ),
    ).toBeVisible();
    expect(
      within(panel).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
  });

  it("names the access request while one is waiting", async () => {
    await renderTools(
      {
        grants: {
          ok: false,
          reason: "pending_approval",
          accessRequestId: "acr_01k5",
        },
        killSwitches: board(),
      },
      { tab: "connections" },
    );
    expect(
      within(screen.getByTestId("tools-pending")).getByText(/acr_01k5/),
    ).toBeVisible();
  });

  it("says nothing was changed, names the code, and offers the tab again on an error", async () => {
    await renderTools(
      { killSwitches: readError("tool_registry_unavailable", 503) },
      { tab: "switches" },
    );
    const panel = screen.getByTestId("tools-error");
    expect(within(panel).getByText("Tools could not be loaded")).toBeVisible();
    expect(
      within(panel).getByText("tool_registry_unavailable · 503"),
    ).toBeVisible();
    expect(
      within(panel).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/acme/core-platform/tools?tab=switches");
  });
});

describe("ToolsLoading", () => {
  it("is a busy skeleton with an accessible name", () => {
    withIntl(<ToolsLoading />);
    const skeleton = screen.getByLabelText("Loading tools");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.dataset.state).toBe("loading");
  });
});

// The ledger #2957 built, now a tab on #2958's shell rather than the page.
// The suite carried over whole: what it asserts is about the ledger, not about
// the layout it sat in, so every case survived the move unchanged except for
// how it is rendered. The shell's own afterEach axe-checks each state.
describe("Tools › mandates ledger", () => {
  it("is reachable as a tab and reads every mandate in the workspace, not one agent's", async () => {
    const { calls } = await renderLedger(mandateList([mandateRow()]));
    const ctx = viewer("billing");
    expect(calls.mandates).toEqual([[ctx, { agentId: null }]]);
    expect(
      screen.getByRole("navigation", { name: "Tools sections" }),
    ).toBeInTheDocument();
  });

  it("prints the grant and what the ledger has settled, reserved and left", async () => {
    await renderLedger(mandateList([mandateRow()]));
    const row = within(ledger()).getByTestId("mandate");
    expect(row).toHaveAttribute("data-status", "active");
    const text = row.textContent;
    for (const figure of [
      "mnd_4f2a9c",
      "invoice-bot",
      "usr_priyanatarajan",
      "Billing",
      "monthly infrastructure invoices, PO-4471",
      "$250.00",
      "$2,000.00",
      "$1,204.18",
      "$180.00",
      "$615.82",
      "active",
    ]) {
      expect(text).toContain(figure);
    }
  });

  it("prints every measure of a mandate that limits more than one", async () => {
    await renderLedger(
      mandateList([
        mandateRow({ authority: [mandateAuthority(), callsAuthority()] }),
      ]),
    );
    const row = within(ledger()).getByTestId("mandate");
    expect(row.textContent).toContain("50 calls");
    expect(row.textContent).toContain("38 calls");
    expect(row.textContent).toContain("$2,000.00");
  });

  it("prints no granter for a request nobody has granted (negative)", async () => {
    await renderLedger(
      mandateList([
        mandateRow({ status: "draft", grantedBy: null, roleAtGrant: null }),
      ]),
    );
    const row = within(ledger()).getByTestId("mandate");
    expect(row).toHaveAttribute("data-status", "draft");
    expect(row.textContent).toContain("not granted");
    expect(row.textContent).toContain("requested");
  });

  // An accountability ledger that cannot say who asked for the authority is
  // not one. `requestedBy` was on the view model and no surface rendered it,
  // so every ungranted row read only "not granted".
  it("names the operator who asked, on a row nobody has granted", async () => {
    await renderLedger(
      mandateList([
        mandateRow({
          status: "draft",
          grantedBy: null,
          roleAtGrant: null,
          requestedBy: "usr_marcusbell",
        }),
      ]),
    );
    const row = within(ledger()).getByTestId("mandate");
    expect(row.textContent).toContain("requested by usr_marcusbell");
  });

  // A granted row keeps the granter and their role at grant; the requester
  // does not displace the name this column is headed for.
  it("keeps the granter and the role they held on a granted row", async () => {
    await renderLedger(mandateList([mandateRow()]));
    const row = within(ledger()).getByTestId("mandate");
    expect(row.textContent).toContain("usr_priyanatarajan");
    expect(row.textContent).toContain("Billing");
    expect(row.textContent).not.toContain("requested by");
  });

  // Null only where the row records no requester — a grant written directly,
  // which never went through a request. The cell says "not granted" and
  // invents no name.
  it("names nobody when the row records no requester either (negative)", async () => {
    await renderLedger(
      mandateList([
        mandateRow({
          status: "draft",
          grantedBy: null,
          roleAtGrant: null,
          requestedBy: null,
        }),
      ]),
    );
    const row = within(ledger()).getByTestId("mandate");
    expect(row.textContent).toContain("not granted");
    expect(row.textContent).not.toContain("requested by");
  });

  it("says a measure has no limit rather than printing a zero (negative)", async () => {
    await renderLedger(
      mandateList([
        mandateRow({
          authority: [
            mandateAuthority({
              perCall: null,
              perPeriod: null,
              remaining: null,
              settledRatio: null,
              reservedRatio: null,
            }),
          ],
        }),
      ]),
    );
    expect(
      within(ledger()).getAllByText("no limit").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("says older mandates are not listed when the answer filled its page (negative)", async () => {
    await renderLedger(mandateList([mandateRow()], 100));
    const line = within(ledger()).getByText(/older ones are not listed/);
    expect(line).toHaveAttribute("data-state", "incomplete");
    expect(line).toHaveAttribute("data-blind-spot", "truncated");
  });

  it("says nothing about older mandates when the answer was the whole set", async () => {
    await renderLedger(mandateList([mandateRow()]));
    expect(
      within(ledger()).queryByText(/older ones are not listed/),
    ).toBeNull();
  });

  it("says the workspace has recorded no mandate, granted or requested", async () => {
    await renderLedger(mandateList([]));
    expect(within(ledger()).getByText(/recorded no mandate/)).toHaveAttribute(
      "data-state",
      "empty",
    );
    expect(within(ledger()).queryByRole("table")).toBeNull();
  });

  it("says who may read the ledger when the viewer may not (negative)", async () => {
    await renderLedger({
      ok: false,
      reason: "denied",
      permission: "org.billing",
    });
    expect(within(ledger()).getByText(/org\.billing/)).toHaveAttribute(
      "data-reason",
      "denied",
    );
  });

  it("names the code the ledger answered when it is down (negative)", async () => {
    await renderLedger(readError("mandate_ledger_unavailable", 503));
    expect(
      within(ledger()).getByText(/mandate_ledger_unavailable/),
    ).toHaveAttribute("data-reason", "error");
  });

  // The workspace-wide read is narrowed for a non-accountable reader the same
  // way the per-agent one is, so an empty ledger is not proof of an empty
  // ledger unless the reader is one this page is written for.
  it.each([["member" as const], ["viewer" as const]])(
    "does not tell a %s that the workspace has granted nothing (negative)",
    async (role) => {
      await renderLedger(mandateList([]), role);
      expect(
        within(ledger()).getByText(/not every mandate this workspace has/),
      ).toHaveAttribute("data-blind-spot", "reader_scope");
      expect(
        within(ledger()).getByText(/not a statement that the workspace/),
      ).toHaveAttribute("data-state", "empty");
      expect(within(ledger()).queryByText(/recorded no mandate/)).toBeNull();
    },
  );

  // Incompleteness does not depend on length: a narrowed reader answered rows
  // is looking at a subset under a lead that describes the whole ledger.
  it.each([["member" as const], ["viewer" as const]])(
    "says the ledger is partial to a %s answered rows (negative)",
    async (role) => {
      await renderLedger(mandateList([mandateRow()]), role);
      expect(
        within(ledger()).getByText(/not every mandate this workspace has/),
      ).toHaveAttribute("data-blind-spot", "reader_scope");
      expect(within(ledger()).getByRole("table")).toBeInTheDocument();
      expect(within(ledger()).queryByText(/not a statement/)).toBeNull();
    },
  );

  // The lead and the caveats describe whatever `list_mandates` returns, and it
  // returns every status — the table below labels a draft "requested". A lead
  // saying the workspace *has granted* these is false of a ledger holding only
  // drafts, which is what "has granted" hid: it carries no quantifier, so a
  // pass looking for "every" and "all" walked straight past it.
  it("describes a ledger of drafts without claiming any was granted", async () => {
    await renderLedger(mandateList([mandateRow({ status: "draft" })]));
    const text = ledger().textContent;
    expect(text).toContain("has recorded");
    expect(text).not.toMatch(/has granted/);
    expect(within(ledger()).getByTestId("mandate").textContent).toContain(
      "requested",
    );
  });

  it.each([
    ["draft" as const],
    ["active" as const],
    ["expired" as const],
    ["revoked" as const],
  ])("never says a %s row was granted", async (status) => {
    await renderLedger(mandateList([mandateRow({ status })], 100));
    expect(ledger().textContent).not.toMatch(/has granted/);
  });

  it("says nothing of the sort to an accountable reader answered rows", async () => {
    await renderLedger(mandateList([mandateRow()]), "owner");
    expect(
      within(ledger()).queryByText(/not every mandate this workspace has/),
    ).toBeNull();
  });

  it.each([["owner" as const], ["admin" as const], ["compliance" as const]])(
    "tells a %s the workspace has recorded none, because their answer is every one",
    async (role) => {
      await renderLedger(mandateList([]), role);
      expect(within(ledger()).getByText(/recorded no mandate/)).toHaveAttribute(
        "data-state",
        "empty",
      );
    },
  );

  // The name is not conditional on there being two: a lone `tax` limit under a
  // column headed Per call is an unlabelled dollar figure.
  it("names the measure on a row that limits exactly one", async () => {
    await renderLedger(
      mandateList([
        mandateRow({ authority: [mandateAuthority({ measure: "tax" })] }),
      ]),
    );
    expect(within(ledger()).getByTestId("mandate").textContent).toContain(
      "tax",
    );
  });

  // Two mandates differing only in tool scope rendered as the same row, on the
  // page an accountable reader uses to review what they granted.
  it("shows which tools a mandate covers", async () => {
    await renderLedger(
      mandateList([
        mandateRow({ tools: ["payments.read@*", "payments.list@2"] }),
      ]),
    );
    const row = within(ledger()).getByTestId("mandate");
    expect(row.textContent).toContain("payments.read@*");
    expect(row.textContent).toContain("payments.list@2");
    expect(within(row).queryByText("every tool")).toBeNull();
  });

  // `*` is the difference between one tool and everything, and a reader should
  // not have to notice one character to see it.
  it("calls out an unrestricted mandate rather than printing an asterisk", async () => {
    await renderLedger(mandateList([mandateRow({ tools: ["*"] })]));
    const row = within(ledger()).getByTestId("mandate");
    expect(within(row).getByText("every tool")).toHaveAttribute(
      "data-scope",
      "every-tool",
    );
  });

  // A daily 100 and a monthly 100 are different authorities, and the
  // settled/reserved/remaining figures mean nothing until the window is named.
  it("names the accounting window each limit is counted over", async () => {
    await renderLedger(
      mandateList([
        mandateRow({ authority: [mandateAuthority(), callsAuthority()] }),
      ]),
    );
    const row = within(ledger()).getByTestId("mandate");
    expect(row.textContent).toContain("per month · 2026-09");
    // A mandate may cap calls daily and money monthly; each window sits with
    // the limit it belongs to.
    expect(row.textContent).toContain("per day");
  });
});

// Grant a mandate (#2957). `grant_mandate` asserts an org role the workspace
// names for every tag, and every such role is Owner, Admin, Billing or
// Compliance, so the control is drawn for those four and for nobody else. The
// agents read the picker needs is made only for them.
describe("Tools › mandates ledger › grant", () => {
  const draft = (over: Parameters<typeof mandateRow>[0] = {}) =>
    mandateRow({
      id: "mnd_7c1d2e",
      status: "draft",
      grantedBy: null,
      roleAtGrant: null,
      ...over,
    });

  async function renderGrant(
    as: OrgRole,
    mandates: Read<MandateList> = mandateList([mandateRow()]),
    agents: Read<AgentPage> = readOk(
      agentPage([agentPageRow("invoice-bot"), agentPageRow("release-bot")]),
    ),
  ) {
    return renderTools(
      { mandates, agents, killSwitches: board() },
      { tab: "mandates" },
      viewer(as),
    );
  }

  it.each([
    ["owner" as const],
    ["admin" as const],
    ["billing" as const],
    ["compliance" as const],
  ])("offers a %s the grant, reading the agents it picks from", async (as) => {
    const { calls } = await renderGrant(as);
    expect(
      within(ledger()).getByRole("button", { name: "Grant a mandate" }),
    ).toBeInTheDocument();
    expect(calls.agents).toEqual([[viewer(as), { cursor: null }]]);
  });

  it.each([["member" as const], ["viewer" as const]])(
    "offers a %s no grant and makes no agents read (negative)",
    async (as) => {
      const { calls } = await renderGrant(
        as,
        mandateList([mandateRow(), draft()]),
      );
      expect(
        within(ledger()).queryByRole("button", { name: /^Grant/ }),
      ).toBeNull();
      expect(calls.agents).toEqual([]);
    },
  );

  it("puts a Grant on a requested row, and on no other", async () => {
    await renderGrant(
      "billing",
      mandateList([mandateRow({ status: "active" }), draft()]),
    );
    expect(
      within(ledger()).getByRole("button", {
        name: "Grant mandate mnd_7c1d2e",
      }),
    ).toBeInTheDocument();
    expect(
      within(ledger()).queryByRole("button", {
        name: "Grant mandate mnd_4f2a9c",
      }),
    ).toBeNull();
  });

  // Retirement suspends the principal, so authority granted to it could never
  // be drawn; the handler would still record it.
  it("offers a retired agent neither the picker nor its requests (negative)", async () => {
    const retired = agentPageRow("old-bot", "retired");
    await renderGrant(
      "owner",
      mandateList([draft({ agentId: retired.id, agentSlug: "old-bot" })]),
      readOk(agentPage([agentPageRow("invoice-bot"), retired])),
    );
    expect(
      within(ledger()).queryByRole("button", {
        name: "Grant mandate mnd_7c1d2e",
      }),
    ).toBeNull();
    fireEvent.click(
      within(ledger()).getByRole("button", { name: "Grant a mandate" }),
    );
    fireEvent.focus(
      within(screen.getByTestId("grant-mandate")).getByRole("combobox", {
        name: "Agent",
      }),
    );
    const listbox = within(screen.getByTestId("grant-mandate")).getByRole(
      "listbox",
    );
    const offered = within(listbox)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(offered).toHaveLength(1);
    expect(offered[0]).toContain("invoice-bot");
  });

  it("reads every agent when the page holds only the first page of them", async () => {
    await renderGrant(
      "owner",
      mandateList([mandateRow()]),
      readOk(agentPage([agentPageRow("invoice-bot")], "cursor_2")),
    );
    fireEvent.click(
      within(ledger()).getByRole("button", { name: "Grant a mandate" }),
    );
    fireEvent.focus(
      within(screen.getByTestId("grant-mandate")).getByRole("combobox", {
        name: "Agent",
      }),
    );
    await waitFor(() => {
      expect(choices.chooseAgents).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the ledger when the agents read fails, and says why no agent is offered (negative)", async () => {
    await renderGrant(
      "owner",
      mandateList([mandateRow()]),
      readError("agents_unavailable", 503),
    );
    expect(within(ledger()).getByTestId("mandate")).toBeInTheDocument();
    fireEvent.click(
      within(ledger()).getByRole("button", { name: "Grant a mandate" }),
    );
    expect(screen.getByTestId("grant-mandate")).toHaveTextContent(
      "could not be read",
    );
  });
});

/** The auto-approvals tab, as the viewer given. */
async function renderRules(
  approvalRules: Read<ApprovalRuleSetView>,
  ctx = owner,
) {
  return renderTools(
    { approvalRules, killSwitches: board() },
    { tab: "autoapprovals" },
    ctx,
  );
}

const rulesTable = () =>
  screen.getByRole("table", { name: "Auto-approval rules" });
const ruleRow = (id: string) => cardOf(`tr[data-rule="${id}"]`);

/**
 * Whether a contract admits this viewer, read off its own `defaultRoles.org`
 * as `enforceablyGrants` does for the three #2958 writes, and for the same
 * reason: the page's gate is compared with the capability, not with a second
 * copy of the answer written here. The workspace clause is empty on all four.
 */
function orgGrants(
  contract: { defaultRoles: { org?: Partial<Record<string, GrantEffect>> } },
  role: OrgRole,
): boolean {
  const org: Partial<Record<string, GrantEffect>> =
    contract.defaultRoles.org ?? {};
  return Object.entries(org)
    .filter(([, effect]) => effect === "allow")
    .map(([name]) => name.toLowerCase())
    .includes(role);
}

describe("Tools › auto-approvals", () => {
  it("is reachable as a tab and makes the one rules read", async () => {
    const { calls } = await renderRules(readOk(approvalRuleSet()));
    expect(calls.approvalRules).toEqual([[owner]]);
    const tabs = screen.getByRole("navigation", { name: "Tools sections" });
    expect(
      within(tabs).getByRole("link", { name: "Auto-approvals" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("prints each rule with what it applies to, what it requires and what it did", async () => {
    await renderRules(readOk(approvalRuleSet()));
    // header + two rules
    expect(within(rulesTable()).getAllByRole("row")).toHaveLength(3);

    const refunds = within(ruleRow("small-refunds"));
    expect(refunds.getByText("Small refunds to known customers")).toBeVisible();
    expect(refunds.getByText("policy:small-refunds")).toBeVisible();
    expect(refunds.getByText("stripe__create_refund@*")).toBeVisible();
    expect(refunds.getByText("amount at most 50000000")).toBeVisible();
    expect(
      refunds.getByText("counterparty matches cus_*, vendor:aws"),
    ).toBeVisible();
    expect(
      refunds.getByText(
        "Mon, Tue, Wed, Thu, Fri, 09:00 to 17:00 (Europe/London)",
      ),
    ).toBeVisible();
    expect(refunds.getByText("Checked against: moves_money")).toBeVisible();
    expect(refunds.getByText(/usr_01k5a1/)).toBeVisible();
    expect(refunds.getByText("212")).toBeVisible();
    expect(refunds.getByText("9")).toBeVisible();
    expect(
      ruleRow("small-refunds").querySelector('[data-state="on"]'),
    ).not.toBeNull();

    const deploys = within(ruleRow("repeat-deploys"));
    expect(
      deploys.getByText(
        "A person approved the same call in the last 60 minutes",
      ),
    ).toBeVisible();
    expect(deploys.getByText(/by no recorded person/)).toBeVisible();
    expect(
      ruleRow("repeat-deploys").querySelector('[data-state="off"]'),
    ).not.toBeNull();
  });

  // A rule with no stamp does not qualify until it is written again. The row
  // says so rather than printing an empty list of consequences.
  it("says a rule with no consequence stamp releases nothing until it is saved again", async () => {
    await renderRules(readOk(approvalRuleSet()));
    expect(
      within(ruleRow("repeat-deploys")).getByText(
        /Releases nothing until it is saved again/,
      ),
    ).toBeVisible();
    expect(
      ruleRow("small-refunds").querySelector('[data-state="unstamped"]'),
    ).toBeNull();
  });

  it("explains a rule disabled by a changed tool measure", async () => {
    const rules = approvalRuleSet();
    const first = rules.rules[0];
    if (!first) throw new Error("Missing rule fixture");
    await renderRules(
      readOk({
        ...rules,
        rules: [
          {
            ...first,
            enabled: false,
            disabledReason: {
              code: "measure_changed",
              tool: "stripe__create_refund@2",
              at: "2026-09-19T00:00:00.000Z",
              detail: "A measure changed",
            },
          },
        ],
      }),
    );
    expect(screen.getByTestId("rule-disabled-reason")).toHaveTextContent(
      "stripe__create_refund@2 changed a measure this rule uses",
    );
    expect(
      ruleRow(first.slug).querySelector('[data-state="off"]'),
    ).not.toBeNull();
  });

  it("says a rule with no condition waits only on the floors", async () => {
    const bare = approvalRuleSet({
      items: [
        {
          id: "bare",
          name: "Bare rule",
          tools: ["deploy__release"],
          enabled: true,
          maxMeasures: {},
          allowTargets: {},
          standingWindowMs: null,
          businessHours: null,
          createdBy: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          authoredConsequences: [],
          hits30d: 0,
          skipped30d: 0,
        },
      ],
    });
    await renderRules(readOk(bare));
    expect(
      within(ruleRow("bare")).getByText("Nothing beyond the floors"),
    ).toBeVisible();
  });

  it("adds up the tiles from the rules and the window the read names", async () => {
    await renderRules(readOk(approvalRuleSet()));
    const tile = (name: string) => cardOf(`[data-tile="${name}"]`);
    expect(tile("on").textContent).toContain("1");
    expect(tile("on").textContent).toContain("of 2 in the rule set");
    expect(tile("released").textContent).toContain("Auto-approved, 30 days");
    expect(tile("released").textContent).toContain("212");
    expect(tile("held").textContent).toContain("13");
    // The mockup's floor and wait-saved tiles have no backing read.
    expect(document.querySelectorAll("[data-tile]")).toHaveLength(3);
  });

  it("says there are no rules, with the create action, when the set is empty", async () => {
    await renderRules(readOk(approvalRuleSet({ items: [] })));
    expect(screen.getByText("No auto-approval rules yet")).toBeVisible();
    expect(screen.getByTestId("rule-create-open")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("answers a denied read with the access-denied panel and the tab to try again", async () => {
    await renderRules({
      ok: false,
      reason: "denied",
      permission: "tools.read",
    });
    expect(screen.getByTestId("tools-denied")).toBeVisible();
    cleanup();
    await renderRules(readError("tool_registry_unavailable", 503));
    expect(
      within(screen.getByTestId("tools-error")).getByRole("link", {
        name: "Try again",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/tools?tab=autoapprovals");
  });

  it("names the access request while one is waiting", async () => {
    await renderRules({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_01k5",
    });
    expect(
      within(screen.getByTestId("tools-pending")).getByText(/acr_01k5/),
    ).toBeVisible();
  });

  // The tab has no loading state of its own: the page streams behind
  // `ToolsLoading`, whose suite above covers every tab.

  // The read admits Compliance; the writes do not. A Compliance reader sees
  // the rules and their counters with no control on any of them.
  it("shows a Compliance reader the rules and no write control", async () => {
    await renderRules(readOk(approvalRuleSet()), viewer("compliance"));
    expect(rulesTable()).toBeVisible();
    expect(screen.queryByTestId("rule-create-open")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("rule-toggle-small-refunds"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("rule-edit-small-refunds"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("rule-delete-small-refunds"),
    ).not.toBeInTheDocument();
    expect(
      within(rulesTable()).queryByRole("columnheader", { name: "Actions" }),
    ).not.toBeInTheDocument();
  });

  // Each write control against the contract it invokes, for every org role:
  // a gate that drifts from `defaultRoles` in either direction fails here.
  it.each([
    ["owner" as const],
    ["admin" as const],
    ["compliance" as const],
    ["member" as const],
    ["billing" as const],
    ["viewer" as const],
  ])(
    "offers an org %s exactly the rule writes its contracts grant",
    async (role) => {
      await renderRules(readOk(approvalRuleSet()), viewer(role, "owner"));
      expect({
        set_approval_rules:
          screen.queryByTestId("rule-create-open") !== null &&
          screen.queryByTestId("rule-edit-small-refunds") !== null,
        set_approval_rule_enabled:
          screen.queryByTestId("rule-toggle-small-refunds") !== null,
        delete_approval_rule:
          screen.queryByTestId("rule-delete-small-refunds") !== null,
      }).toEqual({
        set_approval_rules: orgGrants(approvalRuleSetContract, role),
        set_approval_rule_enabled: orgGrants(approvalRuleEnabledSet, role),
        delete_approval_rule: orgGrants(approvalRuleDelete, role),
      });
    },
  );

  // The read's own roles, so the fixture above never hands a rule set to a
  // role the handler would refuse without the test saying which.
  it("reads for exactly the roles list_approval_rules grants", () => {
    expect(
      (
        ["owner", "admin", "compliance", "member", "billing", "viewer"] as const
      ).filter((role) => orgGrants(approvalRuleList, role)),
    ).toEqual(["owner", "admin", "compliance"]);
  });
});
