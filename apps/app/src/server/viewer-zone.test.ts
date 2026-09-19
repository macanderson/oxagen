// The zone a mandate write resolves a picked day in, and the two ways it refuses
// rather than guessing. Both refusals matter more than they look: a guessed zone
// moves a validity boundary by up to a day, in the widening direction for every
// zone east of the default, and nothing on screen afterwards says it was guessed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrgCtx, type OrgFields } from "./viewer";
import { unsafeMint } from "./viewer.testing";

const { kernelRead } = vi.hoisted(() => ({ kernelRead: vi.fn() }));
vi.mock("./kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kernel")>()),
  kernelRead,
}));

const { viewerTimeZone } = await import("./viewer-zone");

// The helper only forwards this to kernelRead, which is mocked.
const orgFields: OrgFields = {
  userId: "u1",
  orgId: "11111111-1111-4111-8111-111111111111",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
};
const ctx = unsafeMint(OrgCtx, orgFields);

beforeEach(() => {
  kernelRead.mockReset();
});

describe("viewerTimeZone", () => {
  it("answers the zone the viewer stored", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { timezone: "Asia/Tokyo" },
    });
    expect(await viewerTimeZone(ctx, "mandates")).toEqual({
      ok: true,
      timeZone: "Asia/Tokyo",
    });
  });

  it("refuses, retryably, when the read does not answer (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "control_plane_unavailable",
      status: 503,
    });
    // Not a fallback to the app's default. For an operator in Tokyo, Pacific
    // moves the end of their day 17 hours later, which is authority nobody
    // granted. A refusal is visible and the write can be made again.
    expect(await viewerTimeZone(ctx, "mandates")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "time_zone_unavailable",
    });
  });

  it("refuses a denial the same way (negative)", async () => {
    kernelRead.mockResolvedValue({ ok: false, reason: "denied" });
    expect(await viewerTimeZone(ctx, "agents")).toMatchObject({
      ok: false,
      code: "time_zone_unavailable",
    });
  });

  it("refuses a stored zone this runtime cannot read, as a conflict (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { timezone: "Mars/Olympus_Mons" },
    });
    // A conflict, not an unavailability: retrying cannot help until the person
    // stores a zone this runtime knows, and the sentence says so.
    expect(await viewerTimeZone(ctx, "mandates")).toEqual({
      ok: false,
      reason: "conflict",
      code: "time_zone_unsupported",
    });
  });

  it("reads the page it was given, so a failure is attributed to the right surface", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { timezone: "UTC" },
    });
    await viewerTimeZone(ctx, "agents");
    expect(kernelRead).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ page: "agents" }),
    );
  });
});
