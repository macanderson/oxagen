// @vitest-environment jsdom
// The receipt a governed write leaves (receipt.tsx): one allowed line in the
// toaster the root layout mounts, so it outlives the dialog or tab the write
// was made from, gone after the toast's 4.2 seconds.
import { act, cleanup, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { TOAST_MS, Toaster } from "@/ui/toast";
import { recordReceipt } from "./receipt";

function withToaster(ui: ReactNode) {
  return render(
    <IntlProvider>
      <Toaster />
      {ui}
    </IntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("recordReceipt", () => {
  it("shows a write's line in the app's polite toast region, as an allowed line", () => {
    withToaster(null);
    act(() => {
      recordReceipt("Role saved. Recorded in the audit record.");
    });
    const stack = screen.getByTestId("toasts");
    expect(stack).toHaveAttribute("aria-live", "polite");
    expect(stack).toHaveTextContent("Role saved. Recorded in the audit record.");
    expect(stack.querySelector("[data-toast]")).toHaveAttribute(
      "data-tone",
      "allowed",
    );
  });

  it("keeps the line after the dialog that made the write closes", () => {
    function Dialog() {
      const [open, setOpen] = useState(true);
      return open ? (
        <button
          type="button"
          onClick={() => {
            recordReceipt("Invitation revoked. Recorded in the audit record.");
            setOpen(false);
          }}
        >
          Revoke
        </button>
      ) : null;
    }
    withToaster(<Dialog />);
    act(() => {
      screen.getByRole("button", { name: "Revoke" }).click();
    });
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.getByTestId("toasts")).toHaveTextContent(
      "Invitation revoked. Recorded in the audit record.",
    );
  });

  it("drops the line after the toast's time, and not before (negative)", () => {
    vi.useFakeTimers();
    withToaster(null);
    act(() => {
      recordReceipt("Key revoked. Recorded in the audit record.");
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.getByTestId("toasts")).toHaveTextContent("Key revoked.");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("toasts")).not.toHaveTextContent("Key revoked.");
    expect(document.querySelectorAll("[data-toast]")).toHaveLength(0);
  });

  it("passes the accessibility check with a line showing", async () => {
    withToaster(null);
    act(() => {
      recordReceipt("Key created. Recorded in the audit record.");
    });
    await expectNoAxe(screen.getByTestId("toasts"));
  });
});
