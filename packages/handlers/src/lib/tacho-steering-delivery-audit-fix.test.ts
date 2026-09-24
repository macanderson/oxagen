/**
 * The steering prefix has to reach the agent whole, and the manifest signed
 * beside it has to parse on the host. Claude Code keeps 10,000 characters of
 * a hook's `additionalContext`, so the prefix is held to 8,000 and leaves the
 * collector room under its 9,500-character total; the host parses the
 * manifest with at most 2,000 items, so a workspace with more candidates
 * than that gets its oldest cut items dropped from the list.
 */
import { describe, expect, it } from "vitest";
import { steeringManifestSchema } from "@oxagen/tacho";
import {
  assembleSteering,
  PREFIX_BUDGET_TOKENS,
} from "@oxagen/steering-assembler";
import {
  CONTEXT_SYSTEM_BUDGET_TOKENS,
  STEERING_MANIFEST_MAX_ITEMS,
  assembleWorkspaceSteering,
  capManifestItems,
  recordCandidate,
  type SteeringRecord,
} from "./tacho-steering";

function rec(overrides: Partial<SteeringRecord>): SteeringRecord {
  return {
    slug: "a-record",
    kind: "rule",
    force: "must",
    constraintEffect: null,
    statement: "Run the narrowest test that proves the change.",
    activatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

/** An instant `i` minutes after a fixed start, so a higher `i` is newer. */
const at = (i: number) =>
  new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();

describe("the delivered steering prefix", () => {
  it("stays under 8,000 characters however many records compete", () => {
    // The bundle's steering spends the assembler's prefix budget.
    expect(CONTEXT_SYSTEM_BUDGET_TOKENS).toBe(PREFIX_BUDGET_TOKENS);
    expect(CONTEXT_SYSTEM_BUDGET_TOKENS).toBe(2_000);
    const rows = Array.from({ length: 500 }, (_, i) =>
      rec({ slug: `r-${i}`, statement: "s".repeat(200) }),
    );
    const { text, manifest } = assembleWorkspaceSteering("org", "ws", rows);
    expect(text!.length).toBeLessThanOrEqual(8_000);
    expect(manifest.budget_tokens).toBe(2_000);
    expect(manifest.spent_tokens).toBeLessThanOrEqual(2_000);
    // Room is left under the collector's 9,500-character hook total.
    expect(text!.length).toBeLessThan(9_500);
  });

  it("keeps multibyte text under the limit too", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      rec({ slug: `r-${i}`, statement: "é".repeat(150) }),
    );
    const { text } = assembleWorkspaceSteering("org", "ws", rows);
    expect(text!.length).toBeLessThanOrEqual(8_000);
    expect(new TextEncoder().encode(text!).length).toBeLessThanOrEqual(8_000);
  });
});

describe("the manifest item cap", () => {
  // Every `may` record is a candidate the manifest accounts for, cut for its
  // tier, so a workspace with thousands of them overflowed the list.
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      rec({ slug: `may-${i}`, force: "may", activatedAt: at(i) }),
    );

  it("lists at most 1,900 items, which the host's strict parse accepts", () => {
    const rows = [
      rec({ slug: "must-old", force: "must", activatedAt: at(-10) }),
      ...many(2_500),
    ];
    const { manifest } = assembleWorkspaceSteering("org", "ws", rows);
    expect(STEERING_MANIFEST_MAX_ITEMS).toBe(1_900);
    expect(manifest.items).toHaveLength(1_900);
    expect(() => steeringManifestSchema.parse(manifest)).not.toThrow();
    // The assembler's own list for the same set fails the host's parse.
    const uncapped = assembleSteering(
      {
        orgId: "org",
        workspaceId: "ws",
        candidates: rows.map((r) => recordCandidate(r)!),
      },
      CONTEXT_SYSTEM_BUDGET_TOKENS,
    );
    expect(uncapped.manifest.items).toHaveLength(2_501);
    expect(steeringManifestSchema.safeParse(uncapped.manifest).success).toBe(
      false,
    );
  });

  it("keeps every included item, drops the oldest cut items, and keeps the counts", () => {
    const rows = [
      rec({ slug: "must-oldest", force: "must", activatedAt: at(-100) }),
      ...many(2_100),
    ];
    const { manifest } = assembleWorkspaceSteering("org", "ws", rows);
    const included = manifest.items.filter((i) => i.outcome === "included");
    expect(included.map((i) => i.id)).toEqual(["must-oldest"]);
    const kept = new Set(manifest.items.map((i) => i.id));
    // 2,101 candidates, 1,900 listed: the 201 oldest `may` records go.
    for (let i = 0; i < 201; i++) expect(kept.has(`may-${i}`)).toBe(false);
    for (let i = 201; i < 2_100; i++) expect(kept.has(`may-${i}`)).toBe(true);
    // The counts still describe every candidate; the difference is what the
    // list leaves out.
    expect(manifest.included).toBe(1);
    expect(manifest.cut).toBe(2_100);
    expect(
      manifest.cut - manifest.items.filter((i) => i.outcome === "cut").length,
    ).toBe(201);
  });

  it("keeps the rank order of what it lists, and is deterministic", () => {
    const rows = many(2_000);
    const first = assembleWorkspaceSteering("org", "ws", rows).manifest;
    const again = assembleWorkspaceSteering(
      "org",
      "ws",
      [...rows].reverse(),
    ).manifest;
    expect(again).toEqual(first);
    // Newest first within the tier, as the assembler ranked them.
    expect(first.items[0]?.id).toBe("may-1999");
    expect(first.items.at(-1)?.id).toBe("may-100");
  });

  it("drops the lower-ranked of two cut items recorded at the same instant first", () => {
    const manifest = {
      ...assembleWorkspaceSteering("org", "ws", [
        rec({ slug: "b", force: "may", activatedAt: at(0) }),
        rec({ slug: "a", force: "may", activatedAt: at(0) }),
        rec({ slug: "c", force: "may", activatedAt: at(1) }),
      ]).manifest,
    };
    expect(manifest.items.map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(capManifestItems(manifest, 2).items.map((i) => i.id)).toEqual([
      "c",
      "a",
    ]);
  });

  it("leaves a manifest under the cap untouched", () => {
    const { manifest } = assembleWorkspaceSteering("org", "ws", many(3));
    expect(capManifestItems(manifest)).toBe(manifest);
  });
});
