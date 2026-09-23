// @vitest-environment jsdom
// The Auto top-up control over a fake save action: what it draws for a saved
// card, no card and each last attempt, how a save re-renders from the values
// the server stored, how each refusal reads, the read-only control, and its
// absence in invoice billing, with an axe check in every state. Which roles
// may edit is the page's decision, tested in billing.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GauBucket } from "@/data/contracts/billing";
import { type Read, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  freeNoCardBucket,
  invoiceBucket,
  prepaidBucket,
} from "./billing.builders";

const setAutoTopup = vi.fn();
vi.mock("./actions", () => ({ setAutoTopup }));

const { AutoTopup } = await import("./auto-topup");

function renderControl({
  bucket = readOk(prepaidBucket()),
  blockSizeGau = 10000,
  editable = true,
}: {
  bucket?: Read<GauBucket>;
  blockSizeGau?: number | null;
  editable?: boolean;
} = {}) {
  render(
    <IntlProvider>
      <AutoTopup
        bucket={bucket}
        blockSizeGau={blockSizeGau}
        editable={editable}
        org="acme"
      />
    </IntlProvider>,
  );
  const region = screen.getByRole("region", { name: "Auto top-up" });
  return {
    region,
    toggle: within(region).getByRole("switch", {
      name: "Buy more automatically when this period's allowance runs out",
    }),
    stepper: within(region).getByRole("spinbutton", {
      name: "Blocks per top-up",
    }),
  };
}

const save = () =>
  userEvent.click(screen.getByRole("button", { name: "Save" }));

beforeEach(() => {
  setAutoTopup.mockReset();
});
afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Auto top-up", () => {
  it("saves the toggle and the blocks for the organization and re-renders from the values as stored", async () => {
    setAutoTopup.mockResolvedValue({
      ok: true,
      value: { enabled: true, blocks: 2 },
    });
    const { region, toggle, stepper } = renderControl();
    await userEvent.click(toggle);
    await userEvent.clear(stepper);
    await userEvent.type(stepper, "4");
    expect(region.querySelector("[data-per-topup]")).toHaveTextContent(
      /^= 40,000 governed actions per top-up$/,
    );
    await save();
    expect(setAutoTopup).toHaveBeenCalledOnce();
    expect(setAutoTopup).toHaveBeenCalledWith("acme", {
      enabled: false,
      blocks: 4,
    });
    expect(toggle).toBeChecked();
    expect(stepper).toHaveValue(2);
    expect(region.querySelector("[data-per-topup]")).toHaveTextContent(
      /^= 20,000 governed actions per top-up$/,
    );
    expect(within(region).getByRole("status")).toHaveTextContent(
      "Auto top-up saved.",
    );
    expect(within(region).queryByTestId("money")).toBeNull();
  });

  it("saves once while a save is still running (negative)", async () => {
    let finish: (value: unknown) => void = () => undefined;
    setAutoTopup.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderControl();
    await save();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(setAutoTopup).toHaveBeenCalledOnce();
    finish({ ok: true, value: { enabled: true, blocks: 1 } });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Auto top-up saved.",
    );
  });

  it("marks the blocks field when the server refuses the count (negative)", async () => {
    setAutoTopup.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "blocks",
    });
    const { stepper } = renderControl();
    await userEvent.clear(stepper);
    await userEvent.type(stepper, "101");
    await save();
    expect(stepper).toHaveAttribute("aria-invalid", "true");
    expect(stepper).toHaveAccessibleDescription(
      "Enter a whole number of blocks from 1 to 100.",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says an owner or admin can change it when the server denies the save (negative)", async () => {
    setAutoTopup.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    const { toggle } = renderControl();
    await userEvent.click(toggle);
    await save();
    expect(screen.getByTestId("auto-topup-denied")).toHaveTextContent(
      "An owner or admin can change auto top-up.",
    );
    expect(toggle).not.toBeChecked();
  });

  it.each([
    [
      "an unavailable answer",
      () =>
        setAutoTopup.mockResolvedValue({
          ok: false,
          reason: "unavailable",
          code: "kernel_failure",
        }),
    ],
    [
      "a failed request",
      () => setAutoTopup.mockRejectedValue(new Error("network")),
    ],
  ])("reports %s as not saved (negative)", async (_name, answer) => {
    answer();
    renderControl();
    await save();
    expect(screen.getByTestId("auto-topup-failed")).toHaveTextContent(
      "Auto top-up could not be saved. Try again.",
    );
  });

  it("is read-only with no save for a viewer who cannot edit (negative)", async () => {
    const { region, toggle, stepper } = renderControl({ editable: false });
    expect(region).toHaveAttribute("data-editable", "false");
    expect(toggle).toBeDisabled();
    expect(stepper).toBeDisabled();
    expect(within(region).queryByRole("button")).toBeNull();
    expect(region).toHaveTextContent(
      "An owner or admin can change auto top-up.",
    );
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(setAutoTopup).not.toHaveBeenCalled();
  });

  it("is on with one block for an organization with no saved card, which its next purchase saves", () => {
    const { region, toggle, stepper } = renderControl({
      bucket: readOk(freeNoCardBucket()),
      blockSizeGau: 5000,
    });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(stepper).toHaveValue(1);
    expect(region.querySelector("[data-per-topup]")).toHaveTextContent(
      /^= 5,000 governed actions per top-up$/,
    );
    expect(region.querySelector("[data-card=none]")).toHaveTextContent(
      /^No saved payment method\. Your next purchase saves one, and auto top-up runs from then on\.$/,
    );
  });

  it("leaves the per-top-up count out when the rate could not be read (negative)", () => {
    const { region } = renderControl({ blockSizeGau: null });
    expect(region.querySelector("[data-per-topup]")).toBeNull();
  });

  it("names the saved card, or the saved payment method when Stripe did not label it", () => {
    const { region } = renderControl();
    expect(region.querySelector("[data-card=saved]")).toHaveTextContent(
      /^charged to visa ····4242$/,
    );
    cleanup();
    const unlabelled = renderControl({
      bucket: readOk(
        prepaidBucket({}, { paymentMethod: { brand: null, last4: null } }),
      ),
    });
    expect(
      unlabelled.region.querySelector("[data-card=saved]"),
    ).toHaveTextContent(/^charged to the saved payment method$/);
  });

  it("says no top-up has run this month", () => {
    const { region } = renderControl();
    expect(region.querySelector("[data-attempt=none]")).toHaveTextContent(
      /^No auto top-up has run this month\.$/,
    );
  });

  it.each([
    ["paid", "Last top-up Sep 14, 2026: paid"],
    ["open", "Last top-up Sep 14, 2026: open, its invoice is under Invoices"],
    ["failed", "Last top-up Sep 14, 2026: failed"],
  ] as const)("prints a %s last attempt", (status, text) => {
    const { region } = renderControl({
      bucket: readOk(
        prepaidBucket(
          {},
          { lastAttempt: { at: "2026-09-14T10:02:00.000Z", status } },
        ),
      ),
    });
    expect(region.querySelector(`[data-attempt=${status}]`)).toHaveTextContent(
      text,
    );
  });

  it("is not drawn for an invoice-billed organization (negative)", () => {
    render(
      <IntlProvider>
        <AutoTopup
          bucket={readOk(invoiceBucket())}
          blockSizeGau={10000}
          editable
          org="acme"
        />
      </IntlProvider>,
    );
    expect(screen.queryByRole("region", { name: "Auto top-up" })).toBeNull();
  });
});
