/**
 * The workspace's steering records, compiled into the bundle's
 * `context.system` (ADR-091). The text is part of the bundle etag, so it has
 * to be deterministic, and the host rejects the whole bundle past 16,384
 * characters, so it has to stay under that.
 */
import { describe, expect, it } from "vitest";
import { policyBundleSchema } from "@oxagen/oxagen/tacho/schemas";
import {
  CONTEXT_SYSTEM_MAX_CHARS,
  compileSteering,
  readWorkspaceSteering,
  type SteeringRecord,
} from "./tacho-steering";
import { unsignedBundle } from "./tacho-host";

function rec(overrides: Partial<SteeringRecord>): SteeringRecord {
  return {
    slug: "a-record",
    kind: "rule",
    force: "must",
    constraintEffect: null,
    statement: "Run the narrowest test that proves the change.",
    ...overrides,
  };
}

describe("compileSteering", () => {
  it("answers null when nothing steers, so a workspace without records gets the bundle it had before", () => {
    expect(compileSteering([])).toBeNull();
    expect(
      compileSteering([
        rec({ force: "may" }),
        rec({ force: "info" }),
        rec({ force: null }),
        rec({ statement: null }),
        rec({ statement: "   " }),
      ]),
    ).toBeNull();
  });

  it("prints MUST before SHOULD, each sorted by slug, whatever order the rows arrive in", () => {
    const rows = [
      rec({ slug: "b-should", force: "should", statement: "Prefer B." }),
      rec({ slug: "z-must", statement: "Always Z." }),
      rec({
        slug: "a-must",
        kind: "constraint",
        constraintEffect: "forbid",
        statement: "Never A.",
      }),
      rec({ slug: "a-should", force: "should", statement: "Prefer A." }),
    ];
    const text = compileSteering(rows)!;
    expect(text.split("\n").slice(1)).toEqual([
      "",
      "MUST",
      "- Never A. (constraint, forbid; a-must)",
      "- Always Z. (rule; z-must)",
      "",
      "SHOULD",
      "- Prefer A. (rule; a-should)",
      "- Prefer B. (rule; b-should)",
    ]);
    expect(compileSteering([...rows].reverse())).toBe(text);
  });

  it("leaves out whole records past the limit, SHOULD first, and says how many", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      rec({
        slug: `r-${String(i).padStart(2, "0")}`,
        force: i < 5 ? "must" : "should",
        statement: `Statement ${i} ${"x".repeat(80)}.`,
      }),
    );
    const text = compileSteering(rows, 1_000)!;
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain("(rule; r-00)");
    expect(text).toContain("(rule; r-04)");
    const kept = text.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(text).toMatch(new RegExp(`${40 - kept} more records were left out`));
    expect(text).not.toContain("r-39");
  });

  it("names a single omitted record in the singular", () => {
    const rows = [
      rec({ slug: "a", statement: "x".repeat(300) }),
      rec({ slug: "b", statement: "y".repeat(300) }),
    ];
    const text = compileSteering(rows, 600)!;
    expect(text).toContain("1 more record was left out");
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it("stays inside the host's limit at the default", () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      rec({ slug: `r-${i}`, statement: "s".repeat(200) }),
    );
    expect(compileSteering(rows)!.length).toBeLessThanOrEqual(
      CONTEXT_SYSTEM_MAX_CHARS,
    );
  });
});

describe("readWorkspaceSteering", () => {
  it("compiles what the registry answers", async () => {
    let asked: unknown;
    const text = await readWorkspaceSteering(
      {
        query: {
          contextRecords: {
            findMany: async (args) => {
              asked = args;
              return [rec({ statement: "Ask before deleting data." })];
            },
          },
        },
      },
      "org",
      "ws",
    );
    expect(text).toContain("- Ask before deleting data. (rule; a-record)");
    expect(asked).toMatchObject({
      columns: { slug: true, force: true, statement: true },
    });
  });
});

describe("the bundle", () => {
  const host = {
    publicId: "tch_0123456789abcdefghjkmn",
    status: "active",
    mode: "observe",
    bundleVersionServed: 1,
    bundleFeatures: [],
  } as unknown as Parameters<typeof unsignedBundle>[0];
  const retention = { mode: "digest_only" as const, classes: [] };

  it("carries the compiled text in context.system, parses on the host, and moves the etag", () => {
    const system = compileSteering([rec({})]);
    const steered = unsignedBundle(
      host,
      { org: 0, workspace: 0 },
      retention,
      system,
    );
    const plain = unsignedBundle(
      host,
      { org: 0, workspace: 0 },
      retention,
      null,
    );
    expect(steered.context.system).toBe(system);
    expect(plain.context.system).toBeNull();
    expect(steered.etag).not.toBe(plain.etag);
    const sig = { key_id: "k", alg: "ed25519" as const, sig: "s" };
    expect(
      policyBundleSchema.safeParse({ ...steered, signature: sig }).success,
    ).toBe(true);
  });
});
