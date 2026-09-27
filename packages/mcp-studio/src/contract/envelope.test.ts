import { describe, expect, it } from "vitest";
import { envelopeSigningBytes, ENVELOPE_TTL_MAX_MS } from "./envelope";
import { localCallEnvelopeSchema } from "./local-call-envelope";
import { relayEnvelopeSchema } from "./relay-envelope";

const signature = {
  key_id: "0123456789abcdef",
  alg: "ed25519",
  sig: `${"A".repeat(86)}==`,
};
const digest = `sha256:${"a".repeat(64)}`;

interface ParseOutcome {
  success: boolean;
  error?: { issues: { path: (string | number)[]; message: string }[] };
}

/** Each issue of a failed parse as its dotted path and message, or [] when the parse passed. */
function pathsAndMessages(result: ParseOutcome): { path: string; message: string }[] {
  if (result.success || result.error === undefined) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

const relayEnvelope = {
  schema: "relay-envelope/v1",
  relay: "billing-vpc",
  nonce: "q8Zt3rXy1mB9nVc2LwPa7s",
  issued_at: "2026-09-26T12:00:00Z",
  expires_at: "2026-09-26T12:00:05Z",
  target: {
    kind: "http",
    method: "POST",
    host: "billing.internal.a-intel.com",
    path: "/v1/refunds",
  },
  body_hash: digest,
  signature,
};

const localEnvelope = {
  schema: "local-call-envelope/v1",
  tool: "files__read_file",
  upstream: "read_file",
  version: 1,
  definition_hash: digest,
  package_digest: digest,
  arguments_hash: digest,
  machine: "mac-studio-7",
  nonce: "q8Zt3rXy1mB9nVc2LwPa7s",
  issued_at: "2026-09-26T12:00:00Z",
  expires_at: "2026-09-26T12:00:05Z",
  signature,
};

describe("relay-envelope/v1", () => {
  it("accepts an HTTP target and a gRPC target", () => {
    expect(relayEnvelopeSchema.safeParse(relayEnvelope).success).toBe(true);
    const grpc = {
      ...relayEnvelope,
      target: {
        kind: "grpc",
        host: "ledger.internal.a-intel.com",
        port: 8443,
        service: "a_intel.ledger.v1.Ledger",
        method: "PostEntry",
      },
    };
    expect(relayEnvelopeSchema.safeParse(grpc).success).toBe(true);
  });

  it("refuses an expiry before issue or past the limit", () => {
    const backwards = { ...relayEnvelope, expires_at: "2026-09-26T11:59:59Z" };
    const tooLong = {
      ...relayEnvelope,
      expires_at: new Date(Date.parse(relayEnvelope.issued_at) + ENVELOPE_TTL_MAX_MS + 1000).toISOString(),
    };
    expect(pathsAndMessages(relayEnvelopeSchema.safeParse(backwards))).toStrictEqual([
      { path: "expires_at", message: "expires_at must be after issued_at" },
    ]);
    expect(pathsAndMessages(relayEnvelopeSchema.safeParse(tooLong))).toStrictEqual([
      { path: "expires_at", message: "expires_at must be at most 30 seconds after issued_at" },
    ]);
    const atLimit = {
      ...relayEnvelope,
      expires_at: new Date(Date.parse(relayEnvelope.issued_at) + ENVELOPE_TTL_MAX_MS).toISOString(),
    };
    expect(relayEnvelopeSchema.safeParse(atLimit).success).toBe(true);
  });

  it("refuses an instant whose offset is out of range, which no clock can read", () => {
    for (const field of ["issued_at", "expires_at"] as const) {
      const envelope = { ...relayEnvelope, [field]: "2026-09-26T12:00:00+99:99" };
      expect(pathsAndMessages(relayEnvelopeSchema.safeParse(envelope))).toStrictEqual([
        { path: field, message: `${field} is not an instant a clock can read` },
      ]);
    }
  });

  it("reports a malformed instant once, on its own field", () => {
    const result = relayEnvelopeSchema.safeParse({ ...relayEnvelope, expires_at: "soon" });
    expect(pathsAndMessages(result)).toStrictEqual([{ path: "expires_at", message: "Invalid datetime" }]);
  });

  it("refuses a relay credential that breaks the header rule", () => {
    const missingHeader = { ...relayEnvelope, credential: { name: "billing-key", scheme: "header" } };
    const strayHeader = {
      ...relayEnvelope,
      credential: { name: "billing-key", scheme: "bearer", header: "X-Api-Key" },
    };
    expect(pathsAndMessages(relayEnvelopeSchema.safeParse(missingHeader))).toStrictEqual([
      { path: "credential.header", message: "header is required when scheme is header" },
    ]);
    expect(pathsAndMessages(relayEnvelopeSchema.safeParse(strayHeader))).toStrictEqual([
      { path: "credential.header", message: "header is not allowed when scheme is not header" },
    ]);
    const ok = { ...relayEnvelope, credential: { name: "billing-key", scheme: "header", header: "X-Api-Key" } };
    expect(relayEnvelopeSchema.safeParse(ok).success).toBe(true);
  });

  it("refuses an unsigned envelope and a path with a fragment", () => {
    const { signature: _signature, ...unsigned } = relayEnvelope;
    expect(pathsAndMessages(relayEnvelopeSchema.safeParse(unsigned))).toStrictEqual([
      { path: "signature", message: "Required" },
    ]);
    const fragment = { ...relayEnvelope, target: { ...relayEnvelope.target, path: "/v1#x" } };
    expect(pathsAndMessages(relayEnvelopeSchema.safeParse(fragment))).toStrictEqual([
      { path: "target.path", message: "a path starts with / and has no spaces or fragment" },
    ]);
  });
});

describe("local-call-envelope/v1", () => {
  it("accepts a signed call and refuses an expired window", () => {
    expect(localCallEnvelopeSchema.safeParse(localEnvelope).success).toBe(true);
    const same = { ...localEnvelope, expires_at: localEnvelope.issued_at };
    expect(pathsAndMessages(localCallEnvelopeSchema.safeParse(same))).toStrictEqual([
      { path: "expires_at", message: "expires_at must be after issued_at" },
    ]);
  });
});

describe("envelopeSigningBytes", () => {
  it("signs the canonical form without the signature", () => {
    const text = new TextDecoder().decode(envelopeSigningBytes(relayEnvelope));
    expect(text).not.toContain("signature");
    expect(text.startsWith('{"body_hash":')).toBe(true);
    const reordered = Object.fromEntries(Object.entries(relayEnvelope).reverse());
    expect(envelopeSigningBytes(reordered)).toEqual(envelopeSigningBytes(relayEnvelope));
    const otherSignature = { ...relayEnvelope, signature: { ...signature, sig: `${"B".repeat(86)}==` } };
    expect(envelopeSigningBytes(otherSignature)).toEqual(envelopeSigningBytes(relayEnvelope));
  });
});
