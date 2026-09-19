// @vitest-environment jsdom
// The change-limits dialog's payload: what it prefills, and what it tells the
// action the operator actually changed.
//
// This suite exists for one seam. `measureDefaults` fills the measure, the unit,
// the window and both figures from the mandate the page read, and every one of
// those values is submitted whether or not the operator touched it. The handler
// merges whatever a change carries over the row it locks, so a prefill sent back
// as an edit restores a bound another operator may have lowered while this dialog
// was open (ADR-102, amended 2026-09-19). The dialog therefore carries each
// prefill back in a hidden field beside the one it fills, and
// `changeMandateLimits` compares the two. The cases below prove the two halves
// meet: that the baseline reaches the action, and that it is the string the
// operator saw. What the action then does with it is pinned in actions.test.ts.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** 50 rows a call, 1000 rows a month, 40 calls a day: three prefills. */
const bounded = mandateRow({
  authority: [
    mandateAuthority({
      measure: "rows",
      period: "monthly",
      perCall: { kind: "count", count: "50", unit: "rows" },
      perPeriod: { kind: "count", count: "1000", unit: "rows" },
    }),
    callsAuthority(),
  ],
});

function draw() {
  render(
    <IntlProvider>
      <MandateActions
        org="acme"
        ws="core-platform"
        mandate={bounded}
        here={routes.mandate("acme", "core-platform", bounded.id)}
      />
    </IntlProvider>,
  );
}

const dialog = () => screen.getByTestId("change-limits");

async function open() {
  // `delay: null` keeps every interaction synchronous; the default wraps each in
  // a timer, which under the package's coverage run costs more than the case
  // timeout allows.
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("button", { name: "Change limits" }));
  return user;
}

const confirm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    within(dialog()).getByRole("button", { name: "Change the limits" }),
  );
};

/** What the dialog's three count bounds prefill, on this mandate. */
const PREFILLED = {
  measure: "rows",
  unit: "rows",
  perCall: "50",
  perPeriod: "1000",
  period: "monthly",
  callsPerDay: "40",
};

beforeEach(() => {
  router.replace.mockReset();
  changeMandateLimits.mockReset();
  changeMandateLimits.mockResolvedValue({
    ok: true,
    value: { mandateId: bounded.id, status: "active" },
  });
});
afterEach(cleanup);

describe("ChangeLimits", () => {
  it("opens on the bound the mandate holds, and labels the calls cap with its own window", async () => {
    draw();
    await open();
    const form = dialog();
    expect(within(form).getByLabelText("Measure")).toHaveValue("rows");
    expect(within(form).getByLabelText("Unit")).toHaveValue("rows");
    expect(within(form).getByLabelText("Per call")).toHaveValue("50");
    expect(within(form).getByLabelText("Per period")).toHaveValue("1000");
    expect(within(form).getByLabelText("Period")).toHaveValue("monthly");
    // The stored cap is counted daily, and the label says which window the
    // figure belongs to rather than assuming one.
    expect(within(form).getByLabelText("Calls per day")).toHaveValue("40");
    // The window is the one field with no prefill: a blank date keeps the
    // window, so there is nothing to echo back.
    expect(within(form).getByLabelText("Valid to")).toHaveValue("");
    await expectNoAxe(document.body);
  });

  // The baseline is what the action compares against, so it has to be the string
  // that seeded the field, not a value recomputed from a prop. A submission that
  // touched nothing therefore arrives with every field equal to its baseline,
  // which is how the action knows to send no limit change at all.
  it("carries every prefill back as the baseline for the field beside it", async () => {
    draw();
    const user = await open();
    await confirm(user);
    expect(changeMandateLimits).toHaveBeenCalledWith("acme", "core-platform", {
      mandateId: bounded.id,
      ...PREFILLED,
      validTo: "",
      baseline: PREFILLED,
    });
  });

  it("sends the figure the operator typed beside the prefill it replaced", async () => {
    draw();
    const user = await open();
    const form = dialog();
    await user.clear(within(form).getByLabelText("Per period"));
    await user.type(within(form).getByLabelText("Per period"), "800");
    await user.type(within(form).getByLabelText("Valid to"), "2027-03-31");
    await confirm(user);
    expect(changeMandateLimits).toHaveBeenCalledWith("acme", "core-platform", {
      mandateId: bounded.id,
      ...PREFILLED,
      perPeriod: "800",
      validTo: "2027-03-31",
      // Unmoved: the action reads this and leaves the other bounds, the unit and
      // the window out of the change.
      baseline: PREFILLED,
    });
    expect(router.replace).toHaveBeenCalledWith(
      routes.mandate("acme", "core-platform", bounded.id),
    );
  });

  // A field cleared to blank is submitted blank against a baseline that still
  // holds the prefill, which is what lets the action tell clearing from editing.
  // Clearing leaves the stored bound alone; it does not delete it.
  it("sends a cleared field blank, with its prefill still in the baseline", async () => {
    draw();
    const user = await open();
    const form = dialog();
    await user.clear(within(form).getByLabelText("Per call"));
    await user.clear(within(form).getByLabelText("Per period"));
    await user.type(within(form).getByLabelText("Per period"), "800");
    await confirm(user);
    expect(changeMandateLimits).toHaveBeenCalledWith("acme", "core-platform", {
      mandateId: bounded.id,
      ...PREFILLED,
      perCall: "",
      perPeriod: "800",
      validTo: "",
      baseline: PREFILLED,
    });
  });

  it("names a refusal in the dialog and does not navigate (negative)", async () => {
    changeMandateLimits.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    draw();
    const user = await open();
    await confirm(user);
    expect(
      within(dialog()).getByTestId("change-limits-failure"),
    ).toHaveTextContent("not accountable for this mandate's consequences");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
