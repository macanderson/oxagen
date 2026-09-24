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

/** 50 rows a call, 1000 rows a month, 50 calls a day: three prefills. */
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

// The page resolves this server-side and hands it down as a prop (`mandate.tsx`'s
// `readAt`), so the test does the same rather than let the component read a
// clock: a fixed instant inside the fixture's own default window
// (validFrom 2026-09-01, validTo 2026-12-31).
const NOW = new Date("2026-10-01T00:00:00.000Z");

function draw(mandate: MandateRow = bounded, now: Date = NOW) {
  render(
    <IntlProvider>
      <MandateActions
        org="acme"
        ws="core-platform"
        mandate={mandate}
        now={now}
        here={routes.mandate("acme", "core-platform", mandate.id)}
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
  callsPerDay: "50",
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
    expect(within(form).getByLabelText("Calls per day")).toHaveValue("50");
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

// `mandateLimitSchema` requires only that a limit names `perCall`, `perPeriod` or
// both, so a bound that caps a single call and leaves the period open is valid.
// The dialog used to match on `perPeriod` alone and opened blank on one of those,
// making the operator retype the measure and unit before they could lower a cap
// the mandate already held.
describe("ChangeLimits on a per-call-only bound", () => {
  const perCallOnly = mandateRow({
    authority: [
      mandateAuthority({
        measure: "rows",
        period: "monthly",
        perCall: { kind: "count", count: "25", unit: "rows" },
        // No per-period bound, so the ratios that divide by it are null too:
        // a fixture that carried both would not be a record this app can read.
        perPeriod: null,
        settledRatio: null,
        reservedRatio: null,
        remaining: null,
      }),
    ],
  });

  it("prefills the measure, the unit and the figure it does hold", async () => {
    draw(perCallOnly);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Change limits" }));
    const form = dialog();
    expect(within(form).getByLabelText("Measure")).toHaveValue("rows");
    // The unit comes from whichever bound carries it, so it is not blank here.
    expect(within(form).getByLabelText("Unit")).toHaveValue("rows");
    expect(within(form).getByLabelText("Per call")).toHaveValue("25");
    // Nothing is stored for the period, so that field stays empty rather than
    // inventing a figure the mandate does not hold.
    expect(within(form).getByLabelText("Per period")).toHaveValue("");
  });
});

// A mandate whose only limit is money used to open this dialog blank, because
// the form could not scale a figure. The action now reads the stored kind before
// it scales (actions.ts, ADR-108), so the dialog opens on the money limit in its
// own currency, each figure a plain decimal a person can type back.
describe("ChangeLimits on a money limit", () => {
  // `amount`: $250 a call and $2,000 a month, held as micros, plus a calls cap.
  const moneyOnly = mandateRow({
    authority: [
      mandateAuthority({
        perCall: {
          kind: "money",
          money: { micros: "250000000", currency: "USD" },
        },
        perPeriod: {
          kind: "money",
          money: { micros: "2000500000", currency: "USD" },
        },
      }),
      callsAuthority(),
    ],
  });
  const MONEY = {
    measure: "amount",
    unit: "USD",
    perCall: "250",
    perPeriod: "2000.5",
    period: "monthly",
    callsPerDay: "50",
  };

  it("opens on the amount in its currency, each figure a decimal rather than micros", async () => {
    draw(moneyOnly);
    await open();
    const form = dialog();
    expect(within(form).getByLabelText("Measure")).toHaveValue("amount");
    expect(within(form).getByLabelText("Unit")).toHaveValue("USD");
    expect(within(form).getByLabelText("Per call")).toHaveValue("250");
    expect(within(form).getByLabelText("Per period")).toHaveValue("2000.5");
    expect(within(form).getByLabelText("Per period")).not.toHaveValue(
      "2000500000",
    );
    expect(within(form).getByLabelText("Per call")).toHaveAttribute(
      "inputmode",
      "decimal",
    );
    await expectNoAxe(document.body);
  });

  it("sends the amount typed as typed, with the decimal prefill as its baseline", async () => {
    draw(moneyOnly);
    const user = await open();
    const form = dialog();
    await user.clear(within(form).getByLabelText("Per period"));
    await user.type(within(form).getByLabelText("Per period"), "1500.25");
    await confirm(user);
    // The dialog sends strings and no kind. Scaling happens on the server,
    // against the kind the record holds.
    expect(changeMandateLimits).toHaveBeenCalledWith("acme", "core-platform", {
      mandateId: moneyOnly.id,
      ...MONEY,
      perPeriod: "1500.25",
      validTo: "",
      baseline: MONEY,
    });
  });

  it("opens on the counted measure when the mandate holds both (negative)", async () => {
    draw(
      mandateRow({
        authority: [
          mandateAuthority(),
          mandateAuthority({
            measure: "rows",
            perCall: { kind: "count", count: "50", unit: "rows" },
            perPeriod: { kind: "count", count: "1000", unit: "rows" },
          }),
        ],
      }),
    );
    await open();
    const form = dialog();
    expect(within(form).getByLabelText("Measure")).toHaveValue("rows");
    expect(within(form).getByLabelText("Unit")).toHaveValue("rows");
    expect(within(form).getByLabelText("Per period")).toHaveValue("1000");
  });
});

// `revoke_mandate` takes a draft as well as an active mandate, because declining
// a request is the revocation of a mandate that never took effect. This component
// is the app's only caller of it, so a draft the header refuses to act on is a
// request nobody can decline anywhere in the app.
describe("MandateActions on a draft", () => {
  const requested = mandateRow({ status: "draft" });

  it("offers a decline and no limit change", () => {
    draw(requested);
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    // Change limits refuses anything but an active mandate, so offering it here
    // would be offering a control the kernel is certain to refuse.
    expect(
      screen.queryByRole("button", { name: "Change limits" }),
    ).not.toBeInTheDocument();
  });

  it("says it is declining a request, not ending a mandate", async () => {
    draw(requested);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Decline" }));
    const panel = screen.getByTestId("revoke-mandate");
    // Nothing was ever reserved against a draft and the ledger holds no movement
    // for it, so the revoke copy is false of it in every sentence.
    expect(within(panel).getByText(/never takes effect/)).toBeInTheDocument();
    expect(
      within(panel).queryByText(/Every reservation held by a call/),
    ).not.toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: "Decline this request" }),
    ).toBeInTheDocument();
  });

  it("offers nothing once the mandate has ended", () => {
    // Both handlers refuse a revoked or expired mandate.
    for (const status of ["revoked", "expired"] as const) {
      cleanup();
      draw(mandateRow({ status }));
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    }
  });

  // The opposite edge of the same window, and the reason this gate is not
  // `isEffective`. A granted mandate whose window has not opened is `active`,
  // and `update_mandate_limits` accepts it: the handler requires active status
  // and an unelapsed validTo, and says nothing about validFrom. This component
  // is the app's only limit-change control, so gating it on `isEffective` left
  // no way to correct a scheduled bound short of revoking and re-granting.
  it("offers Change limits on a granted mandate whose window has not opened", () => {
    draw(
      mandateRow({
        status: "active",
        validFrom: "2026-11-01T00:00:00.000Z",
        validTo: "2026-12-31T00:00:00.000Z",
      }),
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(
      screen.getByRole("button", { name: "Change limits" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  // Status can still read active after exclusive validTo, before the expiry
  // job flips the row. Change limits must not appear: submitting a future
  // validTo through it would reopen ended authority. Revoke stays so the
  // operator can mark the row revoked before the cron does.
  it("hides Change limits when active status outlives exclusive validTo", () => {
    draw(
      mandateRow({
        status: "active",
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2020-06-01T00:00:00.000Z",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Change limits" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });
});
