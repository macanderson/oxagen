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
    for (const envelope of [backwards, tooLong]) {
      const result = relayEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["expires_at"]);
    }
  });

  it("refuses a relay credential that breaks the header rule", () => {
    const missingHeader = { ...relayEnvelope, credential: { name: "billing-key", scheme: "header" } };
    const strayHeader = {
      ...relayEnvelope,
      credential: { name: "billing-key", scheme: "bearer", header: "X-Api-Key" },
    };
    expect(relayEnvelopeSchema.safeParse(missingHeader).success).toBe(false);
    expect(relayEnvelopeSchema.safeParse(strayHeader).success).toBe(false);
    const ok = { ...relayEnvelope, credential: { name: "billing-key", scheme: "header", header: "X-Api-Key" } };
    expect(relayEnvelopeSchema.safeParse(ok).success).toBe(true);
  });

  it("refuses an unsigned envelope and a path with a fragment", () => {
    const { signature: _signature, ...unsigned } = relayEnvelope;
    expect(relayEnvelopeSchema.safeParse(unsigned).success).toBe(false);
    const fragment = { ...relayEnvelope, target: { ...relayEnvelope.target, path: "/v1#x" } };
    expect(relayEnvelopeSchema.safeParse(fragment).success).toBe(false);
  });
});

describe("local-call-envelope/v1", () => {
  it("accepts a signed call and refuses an expired window", () => {
    expect(localCallEnvelopeSchema.safeParse(localEnvelope).success).toBe(true);
    const same = { ...localEnvelope, expires_at: localEnvelope.issued_at };
    expect(localCallEnvelopeSchema.safeParse(same).success).toBe(false);
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
