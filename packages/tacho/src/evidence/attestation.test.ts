import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AttestationPayload,
  attesterKeyFromPem,
  signAttestation,
  verifyAttestation,
} from "./attestation";

function pem(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

const payload: AttestationPayload = {
  run_id: "arun_1",
  attempt_id: "arat_1",
  frame_count: 3,
  merkle_root: `sha256:${"a".repeat(64)}`,
  archive_segment_digest: `sha256:${"b".repeat(64)}`,
  enforcement_tier: "harness",
  completeness_gaps: [],
  replay_grade: "view",
};

describe("run attestation", () => {
  it("signs the seal figures and verifies with the bundled public key", () => {
    const key = attesterKeyFromPem(pem());
    const attestation = signAttestation(payload, key);
    expect(attestation.key_id).toBe(key.keyId);
    expect(verifyAttestation(attestation, key.publicKeyPem)).toBe(true);
  });

  it("fails to verify a changed figure, a foreign key and a wrong algorithm (negative)", () => {
    const key = attesterKeyFromPem(pem());
    const attestation = signAttestation(payload, key);
    expect(
      verifyAttestation(
        { ...attestation, payload: { ...payload, frame_count: 4 } },
        key.publicKeyPem,
      ),
    ).toBe(false);
    expect(
      verifyAttestation(attestation, attesterKeyFromPem(pem()).publicKeyPem),
    ).toBe(false);
    expect(
      verifyAttestation(
        { ...attestation, alg: "rsa" as unknown as "ed25519" },
        key.publicKeyPem,
      ),
    ).toBe(false);
  });

  it("refuses a key that is not ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => attesterKeyFromPem(rsa)).toThrow(/must be ed25519/);
  });
});
