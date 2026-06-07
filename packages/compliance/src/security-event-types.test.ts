import { describe, expect, it } from "vitest";
import {
  SECURITY_EVENT_TYPES,
  SECURITY_OUTCOMES,
  isSecurityEventType,
  isSecurityOutcome,
} from "./security-event-types";
import {
  generateEventTypeCheckClause,
  generateOutcomeCheckClause,
  quotedEventTypeList,
  quotedOutcomeList,
} from "./db-check";

describe("security event taxonomy invariants", () => {
  it("has no duplicate event types", () => {
    expect(new Set(SECURITY_EVENT_TYPES).size).toBe(SECURITY_EVENT_TYPES.length);
  });

  it("has no duplicate outcomes", () => {
    expect(new Set(SECURITY_OUTCOMES).size).toBe(SECURITY_OUTCOMES.length);
  });

  it("groups all values of a domain contiguously (no interleaving)", () => {
    // Each domain's entries must form one contiguous run, so the file stays
    // readable as grouped blocks even though within-group order is by lifecycle.
    const seen = new Set<string>();
    let currentDomain: string | null = null;
    for (const t of SECURITY_EVENT_TYPES) {
      const domain = t.split(".")[0]!;
      if (domain !== currentDomain) {
        expect(seen.has(domain)).toBe(false);
        seen.add(domain);
        currentDomain = domain;
      }
    }
  });

  it("uses the <domain>.<event> naming shape for every type", () => {
    for (const t of SECURITY_EVENT_TYPES) {
      expect(t).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe("type guards", () => {
  it("recognises known event types and rejects unknown ones", () => {
    expect(isSecurityEventType("auth.sign_in")).toBe(true);
    expect(isSecurityEventType("auth.telepathy")).toBe(false);
    expect(isSecurityEventType("")).toBe(false);
  });

  it("recognises known outcomes and rejects unknown ones", () => {
    expect(isSecurityOutcome("allow")).toBe(true);
    expect(isSecurityOutcome("maybe")).toBe(false);
  });
});

describe("db CHECK clause generation", () => {
  it("includes every event type, single-quoted", () => {
    const list = quotedEventTypeList();
    for (const t of SECURITY_EVENT_TYPES) {
      expect(list).toContain(`'${t}'`);
    }
  });

  it("includes every outcome, single-quoted", () => {
    const list = quotedOutcomeList();
    for (const o of SECURITY_OUTCOMES) {
      expect(list).toContain(`'${o}'`);
    }
  });

  it("builds a column-scoped IN expression for event types", () => {
    const clause = generateEventTypeCheckClause("event_type");
    expect(clause).toBe(`event_type IN (${quotedEventTypeList()})`);
    expect(clause.startsWith("event_type IN (")).toBe(true);
  });

  it("builds a column-scoped IN expression for outcomes", () => {
    expect(generateOutcomeCheckClause()).toBe(`outcome IN (${quotedOutcomeList()})`);
  });

  it("escapes embedded single quotes (injection-safety regression)", () => {
    // Drive the escape branch directly; our real constants never contain quotes.
    expect(quotedEventTypeList(["o'brien.test" as never])).toBe("'o''brien.test'");
  });
});
