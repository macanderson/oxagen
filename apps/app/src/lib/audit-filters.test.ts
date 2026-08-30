import { describe, it, expect } from "vitest";
import {
  parseAuditFilter,
  encodeAuditFilter,
  hasActiveFilter,
  eventTypesInGroup,
} from "./audit-filters";

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
