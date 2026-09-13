import { describe, it, expect } from "vitest";
import {
  parseAuditFilter,
  encodeAuditFilter,
  hasActiveFilter,
  eventTypesInGroup,
  EVENT_TYPE_GROUPS,
  FILTERABLE_EVENT_TYPES,
  SECURITY_EVENT_TYPES,
} from "./audit-filters";
import { RESERVED_SECURITY_EVENT_TYPES } from "@oxagen/compliance";

describe("parseAuditFilter", () => {
  it("parses repeated and comma-joined event_type, dropping unknowns", () => {
    const f = parseAuditFilter({ event_type: ["auth.sign_in", "bogus.value"] });
    expect(f.eventTypes).toEqual(["auth.sign_in"]);

    const g = parseAuditFilter({
      event_type: "auth.sign_in,billing.plan_changed,nope",
    });
    expect(g.eventTypes.sort()).toEqual([
      "auth.sign_in",
      "billing.plan_changed",
    ]);
  });

  it("dedupes event types", () => {
    const f = parseAuditFilter({
      event_type: ["auth.sign_in", "auth.sign_in"],
    });
    expect(f.eventTypes).toEqual(["auth.sign_in"]);
  });

  it("validates outcome and drops unknown ones", () => {
    expect(parseAuditFilter({ outcome: "deny" }).outcome).toBe("deny");
    expect(parseAuditFilter({ outcome: "maybe" }).outcome).toBeNull();
  });

  it("parses actor, free text, and dates", () => {
    const f = parseAuditFilter({
      actor: "user-123",
      q: "  10.0.0.1 ",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
    });
    expect(f.actorUserId).toBe("user-123");
    expect(f.q).toBe("10.0.0.1");
    expect(f.from?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(f.to?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("treats blank free text and bad dates as absent", () => {
    const f = parseAuditFilter({ q: "   ", from: "not-a-date" });
    expect(f.q).toBeNull();
    expect(f.from).toBeNull();
  });

  it("parses a keyset cursor token", () => {
    const f = parseAuditFilter({ cursor: "2026-06-01T03:00:00.000Z|evt-abc" });
    expect(f.cursor?.occurredAt.toISOString()).toBe("2026-06-01T03:00:00.000Z");
    expect(f.cursor?.id).toBe("evt-abc");
  });

  it("ignores a malformed cursor", () => {
    expect(parseAuditFilter({ cursor: "garbage" }).cursor).toBeNull();
    expect(parseAuditFilter({ cursor: "|evt" }).cursor).toBeNull();
  });
});

describe("encodeAuditFilter", () => {
  it("round-trips a filter through encode → parse", () => {
    const original = parseAuditFilter({
      event_type: ["auth.sign_in", "billing.plan_changed"],
      outcome: "deny",
      actor: "user-1",
      q: "req-99",
      from: "2026-01-01T00:00:00Z",
    });
    const sp = encodeAuditFilter(original);
    const roundTripped = parseAuditFilter(
      Object.fromEntries(
        [...new Set(sp.keys())].map((k) => [
          k,
          sp.getAll(k).length > 1 ? sp.getAll(k) : sp.get(k)!,
        ]),
      ),
    );
    expect(roundTripped.eventTypes.sort()).toEqual(original.eventTypes.sort());
    expect(roundTripped.outcome).toBe(original.outcome);
    expect(roundTripped.actorUserId).toBe(original.actorUserId);
    expect(roundTripped.q).toBe(original.q);
    expect(roundTripped.from?.toISOString()).toBe(original.from?.toISOString());
  });

  it("can override the cursor (next page) without mutating the filter", () => {
    const f = parseAuditFilter({ event_type: "auth.sign_in" });
    const cursor = { occurredAt: new Date("2026-06-01T00:00:00Z"), id: "x" };
    const sp = encodeAuditFilter(f, { cursor });
    expect(sp.get("cursor")).toBe("2026-06-01T00:00:00.000Z|x");
    // Original filter unchanged.
    expect(f.cursor).toBeNull();
  });

  it("can clear the cursor explicitly", () => {
    const f = parseAuditFilter({
      cursor: "2026-06-01T00:00:00.000Z|x",
      event_type: "auth.sign_in",
    });
    const sp = encodeAuditFilter(f, { cursor: null });
    expect(sp.has("cursor")).toBe(false);
  });
});

describe("helpers", () => {
  it("hasActiveFilter reflects any active dimension", () => {
    expect(hasActiveFilter(parseAuditFilter({}))).toBe(false);
    expect(hasActiveFilter(parseAuditFilter({ outcome: "deny" }))).toBe(true);
    expect(hasActiveFilter(parseAuditFilter({ q: "x" }))).toBe(true);
  });

  it("eventTypesInGroup returns the prefixed members", () => {
    const auth = eventTypesInGroup("auth");
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.every((t) => t.startsWith("auth."))).toBe(true);
    expect(eventTypesInGroup("nope")).toEqual([]);
  });
});

/**
 * #2528. The filter offered every DECLARED type, including eight the taxonomy
 * itself marks as having no emitter. Selecting one returns zero rows, which
 * reads as "this never happened" — when the true answer is "we do not log this
 * yet". In a compliance tool that is the difference that matters, and the
 * filter had no way to express it.
 */
describe("the filter only offers types something writes", () => {
  it("offers no reserved type", () => {
    for (const reserved of RESERVED_SECURITY_EVENT_TYPES) {
      expect(FILTERABLE_EVENT_TYPES, reserved).not.toContain(reserved);
    }
  });

  it("names a specific one, so the assertion is legible", () => {
    // Both were selectable before, and both return zero rows forever.
    expect(FILTERABLE_EVENT_TYPES).not.toContain("auth.token_refreshed");
    expect(FILTERABLE_EVENT_TYPES).not.toContain("plugin.denylist_added");
  });

  it("keeps offering the ones that are logged", () => {
    expect(FILTERABLE_EVENT_TYPES).toContain("auth.sign_in");
    expect(FILTERABLE_EVENT_TYPES).toContain("capability.invoke_denied");
    expect(FILTERABLE_EVENT_TYPES.length).toBeGreaterThan(0);
  });

  it("drops a reserved type from its group listing too", () => {
    // The group chips build from the same subset, so `auth.*` must not offer
    // a type the `auth` group cannot produce.
    expect(eventTypesInGroup("auth")).not.toContain("auth.token_refreshed");
    expect(eventTypesInGroup("auth")).toContain("auth.sign_in");
  });

  it("drops a group that is entirely reserved rather than showing an empty chip", () => {
    // Every plugin.denylist_* type is reserved, but plugin.installed is not,
    // so the group survives — this pins that the chips come from the subset.
    expect(EVENT_TYPE_GROUPS).toContain("plugin");
    expect(eventTypesInGroup("plugin")).not.toContain("plugin.denylist_added");
  });

  it("still parses a reserved type out of a URL, so old links and rows survive", () => {
    // Narrowing what the UI OFFERS must not narrow what it can read: a
    // bookmarked filter, or a historical row, still has to resolve.
    const f = parseAuditFilter({ event_type: ["auth.token_refreshed"] });
    expect(f.eventTypes).toEqual(["auth.token_refreshed"]);
    expect(SECURITY_EVENT_TYPES).toContain("auth.token_refreshed");
  });
});
