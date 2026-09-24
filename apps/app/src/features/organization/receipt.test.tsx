// @vitest-environment jsdom
// The receipt a governed write leaves (receipt.tsx): a line in a polite live
// region, kept in the module so a stack mounted after the write's re-read
// still shows it, and gone after the toast's 4.2 seconds.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { TOAST_MS } from "@/ui/toast";
import { Receipts, recordReceipt } from "./receipt";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => {
    vi.runOnlyPendingTimers();
  });
  vi.useRealTimers();
  cleanup();
});

describe("Receipts", () => {
  it("shows a write's line in a polite live region", () => {
    render(<Receipts />);
    act(() => {
      recordReceipt("Role saved. Recorded in the audit record.");
    });
    const stack = screen.getByTestId("organization-receipts");
    expect(stack).toHaveAttribute("aria-live", "polite");
    expect(stack).toHaveTextContent(
      "Role saved. Recorded in the audit record.",
    );
  });

  it("keeps a line recorded before the stack mounted, as after a re-read remounts the tab", () => {
    act(() => {
      recordReceipt("Invitation revoked. Recorded in the audit record.");
    });
    render(<Receipts />);
    expect(screen.getByTestId("organization-receipts")).toHaveTextContent(
      "Invitation revoked. Recorded in the audit record.",
    );
  });

  it("drops the line after the toast's time, and not before (negative)", () => {
    render(<Receipts />);
    act(() => {
      recordReceipt("Key revoked. Recorded in the audit record.");
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.getByTestId("organization-receipts")).toHaveTextContent(
      "Key revoked.",
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("organization-receipts")).toBeEmptyDOMElement();
  });

  it("passes the accessibility check with a line showing", async () => {
    // axe schedules its own work on timers, so this case runs on real ones
    // and hands fake ones back for the shared teardown.
    vi.useRealTimers();
    const view = render(<Receipts />);
    act(() => {
      recordReceipt("Key created. Recorded in the audit record.");
    });
    await expectNoAxe(view.container);
    vi.useFakeTimers();
  });
});
