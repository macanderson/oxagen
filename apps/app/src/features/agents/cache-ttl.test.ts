// cache-ttl.test.ts — which open finding's TTL recommendation the agent page
// shows: the newest one about the agent that names the cache TTL.
import { describe, expect, it } from "vitest";
import { cacheTtlOf } from "./cache-ttl";
import type { SpendFinding, SpendFindings } from "@/data/contracts/spend";

const AGENT = "acme.core.release-bot";

function listOf(findings: Partial<SpendFinding>[]): SpendFindings {
  return {
    window: null,
    saving: null,
    spend: null,
    share: null,
    annualised: null,
    counts: {
      findings: findings.length,
      high: findings.length,
      medium: 0,
      operators: 0,
    },
    findings: findings.map((finding) => ({
      id: "fnd_01",
      kind: "duplicate_tool_calls",
      level: "agent",
      subject: AGENT,
      saving: { micros: "2000000", currency: "USD", basis: "gateway_observed" },
      confidence: "high",
      window: {
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-15T00:00:00.000Z",
      },
      why: "The same read ran twice on eleven turns.",
      fix: "Cache the first result.",
      runs: 3,
      calls: 22,
      ...finding,
    })),
    truncated: false,
  };
}

function idle(
  id: string,
  to: string,
  recommendation: SpendFinding["recommendation"],
): Partial<SpendFinding> {
  return {
    id,
    kind: "idle_cache_rewrites",
    subject: AGENT,
    window: { from: "2026-09-01T00:00:00.000Z", to },
    recommendation,
  };
}

describe("cacheTtlOf", () => {
  it("takes the newest finding that names the cache TTL", () => {
    const list = listOf([
      idle("fnd_old", "2026-09-10T00:00:00.000Z", {
        setting: "cache_ttl",
        value: "1h",
        current: "5m",
      }),
      idle("fnd_new", "2026-09-20T00:00:00Z", {
        setting: "cache_ttl",
        value: "5m",
        current: "5m",
      }),
    ]);
    expect(cacheTtlOf(list, AGENT)).toEqual({
      findingId: "fnd_new",
      value: "5m",
      current: "5m",
    });
  });

  it("reads a missing current TTL as null", () => {
    const list = listOf([
      idle("fnd_01", "2026-09-10T00:00:00.000Z", {
        setting: "cache_ttl",
        value: "1h",
      }),
    ]);
    expect(cacheTtlOf(list, AGENT)).toEqual({
      findingId: "fnd_01",
      value: "1h",
      current: null,
    });
  });

  it("ignores findings about another subject or level, or with another setting (negative)", () => {
    const ttl = { setting: "cache_ttl", value: "1h" } as const;
    const list = listOf([
      { ...idle("fnd_other", "2026-09-10T00:00:00.000Z", ttl), subject: "acme.core.triage" },
      { ...idle("fnd_operator", "2026-09-10T00:00:00.000Z", ttl), level: "operator" },
      idle("fnd_model", "2026-09-10T00:00:00.000Z", {
        setting: "model",
        value: "claude-haiku-5",
      }),
      idle("fnd_bare", "2026-09-10T00:00:00.000Z", undefined),
    ]);
    expect(cacheTtlOf(list, AGENT)).toBeNull();
  });

  it("proposes nothing when the newest finding names a TTL the page does not know (negative)", () => {
    const list = listOf([
      idle("fnd_old", "2026-09-10T00:00:00.000Z", {
        setting: "cache_ttl",
        value: "1h",
      }),
      idle("fnd_new", "2026-09-20T00:00:00.000Z", {
        setting: "cache_ttl",
        value: "24h",
        current: "5m",
      }),
    ]);
    expect(cacheTtlOf(list, AGENT)).toBeNull();
  });

  it("reads a current TTL the page does not know as null", () => {
    const list = listOf([
      idle("fnd_01", "2026-09-10T00:00:00.000Z", {
        setting: "cache_ttl",
        value: "5m",
        current: 300,
      }),
    ]);
    expect(cacheTtlOf(list, AGENT)).toEqual({
      findingId: "fnd_01",
      value: "5m",
      current: null,
    });
  });

  it("finds nothing for an agent with no key (negative)", () => {
    const list = listOf([
      idle("fnd_01", "2026-09-10T00:00:00.000Z", {
        setting: "cache_ttl",
        value: "1h",
      }),
    ]);
    expect(cacheTtlOf(list, null)).toBeNull();
  });
});
