// @vitest-environment jsdom
// The live clock: it first reads the server's instant, then ticks once a
// second, counting up from an instant or down to one, never below 0:00.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { Clock } from "./clock";

const NOW = Date.parse("2026-09-15T09:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(async () => {
  vi.useRealTimers();
  await expectNoAxe(document.body);
  cleanup();
});

describe("Clock", () => {
  it("counts up from a parked instant, second by second", () => {
    render(
      <IntlProvider>
        <Clock at={NOW - 150_000} now={NOW} direction="since" />
      </IntlProvider>,
    );
    expect(screen.getByText("2:30")).toHaveAttribute("datetime", "PT150S");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("2:35")).toBeInTheDocument();
  });

  it("counts down to an expiry and stops at 0:00 (negative)", () => {
    render(
      <IntlProvider>
        <Clock at={NOW + 2_000} now={NOW} direction="until" />
      </IntlProvider>,
    );
    expect(screen.getByText("0:02")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("reads hours as h:mm:ss, so a run open for days still fits its tile", () => {
    render(
      <IntlProvider>
        <Clock at={NOW - 3 * 86_400_000} now={NOW} direction="since" />
      </IntlProvider>,
    );
    expect(screen.getByText("72:00:00")).toHaveAttribute(
      "datetime",
      "PT259200S",
    );
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("72:00:01")).toBeInTheDocument();
  });

  it("renders the server's instant before any tick, so hydration matches", () => {
    vi.setSystemTime(NOW + 60_000);
    render(
      <IntlProvider>
        <Clock at={NOW - 1_000} now={NOW} direction="since" />
      </IntlProvider>,
    );
    expect(screen.getByText("0:01")).toBeInTheDocument();
  });
});
