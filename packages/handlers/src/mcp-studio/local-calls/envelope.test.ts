// envelope.test.ts: the cloud gateway signs local-call-envelope/v1 with M0's
// schema and helpers, and the local gateway reads it with tacho's copies.
// These tests hold the two sides to the same bytes.
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalDigest,
  envelopeSigningBytes as m0SigningBytes,
  localCallEnvelopeSchema as m0EnvelopeSchema,
} from "@oxagen/mcp-studio";
import { keyIdForPublicKey } from "@oxagen/recorder/host";
import {
  argumentsHashOf,
  envelopeSigningBytes as tachoSigningBytes,
  localCallEnvelopeSchema as tachoEnvelopeSchema,
} from "@oxagen/recorder/local-servers";
import { LOCAL_CALL_TTL_MS, newNonce, signLocalCall } from "./envelope";
import { DEFINITION_HASH, FILES_DIGEST, MACHINE, testSigner } from "./test-support";

const NOW = new Date("2026-09-27T12:00:00.000Z");

const CALL = {
  tool: "files__read_file",
  upstream: "read_file",
  version: 3,
  definition_hash: DEFINITION_HASH,
  package_digest: FILES_DIGEST,
  arguments: { path: "notes/today.md", options: { encoding: "utf8", lines: [1, 20] } },
  deadline_ms: 15_000,
};

function verifies(envelope: Record<string, unknown>, publicKeyPem: string): boolean {
  const signature = envelope.signature as { sig: string };
  return verify(
    null,
    tachoSigningBytes(envelope),
    createPublicKey(publicKeyPem),
    Buffer.from(signature.sig, "base64"),
  );
}

describe("signLocalCall", () => {
  it("writes an envelope both M0's schema and tacho's copy accept", () => {
    const signer = testSigner();
    const envelope = signLocalCall({ call: CALL, machine: MACHINE, signer, now: NOW });
    expect(m0EnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(tachoEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("binds the call's tool, version, hashes, deadline, and machine", () => {
    const signer = testSigner();
    const envelope = signLocalCall({ call: CALL, machine: MACHINE, signer, now: NOW, nonce: "n".repeat(22) });
    expect(envelope).toMatchObject({
      schema: "local-call-envelope/v1",
      tool: CALL.tool,
      upstream: CALL.upstream,
      version: 3,
      definition_hash: DEFINITION_HASH,
      package_digest: FILES_DIGEST,
      arguments_hash: canonicalDigest(CALL.arguments),
      deadline_ms: 15_000,
      machine: MACHINE,
      nonce: "n".repeat(22),
      issued_at: "2026-09-27T12:00:00.000Z",
      expires_at: "2026-09-27T12:00:10.000Z",
    });
    expect(Date.parse(envelope.expires_at) - Date.parse(envelope.issued_at)).toBe(LOCAL_CALL_TTL_MS);
  });

  it("signs with the key the host verifies, under the host's key id", () => {
    const signer = testSigner();
    const envelope = signLocalCall({ call: CALL, machine: MACHINE, signer, now: NOW });
    expect(envelope.signature.key_id).toBe(keyIdForPublicKey(signer.publicKeyPem));
    expect(envelope.signature.alg).toBe("ed25519");
    expect(verifies(envelope, signer.publicKeyPem)).toBe(true);
  });

  it("does not verify once a signed field changes", () => {
    const signer = testSigner();
    const envelope = signLocalCall({ call: CALL, machine: MACHINE, signer, now: NOW });
    expect(verifies({ ...envelope, machine: "tch_other" }, signer.publicKeyPem)).toBe(false);
    expect(verifies({ ...envelope, expires_at: "2026-09-27T12:00:29.000Z" }, signer.publicKeyPem)).toBe(false);
    expect(verifies({ ...envelope, arguments_hash: canonicalDigest({ path: "/etc/passwd" }) }, signer.publicKeyPem)).toBe(
      false,
    );
  });

  it("does not verify under another key", () => {
    const envelope = signLocalCall({ call: CALL, machine: MACHINE, signer: testSigner(), now: NOW });
    expect(verifies(envelope, testSigner().publicKeyPem)).toBe(false);
  });

  it("throws on an expiry more than 30 seconds out, as M0's schema refuses it", () => {
    expect(() => signLocalCall({ call: CALL, machine: MACHINE, signer: testSigner(), now: NOW, ttlMs: 60_000 })).toThrow(
      /at most 30 seconds/,
    );
  });

  it("throws on a machine id the envelope cannot carry", () => {
    expect(() => signLocalCall({ call: CALL, machine: "not a machine", signer: testSigner(), now: NOW })).toThrow();
  });

  it("uses a new nonce for every call", () => {
    const signer = testSigner();
    const first = signLocalCall({ call: CALL, machine: MACHINE, signer, now: NOW });
    const second = signLocalCall({ call: CALL, machine: MACHINE, signer, now: NOW });
    expect(first.nonce).not.toBe(second.nonce);
  });
});

describe("newNonce", () => {
  it("is 128 bits in base64url: 22 characters", () => {
    expect(newNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("tacho's copies match M0", () => {
  const shapes: Array<Record<string, unknown>> = [
    {},
    { path: "a.md" },
    { b: 2, a: 1 },
    { nested: { z: [3, 2, 1], a: { deep: true } }, text: "é ☃ \u0000" },
    { number: 1e21, small: 0.000001, negative: -0, big: 9007199254740991 },
    { list: [null, "x", { y: false }] },
    { dropped: undefined, kept: 1 },
  ];

  it.each(shapes.map((shape): [string, Record<string, unknown>] => [JSON.stringify(shape), shape]))(
    "hashes arguments %s the same way",
    (_label, shape) => {
      expect(argumentsHashOf(shape)).toBe(canonicalDigest(shape));
    },
  );

  it("signs the same bytes", () => {
    const envelope = signLocalCall({ call: CALL, machine: MACHINE, signer: testSigner(), now: NOW });
    expect(Buffer.from(tachoSigningBytes(envelope)).equals(Buffer.from(m0SigningBytes(envelope)))).toBe(true);
  });

  it("both refuse an extra field", () => {
    const envelope = { ...signLocalCall({ call: CALL, machine: MACHINE, signer: testSigner(), now: NOW }), extra: 1 };
    expect(m0EnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(tachoEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("both refuse a nonce shorter than 128 bits", () => {
    const envelope = { ...signLocalCall({ call: CALL, machine: MACHINE, signer: testSigner(), now: NOW }), nonce: "short" };
    expect(m0EnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(tachoEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("both refuse a signature that is not Ed25519's length", () => {
    const signed = signLocalCall({ call: CALL, machine: MACHINE, signer: testSigner(), now: NOW });
    const envelope = { ...signed, signature: { ...signed.signature, sig: "AAAA" } };
    expect(m0EnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(tachoEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });
});
