// @vitest-environment jsdom
// The Pricing tab's two dialogs with their actions faked.
//
// A submitted card crosses the action boundary once, including every class.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import spend from "../../../messages/spend.json";
import ui from "../../../messages/ui.json";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// Typed on the values argument, so reading a call's payload back is not an
// `any` the lint rules refuse to let escape.
const setPriceEntryAction =
  vi.fn<
    (
      at: unknown,
      values: Record<string, unknown>,
      additional: Record<string, unknown>[],
    ) => unknown
  >();
const removePriceEntryAction = vi.fn();
vi.mock("./actions", () => ({
  setBudgetAction: vi.fn(),
  exportStatementAction: vi.fn(),
  recordFindingFixAction: vi.fn(),
  dismissFindingAction: vi.fn(),
  setPriceEntryAction,
  removePriceEntryAction,
}));

const { PriceDialog } = await import("./price-dialog");
const { RemoveRateDialog } = await import("./remove-rate-dialog");

const at = { org: "acme", ws: "core-platform" };

function renderWithIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ ...spend, ...ui }}
      timeZone="UTC"
    >
      {node}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  setPriceEntryAction.mockReset();
  removePriceEntryAction.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Set a negotiated rate", () => {
  async function openDialog() {
    renderWithIntl(<PriceDialog at={at} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Set a negotiated rate" }),
    );
    return screen.getByRole("dialog", { name: "Set a negotiated rate" });
  }

  async function fill(card: Record<string, string>) {
    for (const [label, value] of Object.entries(card)) {
      await userEvent.type(screen.getByLabelText(label), value);
    }
  }

  const submit = async () =>
    userEvent.click(screen.getByRole("button", { name: "Set these rates" }));

  it("refuses a card with no rate on it before calling the capability (negative)", async () => {
    await openDialog();
    await fill({ Vendor: "anthropic", Model: "claude-sonnet-5" });
    await submit();
    expect(
      screen.getByText("Fill in at least one class. Nothing was written."),
    ).toBeInTheDocument();
    expect(setPriceEntryAction).not.toHaveBeenCalled();
  });

  it("refuses a rate that is not an amount, writing none of the card (negative)", async () => {
    await openDialog();
    await fill({
      Vendor: "anthropic",
      Model: "claude-sonnet-5",
      Input: "3.00",
      Output: "15,00",
    });
    await submit();
    expect(
      screen.getByText(
        "Enter US dollars per one million units, with at most six decimal places.",
      ),
    ).toBeInTheDocument();
    expect(setPriceEntryAction).not.toHaveBeenCalled();
  });

  it("refuses a model nobody named, so no class is written (negative)", async () => {
    await openDialog();
    await fill({ Vendor: "anthropic", Output: "15" });
    await submit();
    expect(
      screen.getByText("Enter the model id, up to 256 characters."),
    ).toBeInTheDocument();
    expect(setPriceEntryAction).not.toHaveBeenCalled();
  });

  it("sends every class in one atomic call", async () => {
    setPriceEntryAction.mockResolvedValue({ ok: true, value: null });
    await openDialog();
    await fill({
      Vendor: "anthropic",
      Model: "claude-sonnet-5",
      Output: "15",
      Input: "3",
    });
    await submit();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/core-platform/spend?tab=pricing",
      );
    });
    expect(setPriceEntryAction).toHaveBeenCalledTimes(1);
    expect(
      setPriceEntryAction.mock.calls.flatMap(([, first, rest]) => [
        first,
        ...rest,
      ]),
    ).toEqual([
      expect.objectContaining({
        tokenClass: "input_uncached",
        usdPerMillion: "3",
        model: "claude-sonnet-5",
      }),
      expect.objectContaining({ tokenClass: "output", usdPerMillion: "15" }),
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // With the date left blank each server action would pick its own
  // `new Date()`, so a card's classes would start at several instants and a
  // frame in between would be priced at negotiated input and list output —
  // the exact half-card state the sequence exists to keep out of the book.
  it("sends every class of a card under ONE instant when no date is typed", async () => {
    setPriceEntryAction.mockResolvedValue({ ok: true, value: null });
    await openDialog();
    await fill({
      Vendor: "anthropic",
      Model: "claude-sonnet-5",
      Input: "3",
      "Cached input read": "0.3",
      Output: "15",
    });
    const before = Date.now();
    await submit();
    await waitFor(() => {
      expect(setPriceEntryAction).toHaveBeenCalledTimes(1);
    });

    const instants = setPriceEntryAction.mock.calls.flatMap(([, first, rest]) =>
      [first, ...rest].map((values) => values["effectiveFrom"]),
    );
    expect(instants).toHaveLength(3);
    expect(new Set(instants).size).toBe(1);
    const [instant] = instants;
    if (typeof instant !== "string") throw new Error("no instant was sent");
    // An instant, not a UTC day: a day would backdate the rate to midnight and
    // reprice every frame the organization ran earlier today.
    expect(instant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(instant).getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("keeps every class unwritten when the atomic call is refused (negative)", async () => {
    setPriceEntryAction.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await openDialog();
    await fill({
      Vendor: "anthropic",
      Model: "claude-sonnet-5",
      Input: "3",
      Output: "15",
    });
    // Reasoning is not one of the four classes a card usually names, so it is
    // reached through the disclosure.
    await userEvent.click(
      screen.getByRole("button", { name: "Show every token class" }),
    );
    await fill({ Reasoning: "15" });
    await submit();

    const written = await screen.findByTestId("spend-price-written");
    expect(written).toHaveTextContent(
      "Nothing was written. The price book is unchanged.",
    );
    expect(screen.getByTestId("spend-price-not-written")).toHaveTextContent(
      "Not written: Input, Output and Reasoning.",
    );
    expect(screen.getByTestId("spend-price-failure")).toHaveTextContent(
      "An organization owner, admin or billing member sets a negotiated rate.",
    );
    // A refused card stays open with every entered value.
    expect(
      screen.getByRole("dialog", { name: "Set a negotiated rate" }),
    ).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    expect(setPriceEntryAction).toHaveBeenCalledTimes(1);
  });

  it("does not claim the book is unchanged when the response is unavailable", async () => {
    setPriceEntryAction.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "kernel_failure",
    });
    await openDialog();
    await fill({
      Vendor: "anthropic",
      Model: "claude-sonnet-5",
      Input: "3",
      Output: "15",
    });
    await submit();

    expect(
      await screen.findByTestId("spend-price-failure"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("spend-price-written")).toBeNull();
    expect(setPriceEntryAction).toHaveBeenCalledTimes(1);
  });

  it("keeps a filled class on screen, so a collapsed card never sends a figure nobody can see", async () => {
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "Show every token class" }),
    );
    await userEvent.type(screen.getByLabelText("Rerank"), "1");
    expect(screen.getByLabelText("Rerank")).toHaveValue("1");
  });
});

