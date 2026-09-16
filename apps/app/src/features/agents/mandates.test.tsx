// @vitest-environment jsdom
// Agents › Mandates over a fake DataSource: the mandates an agent holds, the
// state where it holds none and what that means for a call that carries a
// consequence, and the denied and error states of the ledger read, each with
// an axe check (INV-26). The request dialog's own submit is in
// mandate-request.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { AgentStatus } from "@/data/contracts/agents";
import type { OrgRole } from "@/data/contracts/common";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  callsAuthority,
  mandateAuthority,
  mandateList,
  mandateRow,
} from "@/test/mandate-views";
import { agentDetail, agentsSource } from "./agents.builders";

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
  requestMandate: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Agent } = await import("./agent");

const viewer = (orgRole: OrgRole) =>
  unsafeMint(WsCtx, {
    userId: "usr_marcusbell",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
  });

const ctx = viewer("owner");

async function renderMandates(
  mandates: Parameters<typeof agentsSource>[0]["mandates"],
  as: OrgRole = "owner",
  status: AgentStatus = "enrolled",
) {
  const { source, calls } = agentsSource({
    get: readOk(agentDetail({ identity: { status } })),
    mandates,
  });
  const element = await Agent({
    ctx: as === "owner" ? ctx : viewer(as),
    source,
    agent: "release-bot",
    tab: "mandates",
    cursor: null,
  });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

const held = () => screen.getByRole("region", { name: /mandate/i });

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Agents › Mandates", () => {
  it("reads only this agent's mandates, by its public id", async () => {
    const calls = await renderMandates(mandateList([mandateRow()]));
    expect(calls.mandates).toEqual([[ctx, { agentId: "agt_releasebot" }]]);
    expect(calls.toolbelt).toEqual([]);
    expect(calls.incidents).toEqual([]);
  });

  it("lists each mandate with its consequence, limits, remaining and expiry", async () => {
    await renderMandates(mandateList([mandateRow()]));
    const row = within(held()).getByTestId("agent-mandate");
    expect(row).toHaveAttribute("data-status", "active");
    const text = row.textContent;
    for (const figure of [
      "mnd_4f2a9c",
      "moves_money",
      "$250.00",
      "$2,000.00",
      "$615.82",
      "active",
    ]) {
      expect(text).toContain(figure);
    }
  });

  it("prints every measure a mandate limits", async () => {
    await renderMandates(
      mandateList([
        mandateRow({ authority: [mandateAuthority(), callsAuthority()] }),
      ]),
    );
    const row = within(held()).getByTestId("agent-mandate");
    expect(row.textContent).toContain("50 calls");
    expect(row.textContent).toContain("38 calls");
  });

  it("says what an agent with no mandate cannot do, and offers the request", async () => {
    await renderMandates(mandateList([]));
    const section = held();
    expect(within(section).getByRole("heading")).toHaveTextContent(
      "No mandate",
    );
    expect(
      within(section).getByText(/cannot carry a consequence/),
    ).toHaveAttribute("data-state", "empty");
    expect(
      within(section).getByText(/denied before dispatch/),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Request a mandate" }),
    ).toBeInTheDocument();
  });

  it("says older mandates are not listed when the answer filled its page (negative)", async () => {
    await renderMandates(mandateList([mandateRow()], 100));
    const line = within(held()).getByText(/older ones are not listed/);
    expect(line).toHaveAttribute("data-state", "incomplete");
    expect(line).toHaveAttribute("data-blind-spot", "truncated");
  });

  it("says who may read the ledger when the viewer may not (negative)", async () => {
    await renderMandates({
      ok: false,
      reason: "denied",
      permission: "org.billing",
    });
    expect(within(held()).getByText(/org\.billing/)).toHaveAttribute(
      "data-reason",
      "denied",
    );
  });

  it("names the code the ledger answered when it is down (negative)", async () => {
    await renderMandates(readError("mandate_ledger_unavailable", 503));
    expect(
      within(held()).getByText(/mandate_ledger_unavailable/),
    ).toHaveAttribute("data-reason", "error");
  });

  // `readerFilter` narrows a non-accountable reader's answer to the agents
  // they created and reports the narrowing as a successful list, so an empty
  // answer to such a reader does not establish that the agent holds nothing.
  // The "No mandate" state is a claim about the agent's authority, and only a
  // reader who sees every mandate may be shown it.
  it.each([["member" as const], ["viewer" as const]])(
    "does not tell a %s that the agent holds no mandate (negative)",
    async (role) => {
      await renderMandates(mandateList([]), role);
      const section = held();
      expect(within(section).getByRole("heading")).toHaveTextContent(
        "No mandate listed",
      );
      expect(
        within(section).getByText(/not every mandate recorded for this agent/),
      ).toHaveAttribute("data-blind-spot", "reader_scope");
      expect(
        within(section).getByText(/not a statement that the agent holds no/),
      ).toHaveAttribute("data-state", "empty");
      expect(
        within(section).queryByText(/cannot carry a consequence/),
      ).not.toBeInTheDocument();
      expect(
        within(section).getByText(/Owner, Admin, Billing or Compliance/),
      ).toBeInTheDocument();
    },
  );

  it.each([["admin" as const], ["billing" as const], ["compliance" as const]])(
    "tells a %s the agent holds no mandate, because their answer is every one",
    async (role) => {
      await renderMandates(mandateList([]), role);
      expect(
        within(held()).getByText(/cannot carry a consequence/),
      ).toHaveAttribute("data-state", "empty");
    },
  );

  // Incompleteness is a property of the answer, not of its length: a narrowed
  // reader answered rows is looking at a subset, and the table above would
  // otherwise read as every mandate the agent holds.
  it("still says the list is partial when a narrowed reader is answered rows", async () => {
    await renderMandates(mandateList([mandateRow()]), "member");
    const section = held();
    expect(
      within(section).getByText(/not every mandate recorded for this agent/),
    ).toHaveAttribute("data-blind-spot", "reader_scope");
    // Its authority is established, so nothing claims otherwise.
    expect(within(section).queryByText(/not a statement/)).toBeNull();
    expect(within(section).getByTestId("agent-mandate")).toBeInTheDocument();
  });

  it("says nothing of the sort to an accountable reader answered rows", async () => {
    await renderMandates(mandateList([mandateRow()]), "owner");
    expect(
      within(held()).queryByText(/not every mandate recorded for this agent/),
    ).toBeNull();
  });

  // A row is not authority. `request_mandate` writes a draft, so a page that
  // counted rows stopped warning at the moment the operator asked — the moment
  // the agent still has none. Revoked and expired rows are history, and an
  // active row granted ahead of its start day is not in effect yet.
  it.each([
    ["draft" as const, {}],
    ["revoked" as const, {}],
    ["expired" as const, {}],
    [
      "active" as const,
      {
        validFrom: "2026-10-01T00:00:00.000Z",
        validTo: "2026-10-31T00:00:00.000Z",
      },
    ],
    [
      "active" as const,
      {
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-06-30T00:00:00.000Z",
      },
    ],
  ])(
    "still says a %s mandate carries no consequence, and lists it (negative)",
    async (status, window) => {
      await renderMandates(mandateList([mandateRow({ status, ...window })]));
      const section = held();
      expect(within(section).getByRole("heading")).toHaveTextContent(
        "No mandate",
      );
      expect(
        within(section).getByText(/cannot carry a consequence/),
      ).toHaveAttribute("data-state", "empty");
      // The row is still shown: the request and the history are the record.
      expect(within(section).getByTestId("agent-mandate")).toHaveAttribute(
        "data-status",
        status,
      );
    },
  );

  it("says nothing of the kind while one mandate is in effect", async () => {
    await renderMandates(
      mandateList([mandateRow({ status: "draft" }), mandateRow()]),
    );
    const section = held();
    expect(within(section).getByRole("heading")).toHaveTextContent(
      "Mandates recorded",
    );
    expect(
      within(section).queryByText(/cannot carry a consequence/),
    ).toBeNull();
  });

  // The page is newest-first and stops at its bound, so a hundred newer drafts
  // can push the one mandate still in effect off it. Every row present
  // authorizes nothing, and saying "No mandate" from that is asserting a fact
  // about the agent from the place the read happened to stop.
  it("will not say the agent holds none when the page was truncated (negative)", async () => {
    // Truncation is "the answer filled the page it asked for", so three rows
    // and a bound of three is the same state as a hundred and a hundred.
    await renderMandates(
      mandateList(
        Array.from({ length: 3 }, () => mandateRow({ status: "draft" })),
        3,
      ),
    );
    const section = held();
    const line = within(section).getByText(/older ones are not listed/);
    expect(line).toHaveAttribute("data-blind-spot", "truncated");
    expect(line.textContent).toContain("3");
    expect(
      within(section).getByText(/not a statement that the agent holds no/),
    ).toHaveAttribute("data-state", "empty");
    expect(
      within(section).queryByText(/cannot carry a consequence/),
    ).toBeNull();
  });

  it("says it plainly when nothing is in effect and nothing is missing", async () => {
    await renderMandates(mandateList([mandateRow({ status: "draft" })]));
    const state = within(held()).getByText(/cannot carry a consequence/);
    expect(state).toHaveAttribute("data-state", "empty");
    expect(state).not.toHaveAttribute("data-blind-spot");
    expect(within(held()).queryByText(/is not complete/)).toBeNull();
  });

  it("stays quiet about the page bound while a mandate is in effect", async () => {
    await renderMandates(mandateList([mandateRow()], 100));
    expect(within(held()).queryByText(/may be older than the page/)).toBeNull();
  });

  // Retirement archives the agent and suspends its principal, and neither
  // mandate handler resolves that status — so the write would succeed and put
  // real authority in the ledger against an identity that can never run.
  it("does not offer the request on a retired identity (negative)", async () => {
    await renderMandates(mandateList([mandateRow()]), "owner", "retired");
    const section = held();
    expect(
      within(section).queryByRole("button", { name: "Request a mandate" }),
    ).toBeNull();
    expect(
      within(section).getByText(/cannot be given a mandate/),
    ).toHaveAttribute("data-state", "retired");
    // What it held is still the record and stays listed.
    expect(within(section).getByTestId("agent-mandate")).toBeInTheDocument();
  });

  it.each([
    ["enrolled" as const],
    ["unenrolled" as const],
    ["suspended" as const],
  ])("offers the request on a %s identity", async (status) => {
    await renderMandates(mandateList([mandateRow()]), "owner", status);
    const section = held();
    expect(
      within(section).getByRole("button", { name: "Request a mandate" }),
    ).toBeInTheDocument();
    expect(within(section).queryByText(/cannot be given a mandate/)).toBeNull();
  });

  // Two measures in one currency are two dollar figures, and which budget each
  // governs is the question the accountable reader is asking.
  it("names each measure when a mandate limits more than one", async () => {
    await renderMandates(
      mandateList([
        mandateRow({
          authority: [mandateAuthority(), mandateAuthority({ measure: "tax" })],
        }),
      ]),
    );
    const row = within(held()).getByTestId("agent-mandate");
    expect(row.textContent).toContain("amount");
    expect(row.textContent).toContain("tax");
  });

  // The name is not conditional on there being two. A lone `tax` limit under a
  // column headed Per call is an unlabelled dollar figure, with nothing on the
  // row to say which budget it governs.
  it("names the measure when a mandate limits exactly one", async () => {
    await renderMandates(
      mandateList([
        mandateRow({ authority: [mandateAuthority({ measure: "tax" })] }),
      ]),
    );
    const cells = within(held())
      .getByTestId("agent-mandate")
      .querySelectorAll("td");
    expect(cells[2]?.textContent).toBe("$250.00tax");
  });
});
