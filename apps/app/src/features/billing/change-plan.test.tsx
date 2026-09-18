// @vitest-environment jsdom
// Change plan (pages/billing.md, the `plan` dialog): the Change plan button
// opens it; an allowed viewer sees Build and Scale priced monthly, and
// switching to yearly shows the annual prices; submitting hands the action
// the organization, the plan slug and the interval; each refusal the action
// returns is said in words; a blocked viewer sees the sentence the block
// names and no form. Axe checks every state (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  ChangePlan,
  type PlanChangeBlock,
  type PlanOption,
} from "./change-plan";

const { startPlanChange } = vi.hoisted(() => ({
  startPlanChange:
    vi.fn<
      (
        org: string,
        prev: unknown,
        form: FormData,
      ) => Promise<unknown>
    >(),
}));
vi.mock("./actions", () => ({ startPlanChange }));

const PLANS: readonly PlanOption[] = [
  {
    slug: "build-v2",
    tier: "build",
    monthly: { micros: "199000000", currency: "USD" },
    annual: { micros: "1990000000", currency: "USD" },
    includedGauPerMonth: 50000,
  },
  {
    slug: "scale-v2",
    tier: "scale",
    monthly: { micros: "999000000", currency: "USD" },
    annual: { micros: "9990000000", currency: "USD" },
    includedGauPerMonth: 300000,
  },
];

function renderChangePlan(blocked: PlanChangeBlock | null = null) {
  render(
    <IntlProvider>
      <ChangePlan org="acme" plans={PLANS} blocked={blocked} />
    </IntlProvider>,
  );
}

async function openDialog(blocked: PlanChangeBlock | null = null) {
  renderChangePlan(blocked);
  await userEvent.click(screen.getByRole("button", { name: "Change plan" }));
  return screen.getByRole("dialog", { name: "Change plan" });
}

const planLabel = (tier: "build" | "scale") => {
  const found = document.querySelector<HTMLElement>(`[data-plan="${tier}"]`);
  if (found === null) throw new Error(`no ${tier} label`);
  return found;
};

beforeEach(() => {
  startPlanChange.mockReset();
});
afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the Change plan button", () => {
  it("is closed until clicked, then opens the dialog", async () => {
    renderChangePlan();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Change plan" }),
    );
    expect(screen.getByRole("dialog", { name: "Change plan" })).toBeVisible();
  });
});

describe("an allowed viewer", () => {
  it("sees Build and Scale, each with its included GAU and monthly price", async () => {
    await openDialog();
    expect(planLabel("build")).toHaveTextContent(
      "Build50,000 GAU a month$199.00 a month",
    );
    expect(planLabel("scale")).toHaveTextContent(
      "Scale300,000 GAU a month$999.00 a month",
    );
    expect(
      screen.getByRole("radio", { name: /Build/ }),
    ).toBeChecked();
  });

  it("shows the annual price once billed yearly is chosen", async () => {
    await openDialog();
    await userEvent.click(screen.getByRole("radio", { name: "yearly" }));
    expect(planLabel("build")).toHaveTextContent("$1,990.00 a year");
    expect(planLabel("scale")).toHaveTextContent("$9,990.00 a year");
  });

  it("names Enterprise as negotiated, off the form", async () => {
    await openDialog();
    expect(screen.getByText(/Enterprise is negotiated per contract/)).toBeInTheDocument();
    expect(screen.queryByText("Enterprise")).toBeNull();
  });

  it("hands the action the organization, the chosen plan and interval", async () => {
    startPlanChange.mockResolvedValue(null);
    await openDialog();
    await userEvent.click(screen.getByRole("radio", { name: /Scale/ }));
    await userEvent.click(screen.getByRole("radio", { name: "yearly" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to Checkout" }),
    );
    expect(startPlanChange).toHaveBeenCalledOnce();
    const [org, prev, form] = startPlanChange.mock.calls[0] ?? [];
    expect([org, prev]).toEqual(["acme", null]);
    expect(form?.get("planSlug")).toBe("scale-v2");
    expect(form?.get("interval")).toBe("year");
    expect(screen.queryByTestId("plan-error")).toBeNull();
  });

  it.each([
    [
      "invalid",
      { ok: false, reason: "invalid", code: "invalid_input", field: "planSlug" },
      "Choose a plan and how it is billed.",
    ],
    [
      "denied",
      { ok: false, reason: "denied", code: "org_role_required" },
      "Your role cannot change the plan. An owner or a billing member can.",
    ],
    [
      "conflict",
      { ok: false, reason: "conflict", code: "active_subscription_exists" },
      "This organization already has an active subscription, so Checkout cannot start a second one.",
    ],
    [
      "unavailable",
      { ok: false, reason: "unavailable", code: "checkout_url_refused" },
      "Checkout could not be opened. Nothing was charged.",
    ],
  ])("says why a plan change was refused: %s (negative)", async (_case, result, copy) => {
    startPlanChange.mockResolvedValue(result);
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to Checkout" }),
    );
    expect(await screen.findByTestId("plan-error")).toHaveTextContent(copy);
  });
});

describe("a viewer the page blocks", () => {
  it("shows a role refusal and no form for blocked: { kind: 'role' }", async () => {
    const dialog = await openDialog({ kind: "role" });
    expect(dialog).toHaveTextContent(
      "An owner or a billing member can change the plan.",
    );
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Continue to Checkout" }),
    ).toBeNull();
  });

  it("names the existing subscription and no form for blocked: { kind: 'subscribed', plan }", async () => {
    const dialog = await openDialog({ kind: "subscribed", plan: "build" });
    expect(dialog).toHaveTextContent(
      "This organization already has a build subscription. Changing an existing subscription is not in the app yet: it would swap the plan in Stripe from the next renewal.",
    );
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(startPlanChange).not.toHaveBeenCalled();
  });
});
