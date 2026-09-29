// signer.ts: the key the cloud gateway signs relay envelopes with.
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { documentHash, envelopeSigningBytes, relayEnvelopeSchema, relayHeadersHash } from "@oxagen/mcp-studio";
import { describe, expect, it } from "vitest";
import { relayKeyId } from "./protocol/key-id";
import {
  newNonce,
  RELAY_SIGNING_KEY_ENV,
  relaySignerFromEnv,
  relaySignerFromPem,
  signRelayEnvelope,
  type UnsignedRelayEnvelope,
} from "./signer";

function ed25519PrivatePem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function unsignedEnvelope(): UnsignedRelayEnvelope {
  const issued = Date.parse("2026-09-28T12:00:00.000Z");
  return {
    schema: "relay-envelope/v1",
    relay: "office",
    workspace: "wrk_0123456789abcdefghjkmn",
    nonce: newNonce(),
    issued_at: new Date(issued).toISOString(),
    expires_at: new Date(issued + 10_000).toISOString(),
    target: { kind: "http", scheme: "https", method: "GET", host: "billing.internal", path: "/v1/invoices" },
    headers_hash: relayHeadersHash([["accept", "application/json"]]),
    body_hash: documentHash(""),
    deadline_ms: 30_000,
  };
}

describe("relaySignerFromPem", () => {
  it("signs with the key and names it by its public key's id", () => {
    const signer = relaySignerFromPem(ed25519PrivatePem());
    const bytes = new TextEncoder().encode("the bytes");
    const sig = signer.sign(bytes);
    expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(verify(null, bytes, createPublicKey(signer.publicKeyPem), Buffer.from(sig, "base64"))).toBe(true);
    expect(signer.keyId).toBe(relayKeyId(signer.publicKeyPem));
  });

  it("refuses a key that is not Ed25519", () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => relaySignerFromPem(pem)).toThrow(/is ec, not ed25519/);
  });
});

describe("relaySignerFromEnv", () => {
  it("is undefined when the deployment sets no key", () => {
    expect(relaySignerFromEnv({})).toBeUndefined();
    expect(relaySignerFromEnv({ [RELAY_SIGNING_KEY_ENV]: "" })).toBeUndefined();
  });

  it("reads a PEM whose line breaks were written as \\n", () => {
    const pem = ed25519PrivatePem();
    const fromEscaped = relaySignerFromEnv({ [RELAY_SIGNING_KEY_ENV]: pem.replace(/\n/g, "\\n") });
    expect(fromEscaped?.keyId).toBe(relaySignerFromPem(pem).keyId);
  });
});

describe("signRelayEnvelope", () => {
  it("gives an envelope the contract accepts, signed over its bytes without the signature", () => {
    const signer = relaySignerFromPem(ed25519PrivatePem());
    const envelope = signRelayEnvelope(unsignedEnvelope(), signer);
    expect(relayEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.signature.key_id).toBe(signer.keyId);
    expect(envelope.signature.alg).toBe("ed25519");
    const valid = verify(
      null,
      envelopeSigningBytes(envelope),
      createPublicKey(signer.publicKeyPem),
      Buffer.from(envelope.signature.sig, "base64"),
    );
    expect(valid).toBe(true);
  });

  it("binds the workspace, so changing it breaks the signature", () => {
    const signer = relaySignerFromPem(ed25519PrivatePem());
    const envelope = signRelayEnvelope(unsignedEnvelope(), signer);
    const moved = { ...envelope, workspace: "wrk_other" };
    const valid = verify(
      null,
      envelopeSigningBytes(moved),
      createPublicKey(signer.publicKeyPem),
      Buffer.from(envelope.signature.sig, "base64"),
    );
    expect(valid).toBe(false);
  });
});

describe("newNonce", () => {
  it("is 22 base64url characters and never repeats", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => newNonce()));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
