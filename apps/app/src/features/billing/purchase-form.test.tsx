// @vitest-environment jsdom
// Buy governed actions: the quantity picker steps by the contracted block
// size and prices the quantity at the contracted rate, the form hands the
// purchase action the organization, the block size and the quantity, and each
// refusal the action returns is said in words. A Free organization with no
// saved card is offered the purchase; an admin sees who can buy; an
// invoice-billed organization sees no form. Axe checks every state.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractRate, GauBucket } from "@/data/contracts/billing";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  contractRate,
  freeNoCardBucket,
  invoiceBucket,
  PUBLISHED_BUILD,
  prepaidBucket,
} from "./billing.builders";

const { purchaseGau } = vi.hoisted(() => ({
  purchaseGau:
    vi.fn<
      (
        org: string,
        blockSizeGau: number,
        prev: unknown,
        form: FormData,
      ) => Promise<unknown>
    >(),
}));
vi.mock("./actions", () => ({ purchaseGau }));

const { PurchaseForm } = await import("./purchase-form");

function renderForm({
  bucket = readOk(prepaidBucket()),
  rate = readOk(contractRate()),
  allowed = true,
}: {
  bucket?: Read<GauBucket>;
  rate?: Read<ContractRate>;
  allowed?: boolean;
} = {}) {
  render(
    <IntlProvider>
      <PurchaseForm
        org="acme"
        bucket={bucket}
        rate={rate}
        maxGau={1_000_000}
        allowed={allowed}
      />
    </IntlProvider>,
  );
}

const region = () =>
  screen.getByRole("region", { name: "Buy governed actions" });
const picker = () =>
  screen.getByRole("spinbutton", { name: "Governed actions" });
const total = () => {
  const found = region().querySelector('[data-fact="total"] dd');
  if (found === null) throw new Error("no total");
  return found;
};

async function setQuantity(value: string) {
  await userEvent.clear(picker());
  if (value !== "") await userEvent.type(picker(), value);
}

