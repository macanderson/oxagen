// @vitest-environment jsdom
// The clock around the pages: a date formatted under it reads in the zone the
// preference read answered, and in Pacific time when that read failed.
import { cleanup, render, screen } from "@testing-library/react";
import { useFormatter } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    <time data-testid="clock">
      {format.dateTime(NOON_UTC, { hour: "2-digit", hour12: false })}
    </time>
  );
}

async function renderUnder(preferences: unknown) {
  const source = {
    shell: { preferences: vi.fn().mockResolvedValue(preferences) },
  } as unknown as Parameters<typeof ViewerClock>[0]["source"];
  const tree = await ViewerClock({ ctx, source, children: <Clock /> });
  render(<IntlProvider>{tree}</IntlProvider>);
  expect(source.shell.preferences).toHaveBeenCalledWith(ctx);
  return screen.getByTestId("clock").textContent;
}

afterEach(cleanup);

describe("ViewerClock", () => {
  it("formats a date under it in the zone the preference read answered", async () => {
    expect(await renderUnder(readOk({ timeZone: "Asia/Tokyo" }))).toBe("21");
  });

  it("formats in Pacific time when the preference read failed, rather than blanking the page (negative)", async () => {
    expect(await renderUnder(readError("control_plane_unavailable", 503))).toBe(
      "04",
    );
  });
});
