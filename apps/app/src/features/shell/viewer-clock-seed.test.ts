// <ViewerClock> must write the zone into the formatter slot before it returns
// children. Without that call, server components under the org layout keep
// formatting in Pacific time even when the preference read answered another
// zone. The client provider path is covered by viewer-clock.test.tsx.
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Classic JSX transform looks up `React` as a free variable. Bind it for this
// file so the assertion can run without the Vite React plugin. `Reflect.set`
// rather than a cast or `Object.assign`: this app forbids type assertions
// outright, and forbids `Object.assign` as a way to copy a value into any
// shape (INV-02).
Reflect.set(globalThis, "React", React);

const setViewerTimeZone = vi.fn();
vi.mock("@/ui/formatter", () => ({ setViewerTimeZone }));
vi.mock("./time-zone-provider", () => ({
  TimeZoneProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { ViewerClock } = await import("./viewer-clock");
const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { DEFAULT_TIME_ZONE } = await import(
  "@oxagen/oxagen/contracts/user.preferences.read"
);

const ctx = unsafeMint(OrgCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

beforeEach(() => {
  setViewerTimeZone.mockReset();
});

describe("ViewerClock zone seed", () => {
  it("writes the preference zone into the formatter slot", async () => {
    const preferences = vi
      .fn()
      .mockResolvedValue(readOk({ timeZone: "Asia/Tokyo" }));
    await ViewerClock({
      ctx,
      source: {
        shell: {
          context: vi.fn(),
          preferences,
          counts: vi.fn(),
          notifications: vi.fn(),
          assistantEngine: vi.fn(),
        },
      },
      children: null,
    });
    expect(setViewerTimeZone).toHaveBeenCalledWith("Asia/Tokyo");
  });

  it("writes Pacific time when the preference read failed (negative)", async () => {
    const preferences = vi
      .fn()
      .mockResolvedValue(readError("control_plane_unavailable", 503));
    await ViewerClock({
      ctx,
      source: {
        shell: {
          context: vi.fn(),
          preferences,
          counts: vi.fn(),
          notifications: vi.fn(),
          assistantEngine: vi.fn(),
        },
      },
      children: null,
    });
    expect(setViewerTimeZone).toHaveBeenCalledWith(DEFAULT_TIME_ZONE);
  });
});