describe("Remove a negotiated rate", () => {
  const entry = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenClass: "output" as const,
    region: null,
  };

  async function openDialog() {
    renderWithIntl(<RemoveRateDialog at={at} entry={entry} />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Remove the negotiated rate for claude-sonnet-5, Output",
      }),
    );
    return screen.getByRole("dialog", { name: "Fall back to the list price" });
  }

  it("says the model falls back to the provider's list price, and that nothing is deleted", async () => {
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(
      "every call from now on is priced at the provider’s list price instead",
    );
    expect(dialog).toHaveTextContent("Nothing is deleted.");
    expect(dialog).toHaveTextContent(
      "a run priced before now still names the rate it was priced with",
    );
    expect(
      screen.getByRole("button", { name: "End this rate, use the list price" }),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/\bdelete this\b/i);
  });

  it("ends the rate by its key and returns to the Pricing tab", async () => {
    removePriceEntryAction.mockResolvedValue({
      ok: true,
      value: { fallbackPriced: true },
    });
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "End this rate, use the list price" }),
    );
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/core-platform/spend?tab=pricing",
      );
    });
    expect(removePriceEntryAction).toHaveBeenCalledWith(at, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "output",
      region: "",
    });
  });

  // No list or override price covers this model and class: the "falls back
  // to the list price" promise the confirm step made would be false, so the
  // dialog must say the class went unpriced instead of navigating away as if
  // nothing were wrong.
  it("warns the class is unpriced instead of claiming a fallback that does not exist", async () => {
    removePriceEntryAction.mockResolvedValue({
      ok: true,
      value: { fallbackPriced: false },
    });
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "End this rate, use the list price" }),
    );
    expect(
      await screen.findByTestId("spend-remove-rate-unpriced"),
    ).toHaveTextContent(
      "calls from now on are UNPRICED, not priced at the list rate",
    );
    expect(router.replace).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByTestId("spend-remove-rate-unpriced-close"),
    );
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/core-platform/spend?tab=pricing",
      );
    });
  });

  it("shows the refusal and changes nothing when the role cannot end a rate (negative)", async () => {
    removePriceEntryAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "End this rate, use the list price" }),
    );
    expect(
      await screen.findByTestId("spend-remove-rate-failure"),
    ).toHaveTextContent(
      "Your organization role cannot change what this organization is billed at.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  // The handler checks for a fallback BEFORE closing and refuses with this
  // exact code rather than close first and report the gap afterward — the
  // dialog must turn that refusal into a confirm step, not a bare error.
  it("asks for confirmation instead of showing a bare error when closing would unprice the class", async () => {
    removePriceEntryAction.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "price_entry_close_would_unprice",
    });
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "End this rate, use the list price" }),
    );
    const confirmDialog = await screen.findByRole("dialog", {
      name: "This class would become unpriced",
    });
    expect(confirmDialog).toHaveTextContent(
      "leaves every call from now on UNPRICED, not priced at the list rate",
    );
    expect(removePriceEntryAction).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("closes the rate once the person confirms it may go unpriced", async () => {
    removePriceEntryAction
      .mockResolvedValueOnce({
        ok: false,
        reason: "conflict",
        code: "price_entry_close_would_unprice",
      })
      .mockResolvedValueOnce({ ok: true, value: { fallbackPriced: false } });
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "End this rate, use the list price" }),
    );
    await screen.findByRole("dialog", {
      name: "This class would become unpriced",
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: "End the rate anyway, leave it unpriced",
      }),
    );
    expect(
      await screen.findByTestId("spend-remove-rate-unpriced"),
    ).toHaveTextContent(
      "calls from now on are UNPRICED, not priced at the list rate",
    );
    expect(removePriceEntryAction).toHaveBeenLastCalledWith(at, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "output",
      region: "",
      confirmUnpriced: true,
    });
  });

  it("lets the person back out of the confirm step without closing anything", async () => {
    removePriceEntryAction.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "price_entry_close_would_unprice",
    });
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "End this rate, use the list price" }),
    );
    await screen.findByRole("dialog", {
      name: "This class would become unpriced",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Keep the current rate" }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "Fall back to the list price",
      }),
    ).toBeInTheDocument();
    expect(removePriceEntryAction).toHaveBeenCalledTimes(1);
  });
});
