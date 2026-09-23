// @vitest-environment jsdom
// The Policy tab (mockup `tools.md`): the policy versions the page states are
// not recorded yet, the auto-approval rules with their one gold action, the
// mandates ledger, and the three panels that describe where a version lives.
// The ledger and the rules were tabs of their own before the tabs became path
// segments; their suites carried over whole and now render the Policy tab.
// axe checks the state each test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPage } from "@/data/contracts/agents";
import type { OrgRole } from "@/data/contracts/common";
import type { MandateList } from "@/data/contracts/mandates";
import type { ApprovalRuleSet as ApprovalRuleSetView } from "@/data/contracts/tools";
import { type Read, readError, readOk } from "@/data/read";
import type { WsRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { GrantEffect } from "@oxagen/oxagen";
import { approvalRuleDelete } from "@oxagen/oxagen/contracts/approval_rule.delete";
import { approvalRuleEnabledSet } from "@oxagen/oxagen/contracts/approval_rule.enabled.set";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { approvalRuleSet as approvalRuleSetContract } from "@oxagen/oxagen/contracts/approval_rule.set";
import {
  callsAuthority,
  mandateAuthority,
  mandateList,
  mandateRow,
} from "@/test/mandate-views";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Tools } = await import("./tools");
const { agentPage, agentPageRow, approvalRuleSet, toolsSource } = await import(
  "./tools.builders"
);

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

function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}
const cardOf = (selector: string) =>
  element(document.querySelector(selector), selector);

/** The Policy tab, as the viewer given, on reads that default to their fixtures. */
async function renderPolicy(
  reads: Parameters<typeof toolsSource>[0],
  ctx = owner,
) {
  const { source, calls } = toolsSource(reads);
  const view = render(
    <IntlProvider>
      {await Tools({ ctx, source, tab: "policy", searchParams: {} })}
    </IntlProvider>,
  );
  return { ...view, calls };
}

/** The ledger, read by a Billing reader unless a test names another. */
async function renderLedger(
  mandates: Read<MandateList>,
  as: OrgRole = "billing",
) {
  return renderPolicy({ mandates }, viewer(as));
}

const ledger = () => screen.getByRole("region", { name: "Mandates ledger" });

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Tools › policy", () => {
  it("is the tab that is selected, with the rules as its one gold action", async () => {
    await renderPolicy({});
    const tabs = screen.getByRole("tablist", { name: "Tools sections" });
    expect(within(tabs).getByRole("tab", { name: "Policy" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // New tool yields the gold on a tab that carries its own primary.
    expect(screen.getByTestId("tools-new-tool-open").className).not.toContain(
      "bg-button-primary-bg",
    );
    expect(screen.getByTestId("rule-create-open").className).toContain(
      "bg-button-primary-bg",
    );
    expect(
      document.querySelectorAll('[class*="bg-button-primary-bg"]'),
    ).toHaveLength(1);
  });

  it("says policy versions are not recorded, names the store, and keeps Draft a version as a stub", async () => {
    await renderPolicy({});
    const panel = screen.getByRole("region", { name: "Policy versions" });
    expect(within(panel).getByText("tools.policy_versions")).toBeVisible();
    expect(
      within(panel).getByTestId("tools-policy-versions-not-backed"),
    ).toHaveAttribute("data-gap", "#3920");
    expect(within(panel).queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByTestId("tools-policy-draft-open"));
    const dialog = await screen.findByTestId("tools-policy-draft");
    expect(
      within(dialog).getByTestId("tools-policy-draft-confirm"),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(/Drafting a policy version is not built yet/),
    ).toBeVisible();
  });

  it("draws where a version lives, the conditions a rule may test and the sequence rule with its plain sentence", async () => {
    await renderPolicy({});
    const where = screen.getByRole("region", { name: "Where a version lives" });
    for (const term of [
      "Store",
      "In regulated mode",
      "Compiled from",
      "Who reads it",
      "What it writes",
    ]) {
      expect(within(where).getByText(term)).toBeVisible();
    }
    const conditions = screen.getByRole("region", {
      name: "Conditions a rule may test",
    });
    expect(within(conditions).getAllByRole("listitem")).toHaveLength(18);
    const sequence = screen.getByRole("region", { name: "Sequence rule" });
    expect(
      within(sequence).getByText(
        "A rule names the call it governs, then the condition that lets it through. This one denies a payment unless the same run already priced it.",
      ),
    ).toBeVisible();
    // The page names no policy language.
    expect(document.body.textContent).not.toMatch(/\bCedar\b|\bRego\b/);
  });

  it("offers a member no draft and no rule write", async () => {
    await renderPolicy({}, viewer("member"));
    expect(
      screen.queryByTestId("tools-policy-draft-open"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("rule-create-open")).not.toBeInTheDocument();
  });
});

describe("Tools › mandates ledger", () => {
  it("sits on the Policy tab and reads every mandate in the workspace, not one agent's", async () => {
    const { calls } = await renderLedger(mandateList([mandateRow()]));
    const ctx = viewer("billing");
    expect(calls.mandates).toEqual([[ctx, { agentId: null }]]);
    expect(
      within(screen.getByRole("tablist", { name: "Tools sections" })).getByRole(
        "tab",
        { name: "Policy" },
      ),
    ).toHaveAttribute("aria-selected", "true");
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
    return renderPolicy({ mandates, agents }, viewer(as));
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
    const picker = within(screen.getByTestId("grant-mandate")).getByLabelText(
      "Agent",
    );
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["agt_invoicebot"]);
  });

  it("says the picker holds one page when the agents read has more", async () => {
    await renderGrant(
      "owner",
      mandateList([mandateRow()]),
      readOk(agentPage([agentPageRow("invoice-bot")], "cursor_2")),
    );
    fireEvent.click(
      within(ledger()).getByRole("button", { name: "Grant a mandate" }),
    );
    expect(screen.getByTestId("grant-mandate")).toHaveTextContent(
      "The first page of this workspace's agents.",
    );
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
  return renderPolicy({ approvalRules }, ctx);
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
  it("sits on the Policy tab and makes the one rules read", async () => {
    const { calls } = await renderRules(readOk(approvalRuleSet()));
    expect(calls.approvalRules).toEqual([[owner]]);
    expect(rulesTable()).toBeVisible();
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

  it("draws no totals above the rules: every count is a row the reader can see", async () => {
    await renderRules(readOk(approvalRuleSet()));
    expect(document.querySelectorAll("[data-tile]")).toHaveLength(0);
    expect(within(ruleRow("small-refunds")).getByText("212")).toBeVisible();
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
    ).toHaveAttribute("href", "/acme/core-platform/tools/policy");
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
