// @vitest-environment jsdom
// The toast stack: a row per event in one polite live region, newest last,
// each gone after the design's 4.2 seconds.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_MS, ToastStack, type ToastTone, useToasts } from "./toast";

let push: (text: string, tone?: ToastTone) => void = () => undefined;

function Host() {
  const { toasts, toast } = useToasts();
  push = toast;
  return <ToastStack toasts={toasts} testId="toasts" />;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToastStack", () => {
  it("is one polite live region, mounted before any row", () => {
    render(<Host />);
    const stack = screen.getByTestId("toasts");
    expect(stack).toHaveAttribute("role", "status");
    expect(stack).toHaveAttribute("aria-live", "polite");
    expect(stack).toBeEmptyDOMElement();
  });

  it("stacks rows newest last, each with its tone, and drops each after 4.2 seconds", () => {
    render(<Host />);
    act(() => {
      push("Export bundle queued for arun_1.");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
      push("The export bundle for arun_2 was not queued.", "failed");
    });
    const rows = screen.getAllByText(/export bundle/i);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Export bundle queued for arun_1.",
      "The export bundle for arun_2 was not queued.",
    ]);
    expect(rows[1]?.closest("[data-toast]")).toHaveAttribute(
      "data-tone",
      "failed",
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1000);
    });
    expect(screen.queryByText("Export bundle queued for arun_1.")).toBeNull();
    expect(
      screen.getByText("The export bundle for arun_2 was not queued."),
    ).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("toasts")).toBeEmptyDOMElement();
  });

  it("clears its timers when the page unmounts (negative)", () => {
    const { unmount } = render(<Host />);
    act(() => {
      push("Pause queued.", "approval");
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