beforeEach(() => {
  purchaseGau.mockReset();
});
afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("PurchaseForm", () => {
  it("starts at one block of the contracted size, stepping by it, priced at the contracted rate", async () => {
    renderForm();
    expect(picker()).toHaveValue(10000);
    expect(picker()).toHaveAttribute("step", "10000");
    expect(picker()).toHaveAttribute("min", "10000");
    expect(picker()).toHaveAttribute("max", "1000000");
    expect(region()).toHaveTextContent("in blocks of 10,000");
    expect(total()).toHaveTextContent(/^\$32\.10$/);
    expect(within(region()).getAllByTestId("money")).toHaveLength(1);
    await setQuantity("30000");
    expect(total()).toHaveTextContent(/^\$96\.30$/);
  });

  it("prices the published tier's rate the same way", async () => {
    renderForm({ rate: readOk(PUBLISHED_BUILD) });
    expect(picker()).toHaveAttribute("step", "5000");
    expect(picker()).toHaveAttribute("max", "1000000");
    expect(total()).toHaveTextContent(/^\$25\.00$/);
    await setQuantity("15000");
    expect(total()).toHaveTextContent(/^\$75\.00$/);
  });

  it.each([
    ["between blocks", "15000"],
    ["under one block", "5000"],
    ["of whole blocks above the most one purchase buys", "1010000"],
    ["empty", ""],
  ])("shows no total for a quantity %s (negative)", async (_case, value) => {
    renderForm();
    await setQuantity(value);
    expect(total()).toHaveTextContent(
      /^Choose a whole number of blocks to see the total$/,
    );
    expect(within(region()).queryByTestId("money")).toBeNull();
  });

  it("hands the action the organization, the block size and the quantity", async () => {
    purchaseGau.mockResolvedValue(null);
    renderForm();
    await setQuantity("20000");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to Checkout" }),
    );
    expect(purchaseGau).toHaveBeenCalledOnce();
    const [org, blockSizeGau, prev, form] = purchaseGau.mock.calls[0] ?? [];
    expect([org, blockSizeGau, prev]).toEqual(["acme", 10000, null]);
    expect(form?.get("quantityGau")).toBe("20000");
    expect(screen.queryByTestId("purchase-error")).toBeNull();
  });

  it.each([
    [
      "invalid",
      {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "quantityGau",
      },
      "Choose a whole number of blocks.",
    ],
    [
      "above the maximum",
      {
        ok: false,
        reason: "invalid",
        code: "quantity_above_max",
        field: "quantityGau",
      },
      "You can buy at most 1,000,000 governed actions at once.",
    ],
    [
      "denied",
      { ok: false, reason: "denied", code: "forbidden" },
      "Your role cannot buy governed actions. An owner or a billing member can.",
    ],
    [
      "conflict",
      { ok: false, reason: "conflict", code: "invoice_billed" },
      "This organization is billed by invoice, so it does not buy governed actions in blocks.",
    ],
    [
      "unavailable",
      { ok: false, reason: "unavailable", code: "checkout_url_refused" },
      "Checkout could not be opened. Nothing was charged.",
    ],
  ])(
    "says why a purchase was refused: %s (negative)",
    async (_case, result, copy) => {
      purchaseGau.mockResolvedValue(result);
      renderForm();
      await userEvent.click(
        screen.getByRole("button", { name: "Continue to Checkout" }),
      );
      expect(await screen.findByTestId("purchase-error")).toHaveTextContent(
        copy,
      );
    },
  );

  it("keeps the picker and the total on the quantity sent after a refusal (negative)", async () => {
    purchaseGau.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "checkout_url_refused",
    });
    renderForm();
    await setQuantity("30000");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to Checkout" }),
    );
    await screen.findByTestId("purchase-error");
    expect(picker()).toHaveValue(30000);
    expect(total()).toHaveTextContent(/^\$96\.30$/);
  });

  it("offers a Free organization with no saved card and nothing left the purchase, under the anchor the bucket meter links to, saying Checkout saves the card", () => {
    renderForm({ bucket: readOk(freeNoCardBucket()) });
    expect(freeNoCardBucket().remainingGau).toBe(0);
    const heading = document.getElementById("billing-buy");
    expect(heading).toHaveTextContent("Buy governed actions");
    expect(region()).toHaveAttribute("aria-labelledby", heading?.id);
    expect(picker()).toBeEnabled();
    expect(region().querySelector("[data-saves-card]")).toHaveTextContent(
      /^Checkout saves your card\. Auto top-up runs from then on\.$/,
    );
    expect(
      screen.getByRole("button", { name: "Continue to Checkout" }),
    ).toBeInTheDocument();
  });

  it("does not say Checkout saves a card once one is saved (negative)", () => {
    renderForm();
    expect(region().querySelector("[data-saves-card]")).toBeNull();
  });

  it("shows an admin who can buy, with no picker, total or button (negative)", () => {
    renderForm({ allowed: false });
    expect(region()).toHaveAttribute("data-state", "denied");
    expect(region()).toHaveTextContent(
      "An owner or a billing member can buy governed actions.",
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(within(region()).queryByTestId("money")).toBeNull();
  });

  it("is not drawn for an invoice-billed organization (negative)", () => {
    renderForm({ bucket: readOk(invoiceBucket()) });
    expect(
      screen.queryByRole("region", { name: "Buy governed actions" }),
    ).toBeNull();
  });

  it.each([
    [
      "the bucket was denied",
      {
        bucket: {
          ok: false,
          reason: "denied",
          permission: "org.billing",
        } as const,
      },
    ],
    [
      "the rate could not be read",
      { rate: readError("stripe_unreachable", 502) },
    ],
  ])("is not drawn when %s (negative)", (_case, reads) => {
    renderForm(reads);
    expect(
      screen.queryByRole("region", { name: "Buy governed actions" }),
    ).toBeNull();
  });
});
