// @vitest-environment jsdom
// The app's one toast stack (ADR-221): `toast(text, tone)` from anywhere puts a
// line in the toaster the root layout mounts, a polite region named from the
// catalogue, each line gone after the design's 4.2 seconds or when its close
// button is pressed.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { TOAST_MS, Toaster, toast } from "./toast";

function renderToaster() {
  return render(
    <IntlProvider>
      <Toaster />
    </IntlProvider>,
  );
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-toast]"));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toaster", () => {
  it("is one polite region named from the catalogue, with no line before a toast", () => {
    renderToaster();
    const stack = screen.getByTestId("toasts");
    expect(stack).toHaveAttribute("role", "region");
    expect(stack).toHaveAccessibleName("Notifications");
    expect(stack).toHaveAttribute("aria-live", "polite");
    expect(rows()).toHaveLength(0);
  });

  it("shows each line with its tone, newest in front", () => {
    renderToaster();
    act(() => {
      toast("Export bundle queued for arun_1.");
    });
    act(() => {
      toast("The export bundle for arun_2 was not queued.", "failed");
    });
    expect(rows().map((row) => [row.textContent, row.dataset.tone])).toEqual([
      ["The export bundle for arun_2 was not queued.", "failed"],
      ["Export bundle queued for arun_1.", "allowed"],
    ]);
    expect(rows()[0]?.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("drops each line after 4.2 seconds, and not before (negative)", () => {
    vi.useFakeTimers();
    renderToaster();
    act(() => {
      toast("Pause queued.", "approval");
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.getByText("Pause queued.")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Pause queued.")).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("drops a line when its close button is pressed", async () => {
    renderToaster();
    act(() => {
      toast("Key revoked. Recorded in the audit record.");
    });
    // Base UI hides the close button from assistive technology until the
    // stack opens on hover or focus, so the pointer enters the stack first.
    fireEvent.mouseEnter(screen.getByTestId("toasts"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(
        screen.queryByText("Key revoked. Recorded in the audit record."),
      ).toBeNull();
    });
  });

  it("keeps no line once the toaster unmounts, so a later one starts empty (negative)", () => {
    vi.useFakeTimers();
    const first = renderToaster();
    act(() => {
      toast("Role saved. Recorded in the audit record.");
    });
    first.unmount();
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    renderToaster();
    expect(rows()).toHaveLength(0);
  });

  it("drops a line raised while no toaster is mounted (negative)", () => {
    act(() => {
      toast("Invitation revoked. Recorded in the audit record.");
    });
    renderToaster();
    expect(rows()).toHaveLength(0);
  });

  it("passes the accessibility check with a line showing", async () => {
    renderToaster();
    act(() => {
      toast("Key created. Recorded in the audit record.");
    });
    // The toaster renders in a portal, outside the render container.
    await expectNoAxe(screen.getByTestId("toasts"));
  });
});
