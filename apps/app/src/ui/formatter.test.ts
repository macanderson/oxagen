// The slot is React's per-request `cache`. Here `cache` is held as a server
// request holds it (one memoized value for the test file), so the test shows
// both halves: before <ViewerClock> writes a zone the hook answers next-intl's
// own formatter, and after it the hook formats in that zone.
import { describe, expect, it, vi } from "vitest";

const { next, createFormatter } = vi.hoisted(() => ({
  next: vi.fn(() => "next-intl formatter"),
  createFormatter: vi.fn(() => "zoned formatter"),
}));
vi.mock("next-intl", () => ({
  useFormatter: next,
  useLocale: () => "en",
  createFormatter,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: () => T) => {
    let held: { value: T } | undefined;
    return () => (held ??= { value: fn() }).value;
  },
}));

const { setViewerTimeZone, useFormatter } = await import("./formatter");

describe("useFormatter", () => {
  it("answers next-intl's formatter before a zone is written, as on the client", () => {
    expect(useFormatter()).toBe("next-intl formatter");
    expect(createFormatter).not.toHaveBeenCalled();
  });

  it("formats in the viewer's zone once <ViewerClock> has written it", () => {
    setViewerTimeZone("Asia/Tokyo");
    expect(useFormatter()).toBe("zoned formatter");
    expect(createFormatter).toHaveBeenCalledWith({
      locale: "en",
      timeZone: "Asia/Tokyo",
    });
  });
});
