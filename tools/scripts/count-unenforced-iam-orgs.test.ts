import { describe, expect, it } from "vitest";
import {
  AUDITED_SUBSCRIPTION_EVENTS,
  byStatus,
  groupByOrg,
  knownUnenforcedSince,
  normalizeExposedOrg,
  normalizeTransition,
  render,
  renderTimeline,
  toIsoOrNull,
  type ExposedOrg,
  type TransitionEvent,
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

// ── The audited transition timeline (#2714 item 2) ──────────────────────────
//
// The point of these tests is one distinction the whole feature turns on:
// an org with NO audited transition has an UNKNOWN window, not a clean record.
// Only three billing transitions emit an audit row, so silence is absence of
// evidence. A renderer that printed an empty timeline as a blank line would
// let a reader draw the opposite conclusion from the one the data supports.

const evt = (over: Partial<TransitionEvent> = {}): TransitionEvent => ({
  orgId: "org_1",
  eventType: "billing.subscription_canceled",
  occurredAt: "2026-07-04T12:00:00Z",
  actorUserId: "user_1",
  ...over,
});

describe("AUDITED_SUBSCRIPTION_EVENTS", () => {
  it("names exactly the three billing transitions that leave an audit row", () => {
    expect([...AUDITED_SUBSCRIPTION_EVENTS]).toEqual([
      "billing.subscription_canceled",
      "billing.subscription_reactivated",
      "billing.plan_changed",
    ]);
  });
});

describe("renderTimeline", () => {
  it("reports an empty timeline as UNKNOWN, never as a clean record", () => {
    const out = renderTimeline([]).join("\n");
    expect(out).toContain("UNKNOWN, not clean");
    // The reason has to travel with the claim, or the next reader re-derives it.
    expect(out).toContain("only cancel, reactivate and plan-change");
  });

  it("lists the transitions it has, latest first, with the actor", () => {
    const out = renderTimeline([
      evt({ occurredAt: "2026-07-04T12:00:00Z" }),
      evt({
        occurredAt: "2026-02-01T09:00:00Z",
        eventType: "billing.plan_changed",
      }),
    ]).join("\n");
    expect(out).toContain("2026-07-04T12:00:00Z");
    expect(out).toContain("billing.plan_changed");
    expect(out).toContain("by user_1");
  });

  it("says a transition is dated but its destination status is not recorded", () => {
    // security_events has no payload column, so the row proves a change
    // happened and cannot say what it changed to. Claiming otherwise would be
    // the exact over-reading this issue is trying to avoid.
    const out = renderTimeline([evt()]).join("\n");
    expect(out).toContain("not which status it entered");
    expect(out).toContain("bounds the current window from below");
  });

  it("survives a row with no actor rather than printing undefined", () => {
    const out = renderTimeline([evt({ actorUserId: null })]).join("\n");
    expect(out).toContain("no actor recorded");
    expect(out).not.toContain("undefined");
  });
});

describe("groupByOrg", () => {
  it("keeps each org's transitions together and preserves their order", () => {
    const grouped = groupByOrg([
      evt({ orgId: "a", occurredAt: "2026-07-04T12:00:00Z" }),
      evt({ orgId: "b", occurredAt: "2026-06-01T12:00:00Z" }),
      evt({ orgId: "a", occurredAt: "2026-01-01T12:00:00Z" }),
    ]);
    expect(grouped.get("a")).toHaveLength(2);
    expect(grouped.get("b")).toHaveLength(1);
    expect(grouped.get("a")?.[0]?.occurredAt).toBe("2026-07-04T12:00:00Z");
  });

  it("returns an empty map for no events", () => {
    expect(groupByOrg([]).size).toBe(0);
  });
});

describe("render with timelines", () => {
  it("attaches each org's timeline under its entry", () => {
    const out = render([org()], "prod", groupByOrg([evt()]));
    expect(out).toContain("org_1");
    expect(out).toContain("billing.subscription_canceled");
  });

  it("marks an org with no audited transition as unknown rather than silent", () => {
    const out = render([org()], "prod", new Map());
    expect(out).toContain("UNKNOWN, not clean");
  });

  it("points at Stripe as the authoritative window", () => {
    const out = render([org()], "prod", new Map());
    expect(out).toContain("Stripe");
  });
});

// ── The Date-vs-string boundary (found by running against a real database) ──
//
// postgres.js decodes timestamptz to a JS Date. Every pure function below it
// was written against strings, and the mismatch made the script print
// "nothing in the row dates it" for every org — discarding the only floor the
// row carries. The fixtures could never have caught it, because a fixture
// hands in a string. These tests hand in Dates.

describe("toIsoOrNull", () => {
  it("converts the Date postgres.js actually returns into ISO-8601 UTC", () => {
    expect(toIsoOrNull(new Date("2026-08-02T18:55:40.000Z"))).toBe(
      "2026-08-02T18:55:40.000Z",
    );
  });

  it("passes a string through and treats an empty one as absent", () => {
    expect(toIsoOrNull("2026-08-02T18:55:40.000Z")).toBe(
      "2026-08-02T18:55:40.000Z",
    );
    expect(toIsoOrNull("")).toBeNull();
  });

  it("returns null for null, undefined, an invalid Date and a non-date value", () => {
    expect(toIsoOrNull(null)).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
    expect(toIsoOrNull(new Date("not a date"))).toBeNull();
    expect(toIsoOrNull(12345)).toBeNull();
  });
});

describe("normalizeExposedOrg", () => {
  it("makes a Date-carrying row datable, which is the whole defect", () => {
    const raw = org({
      status: "past_due",
      currentPeriodStart: new Date(
        "2026-06-13T00:00:00.000Z",
      ) as unknown as string,
      canceledAt: null,
      trialEnd: null,
      subscriptionUpdatedAt: null,
    });
    // Before normalising, the floor is lost.
    expect(knownUnenforcedSince(raw)).toBeNull();
    // After, it is the period start.
    expect(knownUnenforcedSince(normalizeExposedOrg(raw))).toBe(
      "2026-06-13T00:00:00.000Z",
    );
  });

  it("leaves a row that is already strings untouched", () => {
    const already = org();
    expect(normalizeExposedOrg(already)).toEqual(already);
  });
});

describe("normalizeTransition", () => {
  it("renders an audited transition as ISO-8601 UTC, not a local-timezone string", () => {
    const normalized = normalizeTransition(
      evt({ occurredAt: new Date("2026-08-02T18:55:40.000Z") as unknown as string }),
    );
    expect(normalized.occurredAt).toBe("2026-08-02T18:55:40.000Z");
    const out = renderTimeline([normalized]).join("\n");
    expect(out).toContain("2026-08-02T18:55:40.000Z");
    // A compliance record must not carry a date whose meaning depends on where
    // the reader's laptop was.
    expect(out).not.toContain("GMT");
  });
});
