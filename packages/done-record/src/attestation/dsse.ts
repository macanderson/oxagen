// dsse.ts: the DSSE envelope a done-record attestation travels in.
//
// DSSE v1 signs the pre-authentication encoding (PAE) of the payload type and
// the payload bytes, so a signature made for one payload type never verifies as
// another. Protocol: https://github.com/secure-systems-lab/dsse/blob/v1.0.0/protocol.md
//
// The payload and every signature are standard base64, as the protocol writes
// them. Pure: the caller supplies the key.
import { sign, verify, type KeyObject } from "node:crypto";

/** One signature in a DSSE envelope. */
export interface DsseSignature {
  keyid: string;
  /** Standard base64 of the Ed25519 signature over the PAE bytes. */
  sig: string;
}

/** A DSSE v1 envelope. */
export interface DsseEnvelope {
  /** Standard base64 of the payload bytes. */
  payload: string;
  payloadType: string;
  signatures: DsseSignature[];
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body. */
export function pae(payloadType: string, payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"),
    type,
    Buffer.from(` ${payload.length} `, "utf8"),
    payload,
  ]);
}

/** Sign `payload` as `payloadType` with an Ed25519 private key. */
export function signEnvelope(
  payloadType: string,
  payload: Uint8Array,
  privateKey: KeyObject,
  keyid: string,
): DsseEnvelope {
  const sig = sign(null, pae(payloadType, payload), privateKey);
  return {
    payload: Buffer.from(payload).toString("base64"),
    payloadType,
    signatures: [{ keyid, sig: sig.toString("base64") }],
  };
}

/**
 * Read an envelope from untrusted JSON. Returns null unless it has the DSSE
 * shape: a base64 payload, a payload type, and at least one signature.
 */
export function parseEnvelope(value: unknown): DsseEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const { payload, payloadType, signatures } = value as Record<string, unknown>;
  if (typeof payload !== "string" || !BASE64.test(payload)) return null;
  if (typeof payloadType !== "string" || payloadType === "") return null;
  if (!Array.isArray(signatures) || signatures.length === 0) return null;
  const parsed: DsseSignature[] = [];
  for (const entry of signatures as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { keyid, sig } = entry as Record<string, unknown>;
    if (typeof keyid !== "string" || typeof sig !== "string") return null;
    if (sig === "" || !BASE64.test(sig)) return null;
    parsed.push({ keyid, sig });
  }
  return { payload, payloadType, signatures: parsed };
}

/**
 * The payload bytes when a signature in the envelope verifies under
 * `publicKey`, or null. A signature whose keyid names another key is skipped.
 * An empty keyid is a hint the signer left out, so that signature is tried.
 */
export function openEnvelope(
  envelope: DsseEnvelope,
  publicKey: KeyObject,
  keyid: string,
): Buffer | null {
  const payload = Buffer.from(envelope.payload, "base64");
  const message = pae(envelope.payloadType, payload);
  for (const signature of envelope.signatures) {
    if (signature.keyid !== "" && signature.keyid !== keyid) continue;
    if (verify(null, message, publicKey, Buffer.from(signature.sig, "base64"))) {
      return payload;
    }
  }
  return null;
}
