/**
 * The seal's attestation (#4000, ADR-195): the key is read from the export's
 * variable and kept per process, a seal with no key still writes its segment
 * digest, and a signature a seal writes verifies over exactly the figures it
 * names.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  type Attestation,
  RUN_ATTESTATION_FIELDS,
  verifyAttestation,
} from "@oxagen/tacho";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTESTER_KEY_ENV,
  deferredAttester,
  type SealAttestationFigures,
  sealAttestationPayload,
  signSealAttestation,
} from "./attester";

function pem(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

/** The variable as the deployment stores it: one line, newlines as `\n`. */
const oneLine = (value: string) => value.replace(/\n/g, "\\n");

const FIGURES: SealAttestationFigures = {
  runPublicId: "arun_0123456789abcdefghjkmn",
  attemptPublicId: "arat_0123456789abcdefghjkmn",
  frameCount: 3,
  merkleRoot: `sha256:${"c".repeat(64)}`,
  archiveSegmentDigest: `sha256:${"9".repeat(64)}`,
  enforcementTier: "gateway",
  completenessGaps: ["body_missing", "tool_bodies"],
  replayGrade: "inspect",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deferredAttester", () => {
  it("answers null when no key is configured (negative)", () => {
    vi.stubEnv(ATTESTER_KEY_ENV, "");
    expect(deferredAttester()).toBeNull();
  });

  it("reads the key the export signs with, newlines stored as \\n, and keeps it per process", () => {
    vi.stubEnv(ATTESTER_KEY_ENV, oneLine(pem()));
    const key = deferredAttester();
    expect(key?.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(deferredAttester()).toBe(key);
  });

  it("parses the new key when the variable changes, rather than signing with the old one", () => {
    vi.stubEnv(ATTESTER_KEY_ENV, oneLine(pem()));
    const first = deferredAttester();
    vi.stubEnv(ATTESTER_KEY_ENV, oneLine(pem()));
    const second = deferredAttester();
    expect(second).not.toBeNull();
    expect(second?.keyId).not.toBe(first?.keyId);
  });

  it("answers null for a value that is not an Ed25519 key, and says so once (negative)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv(ATTESTER_KEY_ENV, "not a key");
    expect(deferredAttester()).toBeNull();
    expect(deferredAttester()).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(ATTESTER_KEY_ENV);
    // The message names the variable, never its value.
    expect(String(error.mock.calls[0]?.[0])).not.toContain("not a key");
  });

  it("refuses an RSA key as the attester (negative)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    vi.stubEnv(ATTESTER_KEY_ENV, oneLine(rsa));
    expect(deferredAttester()).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("sealAttestationPayload", () => {
  it("names exactly the fields a reader prints beside the signature, in order", () => {
    expect(Object.keys(sealAttestationPayload(FIGURES))).toEqual([
      ...RUN_ATTESTATION_FIELDS,
    ]);
  });

  it("copies the gaps, so the seal's list cannot be changed through the payload", () => {
    const gaps = ["chain_break"];
    const payload = sealAttestationPayload({
      ...FIGURES,
      completenessGaps: gaps,
    });
    payload.completeness_gaps.push("telemetry_gap");
    expect(gaps).toEqual(["chain_break"]);
  });
});

describe("signSealAttestation", () => {
  function attestationOf(
    figures: SealAttestationFigures,
    keyId: string,
    sig: string,
  ): Attestation {
    return {
      payload: sealAttestationPayload(figures),
      key_id: keyId,
      alg: "ed25519",
      sig,
    };
  }

  it("signs the seal's figures, and the signature verifies over them with the key's public half", () => {
    vi.stubEnv(ATTESTER_KEY_ENV, oneLine(pem()));
    const key = deferredAttester();
    if (key === null) throw new Error("a key");
    const columns = signSealAttestation(key, FIGURES);
    expect(columns.archiveSegmentDigest).toBe(FIGURES.archiveSegmentDigest);
    expect(columns.attestationKeyId).toBe(key.keyId);
    const sig = columns.attestationSig;
    if (sig === null) throw new Error("a signature");
    expect(
      verifyAttestation(
        attestationOf(FIGURES, key.keyId, sig),
        key.publicKeyPem,
      ),
    ).toBe(true);
  });

  it("does not verify over figures that changed after the seal (negative)", () => {
    vi.stubEnv(ATTESTER_KEY_ENV, oneLine(pem()));
    const key = deferredAttester();
    if (key === null) throw new Error("a key");
    const sig = signSealAttestation(key, FIGURES).attestationSig;
    if (sig === null) throw new Error("a signature");
    for (const changed of [
      { ...FIGURES, frameCount: 2 },
      { ...FIGURES, replayGrade: "fork" },
      { ...FIGURES, enforcementTier: "harness" },
      { ...FIGURES, completenessGaps: ["tool_bodies", "body_missing"] },
    ]) {
      expect(
        verifyAttestation(
          attestationOf(changed, key.keyId, sig),
          key.publicKeyPem,
        ),
      ).toBe(false);
    }
  });

  it("writes the segment digest and no signature when no key is configured (negative)", () => {
    expect(signSealAttestation(null, FIGURES)).toEqual({
      archiveSegmentDigest: FIGURES.archiveSegmentDigest,
      attestationKeyId: null,
      attestationSig: null,
    });
  });
});
