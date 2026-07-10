import { describe, it, expect } from "vitest";
import { matchEntityPrefix } from "./entity-prefix";

describe("matchEntityPrefix", () => {
  // ── run ────────────────────────────────────────────────────────────────────
  it("matches 'run aex_abc' → kind=run, remainder='aex_abc'", () => {
    const result = matchEntityPrefix("run aex_abc");
    expect(result).toEqual({ kind: "run", queryRemainder: "aex_abc" });
  });

  it("matches 'run_aex_abc' → kind=run, remainder='aex_abc'", () => {
    const result = matchEntityPrefix("run_aex_abc");
    expect(result).toEqual({ kind: "run", queryRemainder: "aex_abc" });
  });

  it("matches 'run #4221' → kind=run, remainder='4221'", () => {
    const result = matchEntityPrefix("run #4221");
    expect(result).toEqual({ kind: "run", queryRemainder: "4221" });
  });

  it("matches 'RUN 123' case-insensitively → kind=run", () => {
    const result = matchEntityPrefix("RUN 123");
    expect(result?.kind).toBe("run");
  });

  // ── principal ──────────────────────────────────────────────────────────────
  it("matches '@alice@example.com' → kind=principal, remainder='alice@example.com'", () => {
    const result = matchEntityPrefix("@alice@example.com");
    expect(result).toEqual({
      kind: "principal",
      queryRemainder: "alice@example.com",
    });
  });

  it("matches '@' alone → kind=principal, remainder=''", () => {
    const result = matchEntityPrefix("@");
    expect(result).toEqual({ kind: "principal", queryRemainder: "" });
  });

  // ── playbook ───────────────────────────────────────────────────────────────
  it("matches 'playbook churn-investigate' → kind=playbook", () => {
    const result = matchEntityPrefix("playbook churn-investigate");
    expect(result).toEqual({
      kind: "playbook",
      queryRemainder: "churn-investigate",
    });
  });

  it("matches 'pb_abc-123' → kind=playbook, remainder='abc-123'", () => {
    const result = matchEntityPrefix("pb_abc-123");
    expect(result).toEqual({ kind: "playbook", queryRemainder: "abc-123" });
  });

  it("matches 'PLAYBOOK foo' case-insensitively", () => {
    expect(matchEntityPrefix("PLAYBOOK foo")?.kind).toBe("playbook");
  });

  // ── trigger ────────────────────────────────────────────────────────────────
  it("matches 'trigger daily-sync' → kind=trigger", () => {
    const result = matchEntityPrefix("trigger daily-sync");
    expect(result).toEqual({ kind: "trigger", queryRemainder: "daily-sync" });
  });

  it("matches 'tg_daily-sync' → kind=trigger, remainder='daily-sync'", () => {
    const result = matchEntityPrefix("tg_daily-sync");
    expect(result).toEqual({ kind: "trigger", queryRemainder: "daily-sync" });
  });

  // ── event ──────────────────────────────────────────────────────────────────
  it("matches 'event order-placed' → kind=event", () => {
    const result = matchEntityPrefix("event order-placed");
    expect(result).toEqual({ kind: "event", queryRemainder: "order-placed" });
  });

  it("matches 'EVENT foo' case-insensitively", () => {
    expect(matchEntityPrefix("EVENT foo")?.kind).toBe("event");
  });

  // ── agent ──────────────────────────────────────────────────────────────────
  it("matches 'agent my-bot' → kind=agent", () => {
    const result = matchEntityPrefix("agent my-bot");
    expect(result).toEqual({ kind: "agent", queryRemainder: "my-bot" });
  });

  it("matches 'ag_my-bot' → kind=agent, remainder='my-bot'", () => {
    const result = matchEntityPrefix("ag_my-bot");
    expect(result).toEqual({ kind: "agent", queryRemainder: "my-bot" });
  });

  // ── no match ───────────────────────────────────────────────────────────────
  it("returns null for plain text with no entity prefix", () => {
    expect(matchEntityPrefix("why did this fail?")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(matchEntityPrefix("")).toBeNull();
  });

  it("returns null for a near-miss like 'running-...'", () => {
    expect(matchEntityPrefix("running-pipeline")).toBeNull();
  });

  it("returns null for 'playground foo' (not a known prefix)", () => {
    expect(matchEntityPrefix("playground foo")).toBeNull();
  });

  // ── leading whitespace ─────────────────────────────────────────────────────
  it("handles leading whitespace and still matches", () => {
    const result = matchEntityPrefix("  run abc");
    expect(result?.kind).toBe("run");
    expect(result?.queryRemainder).toBe("abc");
  });
});
