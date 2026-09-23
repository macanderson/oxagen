// @vitest-environment jsdom
// The Steering page over a fake DataSource: each tab makes only its own reads,
// Records in its ok, filtered, empty, paged, denied and error states,
// Proposals with their support and the writes each state allows, and Context
// PRs with the table and the selected proposal's panel, with an axe check in
// every one. The panel's own states are in context-pr-panel.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalStatus } from "@/data/contracts/steering";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  PROPOSAL_ID,
  publishedRecord,
  proposal,
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
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
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

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Steering } = await import("./steering");

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

async function renderSteering(
  searchParams: Record<string, string> = {},
  reads: Partial<SteeringReads> = {},
) {
  const { source, calls } = steeringSource(reads);
  const element = await Steering({ ctx, source, searchParams });
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

describe("tabs", () => {
  it("opens the Library by default and reads the records in force", async () => {
    const calls = await renderSteering();
    expect(calls).toEqual({
      records: [[ctx, { kind: null, offset: 0 }]],
      record: [],
      proposals: [],
      contextPr: [],
      freshness: [],
      deliveries: [],
    });
    const tabs = screen.getByRole("navigation", { name: "Steering views" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((link) => [
          link.textContent,
          link.getAttribute("href"),
          link.getAttribute("aria-current"),
        ]),
    ).toEqual([
      ["Library", `${BASE}/library`, "page"],
      ["Proposals", `${BASE}/proposals`, null],
      ["Freshness", `${BASE}/freshness`, null],
      ["Delivery", `${BASE}/deliveries`, null],
    ]);
  });

  it("opens Settings from the URL and reads only its workspace controls", async () => {
    const calls = await renderSteering({ tab: "settings" });
    expect(calls).toEqual({
      record: [],
      records: [],
      proposals: [],
      contextPr: [],
      freshness: [[ctx]],
      deliveries: [],
    });
    expect(screen.getByRole("link", { name: "Freshness" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(section("Steering freshness")).toBeVisible();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(
      screen.queryByRole("region", { name: "Published records" }),
    ).toBeNull();
  });

  it.each(["records", "skills", "proposals", "prs"])(
    "keeps workspace settings off the %s tab",
    async (tab) => {
      const calls = await renderSteering({ tab });
      expect(calls.freshness).toEqual([]);
      expect(
        screen.queryByRole("region", { name: "Steering freshness" }),
      ).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
    },
  );

  it("shows settings read failures inside the selected tab", async () => {
    await renderSteering({ tab: "settings" }, { freshness: DOWN });
    expect(
      screen.getByText(
        "Settings could not be loaded: record_index_unavailable. Nothing was changed.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Freshness" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens Skills, hands the inventory the page the URL names, and reads no record or proposal", async () => {
    const calls = await renderSteering({ tab: "skills", cursor: "c2" });
    expect(calls.records).toEqual([]);
    expect(calls.proposals).toEqual([]);
    expect(Skills.mock.calls.at(-1)?.[0]).toMatchObject({ ctx, cursor: "c2" });
    expect(screen.getByTestId("skills-tab")).toHaveAttribute(
      "data-cursor",
      "c2",
    );
    expect(screen.getByRole("link", { name: "Skills" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("falls back to Records for a tab it does not know and reads no Context PR outside its tab (negative)", async () => {
    const calls = await renderSteering({
      tab: "effect",
      proposal: PROPOSAL_ID,
    });
    expect(calls.records).toHaveLength(1);
    expect(calls.proposals).toEqual([]);
    expect(calls.contextPr).toEqual([]);
  });
});

describe("Records", () => {
  it("prints each record's statement, classification, scope, lineage, version, commit, file and publication", async () => {
    await renderSteering();
    const card = within(section("Published records")).getByRole("article");
    expect(card).toHaveAttribute("data-kind", "constraint");
    expect(card).toHaveTextContent(
      "Do not re-read CHANGELOG.md after the first read in a run.",
    );
    expect(card.querySelector('[data-term="force"]')).toHaveTextContent(
      "force must",
    );
    expect(
      card.querySelector('[data-term="constraint-effect"]'),
    ).toHaveTextContent("forbid");
    expect(card.querySelector('[data-term="scope"]')).toHaveTextContent(
      "workspace",
    );
    expect(card.querySelector('[data-fact="version"] dd')).toHaveTextContent(
      "3",
    );
    expect(card.querySelector('[data-fact="commit"] dd')).toHaveTextContent(
      "4d5e6f7a8b9c",
    );
    expect(card.querySelector('[data-fact="path"] dd')).toHaveTextContent(
      ".oxagen/rules/ctx.release.no-reread-changelog.toml",
    );
    expect(
      card.querySelector('[data-fact="published"] dd'),
    ).not.toBeEmptyDOMElement();
  });

  it("prints unclassified and the title for a record no Context PR wrote, with no fact it lacks", async () => {
    await renderSteering(
      {},
      {
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
      },
    );
    const card = within(section("Published records")).getByRole("article");
    expect(card).toHaveAttribute("data-kind", "unclassified");
    expect(card).toHaveTextContent("Read CHANGELOG.md once per run");
    expect(card.querySelector('[data-term="force"]')).toBeNull();
    expect(card.querySelector("[data-fact]")).toBeNull();
  });

  it("links every kind, marks the one the URL asks for and reads that kind", async () => {
    const calls = await renderSteering({ kind: "rule" });
    expect(calls.records).toEqual([[ctx, { kind: "rule", offset: 0 }]]);
    const filter = screen.getByRole("navigation", {
      name: "Filter records by kind",
    });
    const links = within(filter).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `${BASE}/library/records`,
      `${BASE}/library/records?kind=rule`,
      `${BASE}/library/records?kind=constraint`,
      `${BASE}/library/records?kind=procedure`,
      `${BASE}/library/records?kind=fact`,
      `${BASE}/library/records?kind=memory`,
      `${BASE}/library/records?kind=preference`,
    ]);
    expect(
      links.filter((link) => link.getAttribute("aria-current") === "page"),
    ).toEqual([within(filter).getByRole("link", { name: "rule" })]);
  });

  it("says no record of a kind is in force and keeps the filter", async () => {
    await renderSteering(
      { kind: "procedure" },
      { records: readOk({ records: [], total: 0 }) },
    );
    const records = section("Published records");
    expect(records).toHaveTextContent(
      "No record of that kind is in force in this workspace.",
    );
    expect(
      within(records).getByRole("navigation", {
        name: "Filter records by kind",
      }),
    ).toBeInTheDocument();
  });

  it("says nothing steers a workspace with no record in force", async () => {
    await renderSteering({}, { records: readOk({ records: [], total: 0 }) });
    const empty = section("Nothing steers this workspace yet");
    expect(empty).toHaveTextContent(
      "Published records live in .oxagen/rules/ on the workspace repository.",
    );
    expect(
      screen.queryByRole("navigation", { name: "Filter records by kind" }),
    ).toBeNull();
  });

  it("pages by fifty with the range, keeping the kind", async () => {
    const calls = await renderSteering(
      { kind: "constraint", offset: "50" },
      {
        records: readOk({
          records: Array.from({ length: 2 }, (_, i) =>
            publishedRecord({ id: `ctr_r${String(i)}` }),
          ),
          total: 120,
        }),
      },
    );
    expect(calls.records).toEqual([[ctx, { kind: "constraint", offset: 50 }]]);
    const pager = screen.getByRole("navigation", { name: "Pages" });
    expect(pager).toHaveTextContent("51 to 52 of 120");
    expect(
      within(pager).getByRole("link", { name: "Previous page" }),
    ).toHaveAttribute("href", `${BASE}/library/records?kind=constraint`);
    expect(
      within(pager).getByRole("link", { name: "Next page" }),
    ).toHaveAttribute(
      "href",
      `${BASE}/library/records?kind=constraint&offset=100`,
    );
  });

  it("shows no pager when one page holds every record (negative)", async () => {
    await renderSteering();
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
  });

  it.each([
    [
      "denied",
      DENIED,
      "You cannot see Published records in this workspace. The roles you hold do not include steering.read.",
    ],
    [
      "error",
      DOWN,
      "Published records could not be loaded: record_index_unavailable. Nothing was changed.",
    ],
  ] as const)(
    "renders a %s read in place of the records",
    async (reason, read, text) => {
      await renderSteering({}, { records: read });
      const records = section("Published records");
      expect(records.querySelector("[data-reason]")).toHaveAttribute(
        "data-reason",
        reason,
      );
      expect(records).toHaveTextContent(text);
    },
  );
});

describe("Proposals", () => {
  it("reads one page of proposals and nothing else, and prints each with its state, tally, source, rationale and support", async () => {
    const calls = await renderSteering({ tab: "proposals" });
    expect(calls).toEqual({
      record: [],
      records: [],
      proposals: [[ctx, { offset: 0 }]],
      contextPr: [],
      freshness: [],
      deliveries: [],
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
    await renderSteering({ tab: "proposals" });
    expect(
      screen.getByRole("link", { name: "Context PR #519" }),
    ).toHaveAttribute(
      "href",
      `${BASE}/proposals?proposal=${PROPOSAL_ID}&section=prs`,
    );
  });

  it.each<[ProposalStatus, string[]]>([
    ["proposed", ["Open a Context PR", "Dismiss"]],
    ["pr_open", ["Run the checks again", "Dismiss"]],
    ["checks_failed", ["Run the checks again", "Dismiss"]],
    ["checks_passed", ["Run the checks again", "Dismiss"]],
    ["merged", []],
    ["rejected", []],
  ])("offers a %s proposal exactly its writes", async (status, writes) => {
    await renderSteering(
      { tab: "proposals" },
      {
        proposals: readOk({
          proposals: [proposal({ status, pr: null, checks: null })],
          total: 1,
        }),
      },
    );
    expect(
      within(screen.getByRole("article"))
        .queryAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(writes);
  });

  it("says a workspace has no proposals, and how one is raised", async () => {
    await renderSteering(
      { tab: "proposals" },
      { proposals: readOk({ proposals: [], total: 0 }) },
    );
    expect(section("No proposals in this workspace")).toHaveTextContent(
      "a person proposes one with oxagen context propose",
    );
  });

  it("renders a denied read in place of the proposals", async () => {
    await renderSteering({ tab: "proposals" }, { proposals: DENIED });
    expect(section("Proposals")).toHaveTextContent(
      "You cannot see Proposals in this workspace.",
    );
  });
});

describe("Context PRs", () => {
  it("lists only the proposals with a pull request and reads no Context PR until one is selected", async () => {
    const calls = await renderSteering(
      { tab: "prs" },
      {
        proposals: readOk({
          proposals: [
            proposal(),
            proposal({ id: "prp_01k5rv9z", status: "proposed", pr: null }),
          ],
          total: 2,
        }),
      },
    );
    expect(calls.proposals).toEqual([[ctx, { offset: 0 }]]);
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
    ).toHaveAttribute(
      "href",
      `${BASE}/proposals?proposal=${PROPOSAL_ID}&section=prs`,
    );
    expect(
      screen.queryByRole("region", { name: /^Context PR for/ }),
    ).toBeNull();
  });

  it("reads the Context PR of the proposal the URL selects, marks its row and renders its panel", async () => {
    const calls = await renderSteering({ tab: "prs", proposal: PROPOSAL_ID });
    expect(calls.contextPr).toEqual([[ctx, PROPOSAL_ID]]);
    expect(
      screen.getByRole("link", { name: "#519 on acme/core-platform" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      section("Context PR for ctx.release.no-reread-changelog"),
    ).toHaveAttribute("data-status", "checks_passed");
  });

  it("reads no Context PR for a malformed proposal id (negative)", async () => {
    const calls = await renderSteering({ tab: "prs", proposal: "prp_1;drop" });
    expect(calls.contextPr).toEqual([]);
  });

  it("says no proposal on the page has a pull request", async () => {
    await renderSteering(
      { tab: "prs" },
      {
        proposals: readOk({
          proposals: [proposal({ status: "proposed", pr: null })],
          total: 1,
        }),
      },
    );
    expect(section("Context PRs")).toHaveTextContent(
      "No proposal on this page has a Context PR.",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders an error read in place of the table", async () => {
    await renderSteering({ tab: "prs" }, { proposals: DOWN });
    expect(section("Context PRs")).toHaveTextContent(
      "Context PRs could not be loaded: record_index_unavailable.",
    );
  });
});

describe("Delivery", () => {
  it("reads only delivery counts and distinguishes missing manifests from zero delivery", async () => {
    const calls = await renderSteering({ tab: "deliveries" });
    expect(calls.deliveries).toEqual([[ctx]]);
    expect(calls.records).toEqual([]);
    expect(
      screen.getByText(/No steering manifests were recorded/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Delivery" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  it("renders counts per run and names records cut from the bounded sample", async () => {
    await renderSteering(
      { tab: "deliveries" },
      {
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
      },
    );
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
    await renderSteering({ tab: "deliveries" }, { deliveries: read });
    expect(
      document.querySelector(`[data-reason="${read.reason}"]`),
    ).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
