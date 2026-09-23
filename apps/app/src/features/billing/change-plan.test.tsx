// @vitest-environment jsdom
// Change plan (pages/billing.md, the `plan` dialog): the gold Change plan
// button opens it; an allowed viewer sees a Plan select with Build and Scale
// each billed monthly or yearly at its price, and Enterprise listed but not
// selectable; the design's note; and Change plan in the footer beside Cancel.
// Submitting hands the action the organization, the plan slug and the
// interval; each refusal the action returns is said in words; a blocked
// viewer sees the sentence the block names and no form. Axe checks every
// state (INV-26).
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
    vi.fn<(org: string, prev: unknown, form: FormData) => Promise<unknown>>(),
}));
vi.mock("./actions", () => ({ startPlanChange }));

const PLANS: readonly PlanOption[] = [
  {
    slug: "build-v2",
    tier: "build",
    monthly: { micros: "199000000", currency: "USD" },
    annual: { micros: "1990000000", currency: "USD" },
  },
  {
    slug: "scale-v2",
    tier: "scale",
    monthly: { micros: "999000000", currency: "USD" },
    annual: { micros: "9990000000", currency: "USD" },
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

const submit = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Change plan" });

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
    await userEvent.click(screen.getByRole("button", { name: "Change plan" }));
    expect(screen.getByRole("dialog", { name: "Change plan" })).toBeVisible();
  });

  it("is the gold action", () => {
    renderChangePlan();
    expect(screen.getByTestId("change-plan").className).toContain(
      "bg-button-primary-bg",
    );
  });
});

describe("an allowed viewer", () => {
  it("picks from Build and Scale, monthly or yearly at its price, with Enterprise listed but not selectable", async () => {
    const dialog = await openDialog();
    const select = within(dialog).getByRole("combobox", { name: "Plan" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => [
          option.textContent,
          (option as HTMLOptionElement).disabled,
        ]),
    ).toEqual([
      ["Build, $199.00 a month", false],
      ["Build, $1,990.00 a year", false],
      ["Scale, $999.00 a month", false],
      ["Scale, $9,990.00 a year", false],
      ["Enterprise, annual, negotiated per organization", true],
    ]);
    expect(select).toHaveValue("build-v2:month");
  });

  it("carries the design's note and no paragraph beyond it", async () => {
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(
      "The free tier is in every plan: an included monthly allowance of governed actions and every governance feature on. Enterprise adds a dedicated data plane or behind-the-firewall deployment, and support with an SLA.",
    );
    // 995ee8a24 dropped the Checkout-and-Enterprise paragraph the design does
    // not draw; the form holds the select and the note alone.
    expect(within(dialog).getByRole("form").querySelectorAll("p")).toHaveLength(
      1,
    );
    expect(dialog).not.toHaveTextContent(
      "Stripe Checkout shows the amount due",
    );
  });

  it("puts Cancel and Change plan in the footer", async () => {
    const dialog = await openDialog();
    const footer = dialog.querySelector("[data-sheet-footer]") as HTMLElement;
    expect(
      within(footer)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Change plan"]);
  });

  it("hands the action the organization, the chosen plan and interval", async () => {
    startPlanChange.mockResolvedValue(null);
    const dialog = await openDialog();
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Plan" }),
      "scale-v2:year",
    );
    await userEvent.click(submit(dialog));
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
      {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "planSlug",
      },
      "Choose a plan.",
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
  ])(
    "says why a plan change was refused: %s (negative)",
    async (_case, result, copy) => {
      startPlanChange.mockResolvedValue(result);
      const dialog = await openDialog();
      await userEvent.click(submit(dialog));
      expect(await screen.findByTestId("plan-error")).toHaveTextContent(copy);
    },
  );
});

describe("a viewer the page blocks", () => {
  it("shows a role refusal and no form for blocked: { kind: 'role' }", async () => {
    const dialog = await openDialog({ kind: "role" });
    expect(dialog).toHaveTextContent(
      "An owner or a billing member can change the plan.",
    );
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Change plan" }),
    ).toBeNull();
  });

  it("names the existing subscription and says what the product would do, with no form", async () => {
    const dialog = await openDialog({
      kind: "subscribed",
      plan: "build-v2",
      tier: "build",
    });
    expect(dialog).toHaveTextContent(
      "This organization already has a Build subscription. Changing a running subscription is not in the app yet. It would swap the plan in Stripe from the next renewal.",
    );
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(startPlanChange).not.toHaveBeenCalled();
  });

  it("names the subscription by its Stripe plan when no tier is known", async () => {
    const dialog = await openDialog({
      kind: "subscribed",
      plan: "legacy-team-2025",
      tier: null,
    });
    expect(dialog).toHaveTextContent(
      "This organization already has a legacy-team-2025 subscription.",
    );
  });
});
