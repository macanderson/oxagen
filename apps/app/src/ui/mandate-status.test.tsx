// @vitest-environment jsdom
// The shared status cell (#3152) in each state `windowOf` answers: the stored
// word alone while the window is open, and the word with "starts" or "ended"
// under it when an active mandate's window has not opened or has closed. Shared
// by the Tools ledger and the Agents table, so it is pinned here rather than
// through either page. The word is the record's in every case: a row is never
// relabelled.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type MandateRow, windowOf } from "@/data/contracts/mandates";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateRow } from "@/test/mandate-views";
import { MandateStatus } from "./mandate-status";

afterEach(cleanup);

const AS_OF = new Date("2026-09-16T12:00:00.000Z");

const draw = (mandate: MandateRow, at: Date = AS_OF) =>
  render(
    <IntlProvider>
      <MandateStatus mandate={mandate} windowState={windowOf(mandate, at)} />
    </IntlProvider>,
  );

const cell = (container: HTMLElement) =>
  container.querySelector("[data-mandate-status]");

describe("MandateStatus", () => {
  it("prints the stored word alone while the window is open", async () => {
    const { container } = draw(mandateRow());
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(cell(container)).toHaveAttribute("data-mandate-status", "active");
    expect(cell(container)).not.toHaveAttribute("data-effect");
    expect(screen.queryByText(/^(starts|ended) /)).toBeNull();
    await expectNoAxe(container);
  });

  it("says when a granted mandate starts, under the stored word", async () => {
    const { container } = draw(
      mandateRow({ validFrom: "2026-10-01T00:00:00.000Z" }),
    );
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(cell(container)).toHaveAttribute("data-effect", "upcoming");
    expect(screen.getByText(/^starts /)).toHaveTextContent("Oct 1, 2026");
    await expectNoAxe(container);
  });

  // The hourly expiry job leaves the row `active` after its window closed,
  // and the gate refuses it from `validTo` on.
  it("says when an active mandate's window closed, under the stored word", async () => {
    const { container } = draw(
      mandateRow({ validTo: "2026-09-10T00:00:00.000Z" }),
    );
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(cell(container)).toHaveAttribute("data-effect", "elapsed");
    expect(screen.getByText(/^ended /)).toHaveTextContent("Sep 10, 2026");
    await expectNoAxe(container);
  });

  // The two handovers at the instant itself, as enforcement's half-open
  // window has them.
  it("opens at validFrom itself and closes at validTo itself", () => {
    const validFrom = "2026-09-16T12:00:00.000Z";
    const validTo = "2026-09-20T00:00:00.000Z";
    const row = mandateRow({ validFrom, validTo });
    const effectAt = (instant: number) => {
      const { container } = draw(row, new Date(instant));
      const effect = cell(container)?.getAttribute("data-effect") ?? null;
      cleanup();
      return effect;
    };
    expect(effectAt(Date.parse(validFrom) - 1)).toBe("upcoming");
    expect(effectAt(Date.parse(validFrom))).toBeNull();
    expect(effectAt(Date.parse(validTo) - 1)).toBeNull();
    expect(effectAt(Date.parse(validTo))).toBe("elapsed");
  });

  it.each([
    ["draft" as const, "requested"],
    ["expired" as const, "expired"],
    ["revoked" as const, "revoked"],
  ])(
    "prints a %s row as %s and adds nothing, whatever its dates (negative)",
    async (status, word) => {
      const { container } = draw(
        mandateRow({ status, validTo: "2026-09-10T00:00:00.000Z" }),
      );
      expect(screen.getByText(word)).toBeInTheDocument();
      expect(cell(container)).toHaveAttribute("data-mandate-status", status);
      expect(cell(container)).not.toHaveAttribute("data-effect");
      expect(screen.queryByText(/^(starts|ended) /)).toBeNull();
      await expectNoAxe(container);
    },
  );
});
