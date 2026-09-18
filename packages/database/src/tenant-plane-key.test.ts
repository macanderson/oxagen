import { describe, expect, it } from "vitest";
import { dedicatedPlaneKey } from "./tenant";

/**
 * The key a deploy-before-migrate probe files its answer under, for an
 * organisation on a dedicated plane (ADR-042).
 *
 * The stake is that a positive probe answer is kept for the life of the
 * process. A key that maps two different databases to one string hands the
 * migrated plane's `true` to a plane that has not been migrated, the
 * compatibility projection is dropped, and the guarded query raises the exact
 * 42703/42P01 the probe exists to prevent — until the process is recycled.
 */
describe("dedicatedPlaneKey", () => {
  const ORG_A = "11111111-1111-4111-8111-111111111111";
  const ORG_B = "22222222-2222-4222-8222-222222222222";

  it("shares one key between organisations on the same plane", () => {
    // The digest identifies the physical database, which is the thing a probe
    // answer is about. Two orgs there should probe once between them.
    expect(dedicatedPlaneKey(ORG_A, "abc123")).toBe(
      dedicatedPlaneKey(ORG_B, "abc123"),
    );
  });

  it("keeps two planes apart", () => {
    expect(dedicatedPlaneKey(ORG_A, "abc123")).not.toBe(
      dedicatedPlaneKey(ORG_A, "def456"),
    );
  });

  it("keeps null-digest organisations apart", () => {
    // `configDigest` is `string | null` and the resolver returns null for a
    // binding written without one, so this is reachable, not hypothetical.
    // Keyed on the digest alone both of these are `dedicated:null` — one
    // answer for two unrelated databases.
    expect(dedicatedPlaneKey(ORG_A, null)).not.toBe(
      dedicatedPlaneKey(ORG_B, null),
    );
    expect(dedicatedPlaneKey(ORG_A, undefined)).not.toBe(
      dedicatedPlaneKey(ORG_B, undefined),
    );
  });

  it("never collides with the shared plane", () => {
    // `shared` is the platform singleton's key. A dedicated plane whose digest
    // happened to be the string "shared" would otherwise be told what the
    // shared database answered.
    expect(dedicatedPlaneKey(ORG_A, "shared")).not.toBe("shared");
    expect(dedicatedPlaneKey(ORG_A, null)).not.toBe("shared");
  });
});
