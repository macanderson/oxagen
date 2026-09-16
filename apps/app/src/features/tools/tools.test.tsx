// @vitest-environment jsdom
// The Tools page over a fake DataSource: the mandates ledger in its loaded,
// empty, denied and error states, with an axe check in every one. The figures
// are the ledger's, so a mandate with two measures prints both rather than
// picking one, and a mandate nobody has granted prints no granter.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { OrgRole } from "@/data/contracts/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MandateList } from "@/data/contracts/mandates";
import { type Read, readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  callsAuthority,
  mandateAuthority,
  mandateList,
  mandateRow,
  toolsSource,
} from "@/test/mandate-views";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Tools } = await import("./tools");

const viewer = (orgRole: OrgRole) =>
  unsafeMint(WsCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
  });

const ctx = viewer("billing");

afterEach(cleanup);

async function renderTools(read: Read<MandateList>, as: OrgRole = "billing") {
  const { source, calls } = toolsSource(read);
  const element = await Tools({
    ctx: as === "billing" ? ctx : viewer(as),
    source,
  });
  const { container } = render(<IntlProvider>{element}</IntlProvider>);
  return { container, calls };
}

const ledger = () => screen.getByRole("region", { name: "Mandates ledger" });

describe("Tools › mandates ledger", () => {
  it("reads every mandate in the workspace, not one agent's", async () => {
    const { calls } = await renderTools(mandateList([mandateRow()]));
    expect(calls).toEqual([[ctx, { agentId: null }]]);
  });

  it("prints the grant and what the ledger has settled, reserved and left", async () => {
    const { container } = await renderTools(mandateList([mandateRow()]));
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
    await expectNoAxe(container);
  });

  it("prints every measure of a mandate that limits more than one", async () => {
    await renderTools(
      mandateList([
        mandateRow({
          authority: [mandateAuthority(), callsAuthority()],
        }),
      ]),
    );
    const row = within(ledger()).getByTestId("mandate");
    expect(row.textContent).toContain("50 calls");
    expect(row.textContent).toContain("38 calls");
    expect(row.textContent).toContain("$2,000.00");
  });

  it("prints no granter for a request nobody has granted (negative)", async () => {
    await renderTools(
      mandateList([
        mandateRow({ status: "draft", grantedBy: null, roleAtGrant: null }),
      ]),
    );
    const row = within(ledger()).getByTestId("mandate");
    expect(row).toHaveAttribute("data-status", "draft");
    expect(row.textContent).toContain("not granted");
    expect(row.textContent).toContain("requested");
  });

  it("says a measure has no limit rather than printing a zero (negative)", async () => {
    await renderTools(
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
    const { container } = await renderTools(mandateList([mandateRow()], 100));
    const line = within(ledger()).getByText(/older ones are not listed/);
    expect(line).toHaveAttribute("data-state", "incomplete");
    expect(line).toHaveAttribute("data-blind-spot", "truncated");
    await expectNoAxe(container);
  });

  it("says nothing about older mandates when the answer was the whole set", async () => {
    await renderTools(mandateList([mandateRow()]));
    expect(
      within(ledger()).queryByText(/older ones are not listed/),
    ).toBeNull();
  });

  it("says the workspace has recorded no mandate, granted or requested", async () => {
    const { container } = await renderTools(mandateList([]));
    expect(within(ledger()).getByText(/recorded no mandate/)).toHaveAttribute(
      "data-state",
      "empty",
    );
    expect(within(ledger()).queryByRole("table")).toBeNull();
    await expectNoAxe(container);
  });

  it("says who may read the ledger when the viewer may not (negative)", async () => {
    const { container } = await renderTools({
      ok: false,
      reason: "denied",
      permission: "org.billing",
    });
    const failure = within(ledger()).getByText(/org\.billing/);
    expect(failure).toHaveAttribute("data-reason", "denied");
    await expectNoAxe(container);
  });

  it("names the code the ledger answered when it is down (negative)", async () => {
    const { container } = await renderTools(
      readError("mandate_ledger_unavailable", 503),
    );
    const failure = within(ledger()).getByText(/mandate_ledger_unavailable/);
    expect(failure).toHaveAttribute("data-reason", "error");
    await expectNoAxe(container);
  });

  // The workspace-wide read is narrowed for a non-accountable reader the same
  // way the per-agent one is, so an empty ledger is not proof of an empty
  // ledger unless the reader is one this page is written for.
  it.each([["member" as const], ["viewer" as const]])(
    "does not tell a %s that the workspace has granted nothing (negative)",
    async (role) => {
      const { container } = await renderTools(mandateList([]), role);
      expect(
        within(ledger()).getByText(/not every mandate this workspace has/),
      ).toHaveAttribute("data-blind-spot", "reader_scope");
      expect(
        within(ledger()).getByText(/not a statement that the workspace/),
      ).toHaveAttribute("data-state", "empty");
      expect(within(ledger()).queryByText(/recorded no mandate/)).toBeNull();
      await expectNoAxe(container);
    },
  );

  // Incompleteness does not depend on length: a narrowed reader answered rows
  // is looking at a subset under a lead that describes the whole ledger.
  it.each([["member" as const], ["viewer" as const]])(
    "says the ledger is partial to a %s answered rows (negative)",
    async (role) => {
      const { container } = await renderTools(
        mandateList([mandateRow()]),
        role,
      );
      expect(
        within(ledger()).getByText(/not every mandate this workspace has/),
      ).toHaveAttribute("data-blind-spot", "reader_scope");
      expect(within(ledger()).getByRole("table")).toBeInTheDocument();
      expect(within(ledger()).queryByText(/not a statement/)).toBeNull();
      await expectNoAxe(container);
    },
  );

  // The lead and the caveats describe whatever `list_mandates` returns, and it
  // returns every status — the table below labels a draft "requested". A lead
  // saying the workspace *has granted* these is false of a ledger holding only
  // drafts, which is what "has granted" hid: it carries no quantifier, so a
  // pass looking for "every" and "all" walked straight past it.
  it("describes a ledger of drafts without claiming any was granted", async () => {
    const { container } = await renderTools(
      mandateList([mandateRow({ status: "draft" })]),
    );
    const text = ledger().textContent;
    expect(text).toContain("has recorded");
    expect(text).not.toMatch(/has granted/);
    expect(within(ledger()).getByTestId("mandate").textContent).toContain(
      "requested",
    );
    await expectNoAxe(container);
  });

  it.each([
    ["draft" as const],
    ["active" as const],
    ["expired" as const],
    ["revoked" as const],
  ])("never says a %s row was granted", async (status) => {
    await renderTools(mandateList([mandateRow({ status })], 100));
    expect(ledger().textContent).not.toMatch(/has granted/);
  });

  it("says nothing of the sort to an accountable reader answered rows", async () => {
    await renderTools(mandateList([mandateRow()]), "owner");
    expect(
      within(ledger()).queryByText(/not every mandate this workspace has/),
    ).toBeNull();
  });

  it.each([["owner" as const], ["admin" as const], ["compliance" as const]])(
    "tells a %s the workspace has recorded none, because their answer is every one",
    async (role) => {
      await renderTools(mandateList([]), role);
      expect(within(ledger()).getByText(/recorded no mandate/)).toHaveAttribute(
        "data-state",
        "empty",
      );
    },
  );

  // The name is not conditional on there being two: a lone `tax` limit under a
  // column headed Per call is an unlabelled dollar figure.
  it("names the measure on a row that limits exactly one", async () => {
    await renderTools(
      mandateList([
        mandateRow({ authority: [mandateAuthority({ measure: "tax" })] }),
      ]),
    );
    expect(within(ledger()).getByTestId("mandate").textContent).toContain(
      "tax",
    );
  });
});
