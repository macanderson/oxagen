// @vitest-environment jsdom
// Agents › Mandates over a fake DataSource: the mandates an agent holds, the
// state where it holds none and what that means for a call that carries a
// consequence, and the denied and error states of the ledger read, each with
// an axe check (INV-26). The request dialog's own submit is in
// mandate-request.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
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

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
});

async function renderMandates(mandates: Parameters<typeof agentsSource>[0]["mandates"]) {
  const { source, calls } = agentsSource({
    get: readOk(agentDetail()),
    mandates,
  });
  const element = await Agent({
    ctx,
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
    expect(
      within(held()).getByText(/older ones are not listed/),
    ).toHaveAttribute("data-state", "truncated");
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
});
