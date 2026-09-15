// @vitest-environment jsdom
// The approval clock: it first reads the server's instant, then ticks once a
// second, counting up from a parked call or down to its expiry, never below 0:00.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { Clock } from "./clock";
import { NOW } from "./fleet.builders";

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
