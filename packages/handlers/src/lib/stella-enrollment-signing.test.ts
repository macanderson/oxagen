/**
 * The cross-language tie: this TypeScript signer must produce the same bytes
 * as stella's `canonical_enrollment_bytes` + HMAC.
 *
 * The fixture is vendored byte-for-byte from
 * `crates/stella-cli/src/enterprise_telemetry/fixtures/`, where a Rust test
 * pins the same file. If either encoding drifts, one of the two tests goes red
 * and names the other tree — which is the whole point of a conformance vector
 * rather than two implementations that merely look alike.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalEnrollmentBytes,
  ENROLLMENT_SIGNATURE_DOMAIN,
  signEnrollmentClaims,
  type StellaEnrollmentClaims,
} from "./stella-enrollment-signing";

const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "fixtures/stella-enrollment-signature-conformance.v1.json",
    ),
    "utf8",
  ),
) as {
  secret_utf8: string;
  claims: StellaEnrollmentClaims;
  signature_hex: string;
};

describe("stella enrollment signing — conformance with the Rust implementation", () => {
  it("reproduces the pinned signature exactly", () => {
    expect(signEnrollmentClaims(fixture.claims, fixture.secret_utf8)).toBe(
      fixture.signature_hex,
    );
  });

  it("starts the canonical bytes with the domain separator, unframed", () => {
    // The domain is a bare prefix, not a length-framed field — stella writes it
    // with `to_vec()` before the first `frame()` call.
    const bytes = canonicalEnrollmentBytes(fixture.claims);
    expect(
      bytes.subarray(0, ENROLLMENT_SIGNATURE_DOMAIN.length).toString("utf8"),
    ).toBe(ENROLLMENT_SIGNATURE_DOMAIN);
  });

  it("changes the signature when any single claim changes", () => {
    // Each of these is a field the framing covers; a signer that dropped one
    // would still match the vector above but forge here.
    const base = signEnrollmentClaims(fixture.claims, fixture.secret_utf8);
    const mutations: Partial<StellaEnrollmentClaims>[] = [
      { enrollment_id: "sten_other0000000001" },
      { organization_id: "org_other" },
      { workspace_id: "ws_other" },
      { endpoint: "https://api.oxagen.sh/v1/telemetry/stella/other" },
      { credential_env: "OTHER_TOKEN" },
      { issuer: "someone-else" },
      { audience: "someone-else" },
      { issued_at_unix_s: fixture.claims.issued_at_unix_s + 1 },
      { expires_at_unix_s: fixture.claims.expires_at_unix_s + 1 },
      { event_classes: ["compliance_audit"] },
      { model_catalog: [{ provider: "anthropic", model: "other" }] },
    ];
    for (const mutation of mutations) {
      expect(
        signEnrollmentClaims(
          { ...fixture.claims, ...mutation },
          fixture.secret_utf8,
        ),
        `mutating ${Object.keys(mutation)[0]} must move the signature`,
      ).not.toBe(base);
    }
  });

  it("is length-framed, so field boundaries cannot be shifted", () => {
    // Without length framing, moving a character from one adjacent field to
    // the next would leave the concatenation — and the signature — unchanged.
    const a = signEnrollmentClaims(
      { ...fixture.claims, issuer: "ab", audience: "cd" },
      fixture.secret_utf8,
    );
    const b = signEnrollmentClaims(
      { ...fixture.claims, issuer: "a", audience: "bcd" },
      fixture.secret_utf8,
    );
    expect(a).not.toBe(b);
  });

  it("a different secret yields a different signature", () => {
    expect(signEnrollmentClaims(fixture.claims, "another-secret")).not.toBe(
      fixture.signature_hex,
    );
  });
});
