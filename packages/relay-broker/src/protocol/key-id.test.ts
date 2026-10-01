// key-id.ts: the id of the signing key, and the public key form it hashes.
import { generateKeyPairSync } from "node:crypto";
import { keyIdForPublicKey } from "@oxagen/recorder/host";
import { describe, expect, it } from "vitest";
import { normalizePublicKeyPem, relayKeyId } from "./key-id";

function ed25519(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("relayKeyId", () => {
  it("gives the id tacho gives the same key", () => {
    const { publicPem } = ed25519();
    expect(relayKeyId(publicPem)).toBe(keyIdForPublicKey(publicPem));
  });

  it("is 16 lowercase hex characters", () => {
    expect(relayKeyId(ed25519().publicPem)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs between keys", () => {
    expect(relayKeyId(ed25519().publicPem)).not.toBe(relayKeyId(ed25519().publicPem));
  });
});

describe("normalizePublicKeyPem", () => {
  it("gives a key pasted with other line breaks the signer's id", () => {
    const { publicPem } = ed25519();
    const pasted = `\n${publicPem.replace(/\n/g, "\r\n")}\r\n\r\n`;
    expect(normalizePublicKeyPem(pasted)).toBe(publicPem);
    expect(relayKeyId(normalizePublicKeyPem(pasted))).toBe(relayKeyId(publicPem));
  });

  it("refuses a private key by name", () => {
    expect(() => normalizePublicKeyPem(ed25519().privatePem)).toThrow(/private key/);
  });

  it("refuses a key that is not Ed25519", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => normalizePublicKeyPem(pem)).toThrow(/ec, and a relay trusts only Ed25519/);
  });

  it("refuses text that is not a key", () => {
    expect(() => normalizePublicKeyPem("not a key")).toThrow();
  });
});
