// signer.test.ts: the cloud gateway signs local calls with the bundle key the
// host already trusts.
import { generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyIdForPublicKey } from "@oxagen/tacho/host";
import { TACHO_BUNDLE_SIGNING_KEY_ENV } from "../../lib/tacho-bundle-signing";
import { localCallSignerFromEnv, localCallSignerFromPem } from "./signer";

function ed25519Pem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("localCallSignerFromPem", () => {
  it("signs bytes the public key verifies, under the host's key id", () => {
    const signer = localCallSignerFromPem(ed25519Pem());
    const bytes = new TextEncoder().encode('{"a":1}');
    const sig = signer.sign(bytes);
    expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(verify(null, bytes, createPublicKey(signer.publicKeyPem), Buffer.from(sig, "base64"))).toBe(true);
    expect(signer.keyId).toBe(keyIdForPublicKey(signer.publicKeyPem));
  });

  it("refuses a key that is not Ed25519 and names the fix", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
    expect(() => localCallSignerFromPem(rsa.toString())).toThrow(
      `The local call signing key is rsa, not ed25519. Set ${TACHO_BUNDLE_SIGNING_KEY_ENV} to an Ed25519 key in PKCS#8 PEM.`,
    );
  });
});

describe("localCallSignerFromEnv", () => {
  it("returns undefined when the deployment sets no key", () => {
    expect(localCallSignerFromEnv({})).toBeUndefined();
  });

  it("reads a key whose newlines the environment escaped", () => {
    const pem = ed25519Pem();
    const signer = localCallSignerFromEnv({ [TACHO_BUNDLE_SIGNING_KEY_ENV]: pem.replace(/\n/g, "\\n") });
    expect(signer?.publicKeyPem).toBe(localCallSignerFromPem(pem).publicKeyPem);
  });
});
