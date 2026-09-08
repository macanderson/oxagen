import { describe, expect, it } from "vitest";
import {
  byStatus,
  knownUnenforcedSince,
  render,
  type ExposedOrg,
} from "./count-unenforced-iam-orgs";

const org = (over: Partial<ExposedOrg> = {}): ExposedOrg => ({
  orgId: "org_1",
  orgName: "Acme",
  planType: "scale",
  planTier: "enterprise",
  status: "trialing",
  trialEnd: null,
  canceledAt: null,
  currentPeriodStart: "2026-08-01T00:00:00Z",
  subscriptionUpdatedAt: "2026-09-01T00:00:00Z",
  ...over,
});

describe("knownUnenforcedSince", () => {
  it("takes the earliest date the row actually carries", () => {
    expect(knownUnenforcedSince(org())).toBe("2026-08-01T00:00:00Z");
  });

  it("prefers a cancellation date when it is earlier", () => {
    expect(
      knownUnenforcedSince(org({ canceledAt: "2026-07-01T00:00:00Z" })),
    ).toBe("2026-07-01T00:00:00Z");
  });

  it("returns null when nothing in the row dates the status", () => {
    // The honest answer. A floor invented from an unrelated column would read
    // as a start time and be wrong.
    expect(
      knownUnenforcedSince(
        org({ currentPeriodStart: null, subscriptionUpdatedAt: null }),
      ),
    ).toBeNull();
  });

  it("uses the row's updated_at only for a paused subscription", () => {
    expect(
      knownUnenforcedSince(org({ status: "paused", currentPeriodStart: null })),
    ).toBe("2026-09-01T00:00:00Z");
    expect(
      knownUnenforcedSince(
        org({ status: "trialing", currentPeriodStart: null }),
      ),
    ).toBeNull();
  });
});

describe("byStatus", () => {
  it("counts orgs per status, which is the shape #1384 asked for", () => {
    const counts = byStatus([
      org({ status: "trialing" }),
      org({ status: "trialing" }),
      org({ status: "past_due" }),
    ]);
    expect(counts.get("trialing")).toBe(2);
    expect(counts.get("past_due")).toBe(1);
  });
});

describe("render", () => {
  it("says an empty result is only as good as the database", () => {
    // The failure mode this guards: running it against staging, finding
    // nothing, and recording "nobody was affected" on the issue.
    const out = render([], "localhost:5432");
    expect(out).toContain("no org is exposed");
    expect(out).toContain("Check the host above is production");
  });

  it("names each org, its status, and how far back the row dates it", () => {
    const out = render([org()], "prod");
    expect(out).toContain("org_1");
    expect(out).toContain("trialing");
    expect(out).toContain("2026-08-01T00:00:00Z");
  });

  it("says plainly that the dates are floors, not start times", () => {
    const out = render([org()], "prod");
    expect(out).toContain("FLOORS, not start times");
    expect(out).toContain("keeps no subscription");
  });
});
