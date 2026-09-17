// @vitest-environment jsdom
// The Tools page body in each of its states on a fake DataSource: the loaded
// registry, the grants log, the switch board, each tab's empty state and every
// refusal a read can answer. A registry row prints what the record carries and
// nothing it does not — an unclassified version says so, a call count the
// store did not answer stays "not recorded" — and axe checks the state each
// test ends in (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Tools, ToolsLoading } = await import("./tools");
const { credentialGrantPage, killSwitchBoard, toolsSource, toolVersionPage } =
  await import("./tools.builders");

function viewer(orgRole: "owner" | "member") {
  return unsafeMint(WsCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
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

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Tools › tabs", () => {
  it("marks the registry as the default tab and counts the switches that are denying", async () => {
    await renderTools({
      versions: readOk(toolVersionPage()),
      killSwitches: board(),
    });
    const tabs = screen.getByRole("navigation", { name: "Tools sections" });
    expect(
      within(tabs).getByRole("link", { name: /Registry/ }),
    ).toHaveAttribute("aria-current", "page");
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
