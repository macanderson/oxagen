// @vitest-environment jsdom
// Agent IAM over a fake DataSource: the tiles and the identities table in
// their ok, empty, denied and error states and across pages, with an axe
// check in every one. A figure no store records has no column.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { agentPage, agentRow, agentsSource } from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  retireAgent: vi.fn(),
  rotateAgentCredential: vi.fn(),
  setAgentSuspended: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Agents } = await import("./agents");

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

async function renderAgents(
  reads: Parameters<typeof agentsSource>[0],
  cursor: string | null = null,
) {
  const { source, calls } = agentsSource(reads);
  const element = await Agents({ ctx, source, cursor });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

const identities = () =>
  screen.getByRole("region", { name: "Registered in Core platform" });
const tiles = () => screen.queryAllByTestId("tile");

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Agents", () => {
  it("reads one identities page at the URL's cursor", async () => {
    const calls = await renderAgents({ list: agentPage([]) }, "c1");
    expect(calls.list).toEqual([[ctx, { cursor: "c1" }]]);
  });

  it("draws the workspace totals as three tiles", async () => {
    await renderAgents({ list: agentPage([agentRow()]) });
    expect(tiles().map((tile) => tile.textContent)).toEqual([
      "Identities here7registered in this workspace",
      "Enrolled2of 7 registered",
      "Tamper incidents3open, on this workspace's hosts",
    ]);
  });

  it("draws a recorded identity: its card links to the agent, and every cell carries what the store recorded", async () => {
    await renderAgents({ list: agentPage([agentRow()]) });
    const row = screen.getByTestId("agent-row");
    const cells = within(row).getAllByRole("cell");
    const card = within(cells[0] ?? row).getByRole("link");
    expect(card).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot",
    );
    expect(card).toHaveTextContent("acme.core.release-botRelease bot");
    expect(cells.map((c) => c.textContent)).toEqual([
      "reacme.core.release-botRelease bot",
      "Claude Code",
      "Operator",
      "enrolled",
      "42",
      "$12.50client_attested",
      "1",
      "EditDeregister",
    ]);
    expect(within(row).getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot?tab=definition",
    );
    expect(
      within(row).getByRole("button", { name: "Deregister" }),
    ).toBeInTheDocument();
  });

  it("has no column for a figure no store records: tier, belt, proven runs, mandates or a score (negative)", async () => {
    await renderAgents({ list: agentPage([agentRow()]) });
    expect(
      within(identities())
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Identity",
      "Harness",
      "Operator",
      "Status",
      "Runs 30d",
      "Spend 30d",
      "Incidents",
      "Actions",
    ]);
    expect(identities()).not.toHaveTextContent(
      /tier|belt|proven|mandate|trust|score/i,
    );
  });

  it("reads 'not recorded' for a missing key, operator and spend, and a missing basis as such", async () => {
    await renderAgents({
      list: agentPage([
        agentRow({ agentKey: null, operatorId: null, spend30d: null }),
        agentRow({
          id: "agt_other",
          slug: "other",
          spend30d: { micros: "1000000", currency: "USD", basis: null },
        }),
      ]),
    });
    const [first, second] = screen.getAllByTestId("agent-row");
    const firstCells = within(first ?? document.body).getAllByRole("cell");
    expect(firstCells[0]).toHaveTextContent("not recordedRelease bot");
    expect(firstCells[2]).toHaveTextContent("not recorded");
    expect(firstCells[5]).toHaveTextContent("not recorded");
    expect(
      within(second ?? document.body).getAllByRole("cell")[5],
    ).toHaveTextContent("$1.00basis not recorded");
  });

  it("offers no Deregister on a retired identity (negative)", async () => {
    await renderAgents({ list: agentPage([agentRow({ status: "retired" })]) });
    const row = screen.getByTestId("agent-row");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).getByText("retired")).toBeInTheDocument();
  });

  it("shows the empty state for a workspace with no identity on the first page", async () => {
    await renderAgents({ list: agentPage([]) });
    const empty = screen.getByTestId("agents-empty");
    expect(empty).toHaveTextContent(
      "No identities registered in Core platform",
    );
    expect(empty).toHaveTextContent("oxagen agent register");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("links to the next page, and back to the first from a later one", async () => {
    await renderAgents({ list: agentPage([agentRow()], "c2") });
    const pager = screen.getByRole("navigation", { name: "Identities pages" });
    expect(within(pager).getAllByRole("link")).toHaveLength(1);
    expect(
      within(pager).getByRole("link", { name: "More identities" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents?cursor=c2");
    cleanup();

    await renderAgents({ list: agentPage([], null) }, "c2");
    expect(screen.queryByTestId("agents-empty")).toBeNull();
    expect(
      screen.getByRole("link", { name: "First identities" }),
    ).toHaveAttribute("href", "/acme/core-platform/agents");
  });

  it("draws no pager for a single page (negative)", async () => {
    await renderAgents({ list: agentPage([agentRow()]) });
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("names the permission a denied read needed, with no tiles (negative)", async () => {
    await renderAgents({
      list: { ok: false, reason: "denied", permission: "agent.read" },
    });
    expect(tiles()).toHaveLength(0);
    expect(identities()).toHaveTextContent(
      "You cannot see Registered in Core platform in this workspace. Your roles do not include agent.read",
    );
  });

  it("names the error a failed read answered, with no tiles (negative)", async () => {
    await renderAgents({ list: readError("iam_principals_unavailable", 503) });
    expect(tiles()).toHaveLength(0);
    expect(identities()).toHaveTextContent(
      "Registered in Core platform could not be loaded: the control plane answered iam_principals_unavailable.",
    );
  });
});
