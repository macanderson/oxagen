// @vitest-environment jsdom
// The two dialogs the mandate header opens, as the design draws them:
// `mandateedit` (per call, per period, approval above, valid to; Cancel and
// Save) and `mandaterevoke` (what is reserved, what already settled, the ledger
// kept; Cancel and Revoke it).
//
// The change dialog's one seam is the baseline: every editable field is
// prefilled from the mandate the page read and carried back beside a hidden
// copy of that prefill, so the action can send only what the operator changed
// (ADR-102). The cases below prove the two halves meet; what the action does
// with them is pinned in actions.test.ts.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MandateRow } from "@/data/contracts/mandates";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  callsAuthority,
  mandateAuthority,
  mandateRow,
} from "@/test/mandate-views";

const { router, changeMandateLimits, revokeMandate } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  changeMandateLimits: vi.fn(),
  revokeMandate: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ changeMandateLimits, revokeMandate }));

const { MandateActions } = await import("./mandate-actions");

/** $250 a call, $2,000 a month, approval above $100, and a calls cap beside it. */
const mandate = mandateRow({
  authority: [mandateAuthority(), callsAuthority()],
});

// A fixed instant inside the fixture's window, as the page passes it down.
const NOW = new Date("2026-10-01T00:00:00.000Z");
const here = routes.mandate("acme", "core-platform", mandate.id);

function actions(row: MandateRow, now: Date) {
  return (
    <IntlProvider>
      <MandateActions
        org="acme"
        ws="core-platform"
        mandate={row}
        now={now}
        here={here}
        agentKey="a-intel.finops.invoice-bot"
      />
    </IntlProvider>
  );
}

function draw(row: MandateRow = mandate, now: Date = NOW) {
  return render(actions(row, now));
}

const editDialog = () => screen.getByTestId("change-limits");
const revokeDialog = () => screen.getByTestId("revoke-mandate");

async function click(name: string) {
  // `delay: null` keeps every interaction synchronous under the coverage run.
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("button", { name }));
  return user;
}

// Valid to opens on the last day before the fixture's exclusive end,
// 2026-12-31T00:00Z, in the provider's zone (UTC).
const PREFILLED = {
  perCall: "250.00",
  perPeriod: "2000.00",
  approvalAbove: "100.00",
  validTo: "2026-12-30",
};

beforeEach(() => {
  router.replace.mockReset();
  changeMandateLimits.mockReset();
  changeMandateLimits.mockResolvedValue({
    ok: true,
    value: { mandateId: mandate.id, status: "active" },
  });
  revokeMandate.mockReset();
  revokeMandate.mockResolvedValue({
    ok: true,
    value: { mandateId: mandate.id, status: "revoked" },
  });
});
afterEach(cleanup);

