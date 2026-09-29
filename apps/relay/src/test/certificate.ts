// certificate.ts: a self-signed client certificate and its key, made at test time.
//
// Node can read a certificate but cannot issue one. This builds a minimal
// X.509 v3 certificate in DER by hand and signs it with Ed25519, so no
// private key is committed to the repository.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

export interface TestCertificate {
  /** The certificate, PEM encoded. */
  cert: string;
  /** Its unencrypted PKCS #8 private key, PEM encoded. */
  key: string;
}

/** One DER element: its tag, its length, then its content. */
function tlv(tag: number, content: Buffer): Buffer {
  const length = content.byteLength;
  let header: Buffer;
  if (length < 0x80) header = Buffer.from([tag, length]);
  else if (length <= 0xff) header = Buffer.from([tag, 0x81, length]);
  else header = Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([header, content]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const oid = (bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const utcTime = (value: string): Buffer => tlv(0x17, Buffer.from(value, "ascii"));

/** The Ed25519 algorithm identifier, OID 1.3.101.112 with no parameters. */
const ED25519 = sequence(oid([0x2b, 0x65, 0x70]));

/** A name with one common name (OID 2.5.4.3), as a UTF8String. */
function commonName(value: string): Buffer {
  return sequence(set(sequence(oid([0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from(value, "utf8")))));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A fresh self-signed Ed25519 certificate and its key, valid from 2025 through 2049. */
export function testCertificate(name = "relay-test"): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // A positive serial with a nonzero first byte, so its DER form is minimal.
  const serial = randomBytes(8);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // version 3
    tlv(0x02, serial),
    ED25519,
    commonName(name), // issuer
    sequence(utcTime("250101000000Z"), utcTime("491231235959Z")),
    commonName(name), // subject
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign(null, tbs, privateKey);
  // A BIT STRING opens with the count of unused bits, here none.
  const certificate = sequence(tbs, ED25519, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])));
  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
