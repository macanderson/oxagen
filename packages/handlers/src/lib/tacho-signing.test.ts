import { generateKeyPairSync } from "node:crypto";
import type {
  EnrollmentClaims,
  PolicyBundle,
} from "@oxagen/oxagen/tacho/schemas";
import { describe, expect, it } from "vitest";
import {
  bundleSignerFromEnv,
  bundleSignerFromPem,
  keyIdFor,
  verifyBundle,
} from "./tacho-bundle-signing";
import {
  TACHO_ENROLLMENT_SIGNATURE_DOMAIN,
  canonicalTachoEnrollmentBytes,
  signTachoEnrollment,
} from "./tacho-enrollment-signing";
import {
  requestsReservedTachoPurpose,
  tachoHostApiKeyScopeSchema,
} from "./tacho-enrollment";

const CLAIMS: EnrollmentClaims = {
  schema: "oxagen.tacho.host-enrollment.v1",
  issuer: "oxagen",
  audience: "tacho-collector",
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  organization_id: "00000000-0000-0000-0000-000000000001",
  workspace_id: "00000000-0000-0000-0000-000000000002",
  agent_key: "acme.core.cc-laptop",
  ingest_endpoint: "https://api.oxagen.sh/v1/tacho/events",
  bundle_endpoint: "https://api.oxagen.sh/v1/tacho/bundle",
  commands_endpoint: "https://api.oxagen.sh/v1/tacho/commands",
  credential_env: "TACHO_HOST_API_KEY",
  device_key_fingerprint: `sha256:${"a".repeat(64)}`,
  harnesses: ["claude-code"],
  issued_at_unix_s: 1_788_861_900,
  expires_at_unix_s: 1_804_413_900,
};

function unsignedBundle(): Omit<PolicyBundle, "signature"> {
  return {
    schema: "tacho.bundle.v1",
    version: 1,
    etag: "etag",
    issued_at: "2026-09-08T10:00:00.000Z",
    expires_at: "2026-09-09T10:00:00.000Z",
    host_enrollment_id: CLAIMS.host_enrollment_id,
    host_status: "active",
    deny_generation: { org: 1, workspace: 1 },
    permissions: { allow: [], deny: [], ask: [] },
    tools: {},
    budget: { mode: "observed" },
    context: { system: null },
    retention: { mode: "digest_only", classes: [] },
    mode: "observe",
  };
}

describe("enrollment signing", () => {
  it("frames the claims under the Tacho domain and signs deterministically", () => {
    const bytes = canonicalTachoEnrollmentBytes(CLAIMS);
    expect(
      bytes
        .subarray(0, TACHO_ENROLLMENT_SIGNATURE_DOMAIN.length)
        .toString("utf8"),
    ).toBe(TACHO_ENROLLMENT_SIGNATURE_DOMAIN);
    const first = signTachoEnrollment(CLAIMS, "secret");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(signTachoEnrollment(CLAIMS, "secret")).toBe(first);
    expect(
      signTachoEnrollment(
        { ...CLAIMS, agent_key: "acme.core.other" },
        "secret",
      ),
    ).not.toBe(first);
    expect(signTachoEnrollment(CLAIMS, "other")).not.toBe(first);
    expect(() =>
      canonicalTachoEnrollmentBytes({
        ...CLAIMS,
        issued_at_unix_s: Number.NaN,
      }),
    ).toThrow();
  });

  it("recognises the reserved host scope and nothing else", () => {
    expect(
      tachoHostApiKeyScopeSchema.safeParse({
        purpose: "tacho_host_v1",
        host_enrollment_id: CLAIMS.host_enrollment_id,
      }).success,
    ).toBe(true);
    expect(
      tachoHostApiKeyScopeSchema.safeParse({
        purpose: "tacho_host_v1",
        host_enrollment_id: "nope",
      }).success,
    ).toBe(false);
    expect(requestsReservedTachoPurpose({ purpose: "tacho_host_v1" })).toBe(
      true,
    );
    expect(
      requestsReservedTachoPurpose({
        purpose: "stella_operational_telemetry_v1",
      }),
    ).toBe(false);
    expect(requestsReservedTachoPurpose(null)).toBe(false);
  });
});

describe("bundle signing", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("signs over the canonical unsigned bundle and verifies offline", () => {
    const signer = bundleSignerFromPem(pem);
    const bundle: PolicyBundle = {
      ...unsignedBundle(),
      signature: signer.sign(unsignedBundle()),
    };
    expect(bundle.signature.alg).toBe("ed25519");
    expect(bundle.signature.key_id).toBe(keyIdFor(signer.publicKeyPem));
    expect(verifyBundle(bundle, signer.publicKeyPem)).toBe(true);
    expect(
      verifyBundle({ ...bundle, mode: "enforce" }, signer.publicKeyPem),
    ).toBe(false);
    expect(
      verifyBundle(
        { ...bundle, signature: { ...bundle.signature, sig: "AAAA" } },
        signer.publicKeyPem,
      ),
    ).toBe(false);
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(verifyBundle(bundle, other)).toBe(false);
  });

  it("refuses a non-ed25519 key and reads the environment", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => bundleSignerFromPem(rsa)).toThrow(/ed25519/);
    const previous = process.env["TACHO_BUNDLE_SIGNING_PRIVATE_KEY"];
    delete process.env["TACHO_BUNDLE_SIGNING_PRIVATE_KEY"];
    expect(bundleSignerFromEnv()).toBeUndefined();
    process.env["TACHO_BUNDLE_SIGNING_PRIVATE_KEY"] = pem.replace(/\n/g, "\\n");
    expect(bundleSignerFromEnv()?.keyId).toBe(
      keyIdFor(bundleSignerFromPem(pem).publicKeyPem),
    );
    if (previous === undefined)
      delete process.env["TACHO_BUNDLE_SIGNING_PRIVATE_KEY"];
    else process.env["TACHO_BUNDLE_SIGNING_PRIVATE_KEY"] = previous;
  });
});
