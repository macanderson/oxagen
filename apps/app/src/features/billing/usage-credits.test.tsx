// @vitest-environment jsdom
// Token balance over a fake top-up action: the balance at face value, what it
// pays for, the line a spent balance shows, the
// presets at the CREDIT_PACKS prices, and each refusal the action returns said
// in words. An admin sees who can top up; a read that returned no value says
// why. Axe checks every state. Which roles may top up is the page's decision,
// tested in billing.test.tsx, as is the section's presence in both billing
// modes — the section takes no mode, because the balance is the second meter
// and is metered apart from governed actions.
import {
  CREDIT_TOPUP_PRESETS_USD,
  MIN_CREDIT_TOPUP_USD,
} from "@oxagen/oxagen/contracts/billing.credits.purchase";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageCredits } from "@/data/contracts/billing";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { usageCredits } from "./billing.builders";

const { purchaseCredits } = vi.hoisted(() => ({
  purchaseCredits:
    vi.fn<(org: string, prev: unknown, form: FormData) => Promise<unknown>>(),
}));
vi.mock("./actions", () => ({ purchaseCredits }));

const { UsageCreditsSection } = await import("./usage-credits");
type TopUpState = import("./usage-credits").TopUpState;

function renderSection({
  credits = readOk(usageCredits()),
  topUp = "ok",
}: {
  credits?: Read<UsageCredits>;
  topUp?: TopUpState;
} = {}) {
  render(
    <IntlProvider>
      <UsageCreditsSection
        org="acme"
        credits={credits}
        topUp={topUp}
        presetsUsd={CREDIT_TOPUP_PRESETS_USD}
        minUsd={MIN_CREDIT_TOPUP_USD}
      />
    </IntlProvider>,
  );
}

const region = () => screen.getByRole("region", { name: "Token balance" });
const amount = () => screen.getByRole("spinbutton", { name: "Top-up amount" });
const fact = (name: string) => {
  const found = region().querySelector(`[data-fact="${name}"] dd`);
  if (found === null) throw new Error(`no ${name} fact`);
  return found;
};
const submit = () =>
  userEvent.click(screen.getByRole("button", { name: "Continue to Checkout" }));

beforeEach(() => {
  purchaseCredits.mockReset();
});
afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Token balance", () => {
  it("prints the balance at face value and says what it pays for", () => {
    renderSection();
    expect(fact("balance")).toHaveTextContent(/^\$42\.00$/);
    expect(region().querySelector("[data-basis]")).toHaveTextContent(
      /^Pays for the tokens Oxagen buys for the in-app agent, at cost with no markup\. The balance is the cap\.$/,
    );
    expect(region()).not.toHaveTextContent(/credit/i);
  });

  it("prints no token count and no per-call cost (negative)", () => {
    renderSection();
    expect(region()).not.toHaveTextContent(/\d tokens/i);
    expect(region()).not.toHaveTextContent(/per call/i);
  });

  it.each([
    ["spent to zero", 0, /^\$0\.00$/],
    ["overdrawn", -150, /^-\$1\.50$/],
  ])(
    "says the agent's turns on Oxagen's model key stop for a balance %s",
    (_state, balanceCredits, faceValue) => {
      renderSection({ credits: readOk(usageCredits(balanceCredits)) });
      expect(fact("balance")).toHaveTextContent(faceValue);
      expect(region().querySelector("[data-exhausted]")).toHaveTextContent(
        /^The in-app agent's turns on Oxagen's model key stop until a top-up lands\.$/,
      );
    },
  );

  it("does not draw that line while the balance remains (negative)", () => {
    renderSection();
    expect(region().querySelector("[data-exhausted]")).toBeNull();
  });

  it("offers the CREDIT_PACKS prices as presets, and a preset sets the amount", async () => {
    renderSection();
    const presets = within(
      screen.getByRole("group", { name: "Preset top-up amounts" }),
    ).getAllByRole("button");
    expect(presets.map((button) => button.textContent)).toEqual([
      "$10.00",
      "$50.00",
      "$200.00",
    ]);
    expect(amount()).toHaveValue(10);
    const fifty = presets[1];
    if (fifty === undefined) throw new Error("expected a second preset");
    await userEvent.click(fifty);
    expect(amount()).toHaveValue(50);
    expect(purchaseCredits).not.toHaveBeenCalled();
  });

  it("asks for whole dollars at or above the minimum", () => {
    renderSection();
    expect(amount()).toHaveAttribute("min", "5");
    expect(amount()).toHaveAttribute("step", "1");
    expect(amount()).toHaveAccessibleDescription("whole dollars, at least $5");
  });

  it("hands the action the organization and the amount", async () => {
    purchaseCredits.mockResolvedValue(null);
    renderSection();
    await userEvent.clear(amount());
    await userEvent.type(amount(), "75");
    await submit();
    expect(purchaseCredits).toHaveBeenCalledOnce();
    const [org, prev, form] = purchaseCredits.mock.calls[0] ?? [];
    expect([org, prev]).toEqual(["acme", null]);
    expect(form?.get("amountUsd")).toBe("75");
    expect(screen.queryByTestId("credits-error")).toBeNull();
  });

  it.each([
    [
      "invalid",
      {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "amountUsd",
      },
      "Enter a whole dollar amount of at least $5.",
    ],
    [
      "denied",
      { ok: false, reason: "denied", code: "org_role_required" },
      "Your role cannot top up the token balance. An owner or a billing member can.",
    ],
    [
      "unavailable",
      { ok: false, reason: "unavailable", code: "checkout_url_refused" },
      "Checkout could not be opened. Nothing was charged.",
    ],
  ])(
    "says why a top-up was refused: %s (negative)",
    async (_case, result, copy) => {
      purchaseCredits.mockResolvedValue(result);
      renderSection();
      await submit();
      expect(await screen.findByTestId("credits-error")).toHaveTextContent(
        copy,
      );
    },
  );

  it("shows an admin who can top up, with no amount, presets or button (negative)", () => {
    renderSection({ topUp: "role" });
    expect(region()).toHaveAttribute("data-state", "denied");
    expect(region()).toHaveTextContent(
      "An owner or a billing member can top up the token balance.",
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    // The balance still reads, so its face value is still the one money here.
    expect(within(region()).getAllByTestId("money")).toHaveLength(1);
  });

  // A Free organization's checkout is refused whatever the role, so the owner
  // of one is told what it needs first rather than handed a form that fails.
  it("sends a Free organization to the subscription instead of the form (negative)", () => {
    renderSection({ topUp: "plan" });
    expect(region()).toHaveAttribute("data-state", "plan");
    expect(region()).toHaveTextContent(
      "A top-up needs a Build plan or above. Subscribe first and the top-up opens here.",
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    // The balance still reads, so its face value is still the one money here.
    expect(within(region()).getAllByTestId("money")).toHaveLength(1);
  });

  it.each([
    [
      "denied",
      { ok: false, reason: "denied", permission: "org.billing" } as const,
      "You cannot see Token balance for this organization. Your role does not include org.billing",
    ],
    [
      "error",
      readError("stripe_unreachable", 502),
      "Token balance could not be loaded: the billing service answered stripe_unreachable",
    ],
  ])(
    "says why the balance could not be read: %s (negative)",
    (reason, credits, copy) => {
      renderSection({ credits });
      expect(
        region().querySelector(`[data-reason=${reason}]`),
      ).toHaveTextContent(copy);
      expect(screen.queryByRole("spinbutton")).toBeNull();
      expect(within(region()).queryByTestId("money")).toBeNull();
    },
  );
});
