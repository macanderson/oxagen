import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";
import { describe, expect, it } from "vitest";
import {
  assembleSteering,
  compareCandidates,
  STEERING_HEADER,
  type SteeringCandidate,
  type SteeringManifestItem,
} from "./assemble";

const run = (candidates: SteeringCandidate[], delivers?: string[]) => ({
  orgId: "org",
  workspaceId: "ws",
  runId: "run_1",
  candidates,
  ...(delivers ? { delivers: delivers as SteeringCandidate["force"][] } : {}),
});

function record(overrides: Partial<SteeringCandidate>): SteeringCandidate {
  return {
    id: "a-record",
    kind: "record",
    force: "must",
    body: "Run the narrowest test that proves the change. (rule; a-record)",
    recordedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A candidate set with a fixed pseudo-random shuffle, so a test can prove order independence. */
function shuffled<T>(items: T[], seed = 7): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const byOutcome = (items: SteeringManifestItem[], outcome: string) =>
  items.filter((i) => i.outcome === outcome);

describe("assembleSteering", () => {
  it("answers null text and an empty manifest for a workspace with nothing to say", () => {
    const { text, manifest } = assembleSteering(run([]), 4096);
    expect(text).toBeNull();
    expect(manifest).toMatchObject({
      schema: "oxagen.steering.manifest/1",
      delivers: ["must", "should"],
      budget_tokens: 4096,
      spent_tokens: 0,
      included: 0,
      cut: 0,
      text_digest: null,
      items: [],
    });
  });

  it("prints MUST before SHOULD, newest first within a tier, whatever order the candidates arrive in", () => {
    const candidates = [
      record({
        id: "b-should",
        force: "should",
        body: "Prefer B. (rule; b-should)",
        recordedAt: "2026-09-02T00:00:00Z",
      }),
      record({
        id: "z-must",
        body: "Always Z. (rule; z-must)",
        recordedAt: "2026-09-01T00:00:00Z",
      }),
      record({
        id: "a-must",
        body: "Never A. (constraint, forbid; a-must)",
        recordedAt: "2026-09-03T00:00:00Z",
      }),
      record({
        id: "a-should",
        force: "should",
        body: "Prefer A. (rule; a-should)",
        recordedAt: "2026-09-02T00:00:00Z",
      }),
      {
        id: "cmd_1",
        kind: "steer" as const,
        force: "must" as const,
        body: "Stop after the migration lands. (operator steer; cmd_1)",
        recordedAt: "2026-09-04T00:00:00Z",
      },
    ];
    const { text, manifest } = assembleSteering(run(candidates), 4096);
    expect(text!.split("\n")).toEqual([
      STEERING_HEADER,
      "",
      "MUST",
      "- Stop after the migration lands. (operator steer; cmd_1)",
      "- Never A. (constraint, forbid; a-must)",
      "- Always Z. (rule; z-must)",
      "",
      "SHOULD",
      "- Prefer A. (rule; a-should)",
      "- Prefer B. (rule; b-should)",
    ]);
    expect(manifest.items.map((i) => i.id)).toEqual([
      "cmd_1",
      "a-must",
      "z-must",
      "a-should",
      "b-should",
    ]);
    expect(manifest.included).toBe(5);
    expect(manifest.cut).toBe(0);
    expect(manifest.text_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.spent_tokens).toBe(budgetTokens(text!));

    const again = assembleSteering(run(shuffled(candidates)), 4096);
    expect(again).toEqual({ text, manifest });
  });

  it("cuts may and info for the prefix and names the tier as the reason", () => {
    const { text, manifest } = assembleSteering(
      run([
        record({ id: "m", force: "may", body: "Maybe M. (fact; m)" }),
        record({ id: "i", force: "info", body: "Info I. (fact; i)" }),
        record({ id: "s", force: "should", body: "Prefer S. (rule; s)" }),
      ]),
      4096,
    );
    expect(text).toContain("- Prefer S.");
    expect(text).not.toContain("Maybe M.");
    expect(byOutcome(manifest.items, "cut")).toEqual([
      expect.objectContaining({ id: "m", reason: "tier" }),
      expect.objectContaining({ id: "i", reason: "tier" }),
    ]);
    expect(manifest.included).toBe(1);
    expect(manifest.cut).toBe(2);
  });

  it("delivers may and info when the injection point asks for them", () => {
    const { text, manifest } = assembleSteering(
      run(
        [
          record({ id: "m", force: "may", body: "Maybe M. (fact; m)" }),
          record({ id: "i", force: "info", body: "Info I. (fact; i)" }),
        ],
        ["must", "should", "may", "info"],
      ),
      4096,
    );
    expect(text!.split("\n").slice(1)).toEqual([
      "",
      "MAY",
      "- Maybe M. (fact; m)",
      "",
      "INFO",
      "- Info I. (fact; i)",
    ]);
    expect(manifest.cut).toBe(0);
  });

  it("keeps only the newest version of a lineage and names the winner", () => {
    const { text, manifest } = assembleSteering(
      run([
        record({
          id: "no-force-push@1",
          lineage: "no-force-push",
          body: "Never force-push. (constraint, forbid; no-force-push)",
          recordedAt: "2026-09-01T00:00:00Z",
        }),
        record({
          id: "no-force-push@2",
          lineage: "no-force-push",
          body: "Never force-push to main. (constraint, forbid; no-force-push)",
          recordedAt: "2026-09-05T00:00:00Z",
        }),
        // Two candidates with one id are one thing too.
        record({
          id: "dup",
          body: "Old dup.",
          recordedAt: "2026-09-01T00:00:00Z",
        }),
        record({
          id: "dup",
          body: "New dup.",
          recordedAt: "2026-09-02T00:00:00Z",
        }),
      ]),
      4096,
    );
    expect(text).toContain("Never force-push to main.");
    expect(text).not.toContain("- Never force-push. ");
    expect(text).toContain("New dup.");
    expect(text).not.toContain("Old dup.");
    expect(byOutcome(manifest.items, "cut")).toEqual([
      expect.objectContaining({
        id: "no-force-push@1",
        reason: "superseded",
        superseded_by: "no-force-push@2",
      }),
      expect.objectContaining({
        id: "dup",
        reason: "superseded",
        superseded_by: "dup",
      }),
    ]);
  });

  it("names budget as the reason for every cut when a workspace holds more must records than the budget, and includes the same set twice", () => {
    const candidates = Array.from({ length: 60 }, (_, i) =>
      record({
        id: `r-${String(i).padStart(2, "0")}`,
        body: `Statement ${i} ${"x".repeat(60)}. (rule; r-${i})`,
        recordedAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const budget = 400;
    const first = assembleSteering(run(candidates), budget);
    const second = assembleSteering(run(shuffled(candidates, 3)), budget);

    expect(first.text).not.toBeNull();
    expect(budgetTokens(first.text!)).toBeLessThanOrEqual(budget);
    expect(first.manifest.spent_tokens).toBeLessThanOrEqual(budget);
    expect(first.manifest.included).toBeGreaterThan(0);
    expect(first.manifest.cut).toBeGreaterThan(0);
    expect(first.manifest.included + first.manifest.cut).toBe(60);
    for (const item of byOutcome(first.manifest.items, "cut")) {
      expect(item.reason).toBe("budget");
    }
    expect(first.text).toMatch(
      new RegExp(`\n\n${first.manifest.cut} more records were left out`),
    );
    // The included set, and the text, are the same whatever order the rows
    // arrived in.
    expect(second).toEqual(first);
    const includedIds = byOutcome(first.manifest.items, "included").map(
      (i) => i.id,
    );
    expect(includedIds).toEqual(
      byOutcome(second.manifest.items, "included").map((i) => i.id),
    );
    // Newest first: the 28th of the month ranks before the 1st.
    expect(includedIds[0]).toMatch(/r-(27|55)/);
  });

  it("skips an item that does not fit and keeps walking, so a long item near the top cannot empty the budget", () => {
    const { text, manifest } = assembleSteering(
      run([
        record({
          id: "long",
          body: `${"L".repeat(2000)} (rule; long)`,
          recordedAt: "2026-09-09T00:00:00Z",
        }),
        record({
          id: "short",
          body: "Short. (rule; short)",
          recordedAt: "2026-09-01T00:00:00Z",
        }),
      ]),
      200,
    );
    expect(text).toContain("- Short.");
    expect(text).toContain("1 more record was left out");
    expect(manifest.items).toEqual([
      expect.objectContaining({ id: "long", outcome: "cut", reason: "budget" }),
      expect.objectContaining({ id: "short", outcome: "included" }),
    ]);
  });

  it("answers null text when nothing fits, and the manifest still names every cut", () => {
    const { text, manifest } = assembleSteering(
      run([record({ id: "a", body: "A".repeat(400) })]),
      50,
    );
    expect(text).toBeNull();
    expect(manifest).toMatchObject({
      included: 0,
      cut: 1,
      spent_tokens: 0,
      text_digest: null,
    });
    expect(manifest.items[0]).toMatchObject({ id: "a", reason: "budget" });
  });

  it("stays inside the host's 16 KiB character limit at a 4096-token budget", () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      record({ id: `r-${i}`, body: `${"s".repeat(200)} (rule; r-${i})` }),
    );
    const { text } = assembleSteering(run(candidates), 4096);
    expect(text!.length).toBeLessThanOrEqual(16_384);
  });

  it("ranks an unparseable instant as the oldest, and breaks a tie on id then kind", () => {
    const a = record({ id: "a", recordedAt: "not a date" });
    const b = record({ id: "b", recordedAt: "2026-09-01T00:00:00Z" });
    expect(compareCandidates(a, b)).toBeGreaterThan(0);
    expect(compareCandidates(b, a)).toBeLessThan(0);
    const c = record({ id: "a", kind: "steer" });
    expect(compareCandidates(record({ id: "a" }), c)).toBeLessThan(0);
    expect(compareCandidates(c, record({ id: "a" }))).toBeGreaterThan(0);
    expect(compareCandidates(a, a)).toBe(0);
  });
});