describe("MandateActions", () => {
  it("draws Change limits as an ordinary button and Revoke as a danger one, neither gold", () => {
    draw();
    const change = screen.getByRole("button", { name: "Change limits" });
    const revoke = screen.getByRole("button", { name: "Revoke" });
    expect(change.className).not.toContain("bg-button-primary-bg");
    expect(revoke.className).not.toContain("bg-button-primary-bg");
    expect(revoke.className).toContain("text-error-ink");
  });

  it("hides Change limits once the window has closed, and keeps Revoke", () => {
    draw(mandate, new Date("2027-01-01T00:00:00.000Z"));
    expect(
      screen.queryByRole("button", { name: "Change limits" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });
});

describe("mandateedit", () => {
  it("opens titled with the mandate's id, fields in the measure's unit, and Cancel beside Save", async () => {
    draw();
    await click("Change limits");
    const form = editDialog();
    expect(within(form).getByText("Edit mnd_4f2a9c")).toBeInTheDocument();
    expect(
      within(form).getByText("a-intel.finops.invoice-bot"),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText("Per call (USD)")).toHaveValue("250.00");
    expect(within(form).getByLabelText("Per month (USD)")).toHaveValue(
      "2000.00",
    );
    expect(within(form).getByLabelText("Approval above (USD)")).toHaveValue(
      "100.00",
    );
    expect(within(form).getByLabelText("Valid to")).toHaveValue("2026-12-30");
    expect(form).toHaveTextContent(
      "A call above this parks for a human, and no rule elsewhere can release it.",
    );
    expect(form).toHaveTextContent(
      "Lowering a ceiling below what is already reserved does not claw the reservation back. It applies from the next call.",
    );
    // The design's header close, labelled, beside the footer's Cancel.
    expect(
      within(form).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
    expect(form).toHaveAttribute("aria-modal", "true");
    expect(
      within(form).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
    expect(
      within(form).getByRole("button", { name: "Save" }),
    ).toBeInTheDocument();
    expect(form).toHaveAttribute("role", "dialog");
    await expectNoAxe(document.body);
  });

  it("carries every prefill back as the baseline for the field beside it", async () => {
    draw();
    const user = await click("Change limits");
    await user.click(
      within(editDialog()).getByRole("button", { name: "Save" }),
    );
    expect(changeMandateLimits).toHaveBeenCalledWith("acme", "core-platform", {
      mandateId: mandate.id,
      measure: "amount",
      ...PREFILLED,
      baseline: PREFILLED,
    });
  });

  it("sends what the operator typed beside the prefill it replaced, then reloads the page", async () => {
    draw();
    const user = await click("Change limits");
    const form = editDialog();
    await user.clear(within(form).getByLabelText("Per month (USD)"));
    await user.type(within(form).getByLabelText("Per month (USD)"), "1500");
    fireEvent.change(within(form).getByLabelText("Valid to"), {
      target: { value: "2027-03-31" },
    });
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(changeMandateLimits).toHaveBeenCalledWith("acme", "core-platform", {
      mandateId: mandate.id,
      measure: "amount",
      ...PREFILLED,
      perPeriod: "1500",
      validTo: "2027-03-31",
      baseline: PREFILLED,
    });
    expect(router.replace).toHaveBeenCalledWith(here);
    // The write that landed says so: the mandate, and where it is recorded.
    const outcome = screen.getByTestId("mandate-outcome");
    expect(outcome).toHaveAttribute("role", "status");
    expect(outcome).toHaveTextContent(
      "mnd_4f2a9c has its new limits. They apply from the next call. Open the audit record",
    );
    expect(
      within(outcome).getByRole("link", { name: "Open the audit record" }),
    ).toHaveAttribute("href", "/acme/audit?capability=update_mandate_limits");
  });

  it("edits the calls cap in calls when that is the mandate's only limit", async () => {
    draw(
      mandateRow({
        authority: [callsAuthority()],
        approval: { humanAbove: [], alwaysHumanFor: [], approvers: [] },
      }),
    );
    await click("Change limits");
    const form = editDialog();
    expect(within(form).getByLabelText("Per day (calls)")).toHaveValue("50");
    expect(within(form).getByLabelText("Approval above (calls)")).toHaveValue(
      "",
    );
  });

  it("names a refusal in the dialog and does not navigate (negative)", async () => {
    changeMandateLimits.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    draw();
    const user = await click("Change limits");
    await user.click(
      within(editDialog()).getByRole("button", { name: "Save" }),
    );
    expect(
      within(editDialog()).getByTestId("change-limits-failure"),
    ).toHaveTextContent("not accountable for this mandate's consequences");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("says the write went unanswered when the action throws (negative)", async () => {
    changeMandateLimits.mockRejectedValue(new Error("network"));
    draw();
    const user = await click("Change limits");
    await user.click(
      within(editDialog()).getByRole("button", { name: "Save" }),
    );
    expect(
      within(editDialog()).getByTestId("change-limits-failure"),
    ).toBeInTheDocument();
  });
});

describe("mandaterevoke", () => {
  it("names what is reserved and what already settled, and keeps the ledger", async () => {
    draw();
    await click("Revoke");
    const form = revokeDialog();
    expect(within(form).getByText("Revoke mnd_4f2a9c?")).toBeInTheDocument();
    expect(within(form).getByTestId("revoke-warning")).toHaveTextContent(
      "a-intel.finops.invoice-bot can move no money after this. $180.00 is reserved, and a call that has not dispatched gives its share back now. $1,204.18 already settled and stays on the ledger.",
    );
    expect(form).toHaveTextContent(
      "The ledger is kept, never deleted. A revoked mandate still answers for every draw it made.",
    );
    expect(
      within(form).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
    // The design draws the confirmation as a danger button, not gold.
    const confirm = within(form).getByRole("button", { name: "Revoke it" });
    expect(confirm.className).toContain("text-error-ink");
    expect(confirm.className).not.toContain("bg-button-primary-bg");
    expect(
      within(form).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
    await expectNoAxe(document.body);
  });

  it("revokes this mandate with the reason written, then reloads the page and says so", async () => {
    const view = draw();
    const user = await click("Revoke");
    const form = revokeDialog();
    await user.type(within(form).getByLabelText("Reason"), "vendor offboarded");
    await user.click(within(form).getByRole("button", { name: "Revoke it" }));
    expect(revokeMandate).toHaveBeenCalledWith("acme", "core-platform", {
      mandateId: mandate.id,
      reason: "vendor offboarded",
    });
    expect(router.replace).toHaveBeenCalledWith(here);
    // The refreshed record reads revoked: the buttons go and the line stays.
    view.rerender(actions(mandateRow({ status: "revoked" }), NOW));
    expect(
      screen.queryByRole("button", { name: "Revoke" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mandate-outcome")).toHaveTextContent(
      "mnd_4f2a9c is revoked.",
    );
  });

  it("declines a draft and claims nothing about money", async () => {
    draw(mandateRow({ status: "draft", grantedBy: null }));
    const user = await click("Decline");
    const form = revokeDialog();
    expect(within(form).getByText("Decline mnd_4f2a9c?")).toBeInTheDocument();
    expect(
      within(form).queryByTestId("revoke-warning"),
    ).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("Reason"), "not needed");
    await user.click(within(form).getByRole("button", { name: "Decline it" }));
    expect(revokeMandate).toHaveBeenCalledOnce();
  });

  it("names a refusal and does not navigate (negative)", async () => {
    revokeMandate.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "mandate_ended",
    });
    draw();
    const user = await click("Revoke");
    const form = revokeDialog();
    await user.type(within(form).getByLabelText("Reason"), "x");
    await user.click(within(form).getByRole("button", { name: "Revoke it" }));
    expect(
      within(form).getByTestId("revoke-mandate-failure"),
    ).toHaveTextContent("already ended");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
