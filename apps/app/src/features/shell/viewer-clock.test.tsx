// @vitest-environment jsdom
// The clock around the pages: a date formatted under it reads in the zone the
// preference read answered, and in Pacific time when that read failed.
import { cleanup, render, screen } from "@testing-library/react";
import { useFormatter } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { ViewerClock } = await import("./viewer-clock");
const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");

const ctx = unsafeMint(OrgCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

// Noon UTC on a January day: 04:00 in Los Angeles, 21:00 in Tokyo.
const NOON_UTC = new Date("2026-01-15T12:00:00Z");

function Clock() {
  const format = useFormatter();
  return (
    <time data-testid="clock" dateTime={NOON_UTC.toISOString()}>
      {format.dateTime(NOON_UTC, { hour: "2-digit", hour12: false })}
    </time>
  );
}

const preferences = vi.fn();

async function renderUnder(read: unknown) {
  preferences.mockReset();
  preferences.mockResolvedValue(read);
  const tree = await ViewerClock({
    ctx,
    source: {
      shell: {
        context: vi.fn(),
        preferences,
        counts: vi.fn(),
        notifications: vi.fn(),
      },
    },
    children: <Clock />,
  });
  const { container } = render(<IntlProvider>{tree}</IntlProvider>);
  expect(preferences).toHaveBeenCalledWith(ctx);
  return { text: screen.getByTestId("clock").textContent, container };
}

afterEach(cleanup);

describe("ViewerClock", () => {
  it("formats a date under it in the zone the preference read answered", async () => {
    const { text } = await renderUnder(readOk({ timeZone: "Asia/Tokyo" }));
    expect(text).toBe("21");
  });

  it("formats in Pacific time when the preference read failed, rather than blanking the page (negative)", async () => {
    const { text } = await renderUnder(
      readError("control_plane_unavailable", 503),
    );
    expect(text).toBe("04");
  });

  it("has no axe violations", async () => {
    const { container } = await renderUnder(readOk({ timeZone: "Asia/Tokyo" }));
    await expectNoAxe(container);
  });
});
