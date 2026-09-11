/**
 * The host device key (spec section 5.1 step 2): an Ed25519 keypair whose
 * private half never leaves the host. The public half travels in the
 * enrollment as `ed25519:<base64 raw key>`; the private half signs collector
 * checkpoints so a replay can tell which host sealed a chain head.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { writeSensitiveFileAtomic } from "./fs";

export interface DeviceKey {
  privateKey: KeyObject;
  /** `ed25519:<base64 of the 32 raw public key bytes>`. */
  publicKey: string;
  /** First 16 hex chars of sha256 over the encoded public key. */
  fingerprint: string;
  sign: (message: string) => string;
}

const SPKI_ED25519_PREFIX_BYTES = 12;

function encodePublicKey(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  const raw = spki.subarray(SPKI_ED25519_PREFIX_BYTES);
  return `ed25519:${raw.toString("base64")}`;
}

export function deviceKeyFingerprint(publicKey: string): string {
  return createHash("sha256")
    .update(publicKey, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function fromPrivateKey(privateKey: KeyObject): DeviceKey {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `device key must be ed25519, got ${privateKey.asymmetricKeyType ?? "unknown"}`,
    );
  }
  const publicKey = encodePublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    fingerprint: deviceKeyFingerprint(publicKey),
    sign: (message) =>
      sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}

export function generateDeviceKey(): DeviceKey {
  return fromPrivateKey(generateKeyPairSync("ed25519").privateKey);
}

export function deviceKeyFromPem(pem: string): DeviceKey {
  return fromPrivateKey(createPrivateKey(pem));
}

export function deviceKeyPem(key: DeviceKey): string {
  return key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Load the key at `path`, generating and persisting one when absent. */
export function loadOrCreateDeviceKey(path: string): {
  key: DeviceKey;
  created: boolean;
} {
  try {
    return {
      key: deviceKeyFromPem(readFileSync(path, "utf8")),
      created: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = generateDeviceKey();
  writeSensitiveFileAtomic(path, deviceKeyPem(key));
  return { key, created: true };
}

/** Verify a checkpoint signature against an encoded public key. */
export function verifyDeviceSignature(
  publicKey: string,
  message: string,
  signatureBase64: string,
): boolean {
  if (!publicKey.startsWith("ed25519:")) return false;
  const raw = Buffer.from(publicKey.slice("ed25519:".length), "base64");
  if (raw.length !== 32) return false;
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  try {
    return verify(
      null,
      Buffer.from(message, "utf8"),
      createPublicKey({ key: spki, format: "der", type: "spki" }),
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}
