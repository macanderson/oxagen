import { describe, expect, it } from "vitest";
import {
  countTokens,
  MEMORY_RECALL_MAX,
  MEMORY_RECALL_TOKENS_MAX,
} from "@oxagen/oxagen/steering-repo/tokens";
import { RECALL_HALF_LIFE_DAYS, rankRecall } from "./recall";
import type { RecallCandidate, RecallRequest } from "./types";

const NOW = new Date("2026-09-26T12:00:00Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** Its words are fix, billing, refund, and test. */
function request(overrides: Partial<RecallRequest> = {}): RecallRequest {
  return {
    now: NOW,
    agent: "claude-code",
    inApp: false,
    repository: "github.com/acme/api",
    tools: ["billing__create_refund"],
    paths: ["src/billing/refund.ts"],
    text: "Fix the billing refund tests",
    recallUnreviewed: "same-agent",
    ...overrides,
  };
}

function record(
  id: string,
  statement = "Billing refunds",
  overrides: Partial<RecallCandidate> = {},
): RecallCandidate {
  return {
    id,
    source: "record",
    agent: null,
    statement,
    repos: null,
    appliesTo: null,
    tools: null,
    since: NOW,
    ...overrides,
  };
}

function memory(
  id: string,
  agent: string | null,
  overrides: Partial<RecallCandidate> = {},
): RecallCandidate {
  return { ...record(id), source: "memory", agent, ...overrides };
}

function ids(items: Array<{ id: string }>): string[] {
  return items.map((item) => item.id);
}

describe("rankRecall", () => {
  it("answers the in-app agent with nothing", () => {
    expect(rankRecall(request({ inApp: true }), [record("r1")])).toEqual([]);
  });

  it("returns each item's id, source, statement, score, and tokens", () => {
    expect(rankRecall(request(), [record("r1")])).toEqual([
      {
        id: "r1",
        source: "record",
        statement: "Billing refunds",
        score: 1,
        tokens: countTokens("Billing refunds"),
      },
    ]);
  });

  describe("unreviewed memories", () => {
    it("reach the agent that wrote them while recall_unreviewed is same-agent", () => {
      expect(ids(rankRecall(request(), [memory("mem_1", "claude-code")]))).toEqual([
        "mem_1",
      ]);
    });

    it("never reach another agent", () => {
      expect(rankRecall(request(), [memory("mem_1", "codex")])).toEqual([]);
    });

    it("never reach anyone when their agent is null", () => {
      expect(rankRecall(request({ agent: null }), [memory("mem_1", null)])).toEqual(
        [],
      );
      expect(rankRecall(request(), [memory("mem_1", null)])).toEqual([]);
    });

    it("reach no one while recall_unreviewed is off, and records still reach", () => {
      const items = rankRecall(request({ recallUnreviewed: "off" }), [
        memory("mem_1", "claude-code"),
        record("r1"),
      ]);
      expect(ids(items)).toEqual(["r1"]);
    });
  });

  describe("scope", () => {
    it("keeps a candidate with repos to a request in one of them", () => {
      const items = rankRecall(request(), [
        record("api", undefined, { repos: ["github.com/acme/api"] }),
        record("web", undefined, { repos: ["github.com/acme/web"] }),
        record("empty", undefined, { repos: [] }),
      ]);
      expect(ids(items)).toEqual(["api", "empty"]);
      expect(
        rankRecall(request({ repository: null }), [
          record("api", undefined, { repos: ["github.com/acme/api"] }),
        ]),
      ).toEqual([]);
    });

    it("keeps a candidate with tools to a request whose toolbelt matches one", () => {
      const items = rankRecall(request(), [
        record("server", undefined, { tools: ["billing__*"] }),
        record("exact", undefined, { tools: ["billing__create_refund"] }),
        record("other", undefined, { tools: ["github__create_issue"] }),
      ]);
      expect(ids(items)).toEqual(["exact", "server"]);
    });

    it("keeps a candidate with applies_to to a request that names a matching path", () => {
      const items = rankRecall(request(), [
        record("billing", undefined, { appliesTo: ["src/billing/**"] }),
        record("docs", undefined, { appliesTo: ["docs/**"] }),
      ]);
      expect(ids(items)).toEqual(["billing"]);
      expect(
        rankRecall(request({ paths: [] }), [
          record("billing", undefined, { appliesTo: ["src/billing/**"] }),
        ]),
      ).toEqual([]);
    });
  });

  describe("score", () => {
    it("is the share of the candidate's words the request holds", () => {
      const [item] = rankRecall(request(), [
        record("r1", "Billing refunds need an idempotency key"),
      ]);
      // billing and refund of billing, refund, need, idempotency, and key.
      expect(item?.score).toBe(2 / 5);
    });

    it("halves every 30 days", () => {
      expect(RECALL_HALF_LIFE_DAYS).toBe(30);
      const items = rankRecall(request(), [
        record("old", undefined, { since: daysAgo(30) }),
        record("new"),
      ]);
      const [fresh, aged] = items;
      expect(ids(items)).toEqual(["new", "old"]);
      expect(aged?.score).toBe((fresh?.score ?? 0) / 2);
    });

    it("halves on the request's own half-life when it sets one", () => {
      const [item] = rankRecall(request({ halfLifeDays: 10 }), [
        record("old", undefined, { since: daysAgo(30) }),
      ]);
      expect(item?.score).toBe(1 / 8);
    });

    it("never ages a candidate dated after the request", () => {
      const [item] = rankRecall(request(), [
        record("future", undefined, { since: daysAgo(-3) }),
      ]);
      expect(item?.score).toBe(1);
    });

    it("leaves out a candidate with no shared words, or with no words at all", () => {
      expect(
        rankRecall(request(), [
          record("none", "Rotate the signing keys"),
          record("empty", "Do it."),
        ]),
      ).toEqual([]);
    });
  });

  describe("order", () => {
    it("puts the higher score first", () => {
      const items = rankRecall(request(), [
        record("a-partial", "Billing refunds need an idempotency key"),
        record("b-older", undefined, { since: daysAgo(1) }),
        record("c"),
      ]);
      expect(ids(items)).toEqual(["c", "b-older", "a-partial"]);
    });

    it("breaks a score tie by the newer candidate", () => {
      // An infinite half-life weighs every age at 1, so only age breaks the tie.
      const items = rankRecall(request({ halfLifeDays: Infinity }), [
        record("a-older", undefined, { since: daysAgo(5) }),
        record("b-newer", undefined, { since: daysAgo(1) }),
      ]);
      expect(ids(items)).toEqual(["b-newer", "a-older"]);
      expect(items[0]?.score).toBe(items[1]?.score);
    });

    it("orders equal candidates by id whatever order they arrive in", () => {
      expect(ids(rankRecall(request(), [record("b"), record("a")]))).toEqual([
        "a",
        "b",
      ]);
      expect(ids(rankRecall(request(), [record("a"), record("b")]))).toEqual([
        "a",
        "b",
      ]);
    });
  });

  describe("limits", () => {
    it("answers at most 5 items", () => {
      const candidates = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((id) =>
        record(id),
      );
      const items = rankRecall(request(), candidates);
      expect(MEMORY_RECALL_MAX).toBe(5);
      expect(ids(items)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    });

    it("skips an item that would pass 800 tokens and keeps a shorter one that fits", () => {
      const long = `Billing refunds ${"a".repeat(2980)}`;
      const longTokens = countTokens(long);
      expect(longTokens * 2).toBeGreaterThan(MEMORY_RECALL_TOKENS_MAX);
      expect(longTokens).toBeLessThan(MEMORY_RECALL_TOKENS_MAX);

      const items = rankRecall(request(), [
        record("long-1", long),
        record("long-2", long, { since: daysAgo(1) }),
        record("short", "Billing fixtures"),
      ]);
      expect(ids(items)).toEqual(["long-1", "short"]);
      const total = items.reduce((sum, item) => sum + item.tokens, 0);
      expect(total).toBeLessThanOrEqual(MEMORY_RECALL_TOKENS_MAX);
    });
  });
});
