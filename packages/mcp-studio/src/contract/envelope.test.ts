import { describe, expect, it } from "vitest";
import { envelopeSigningBytes, ENVELOPE_TTL_MAX_MS } from "./envelope";
import { localCallEnvelopeSchema } from "./local-call-envelope";
import { relayEnvelopeSchema, relayHeadersHash } from "./relay-envelope";

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
    scheme: "https",
    method: "POST",
    host: "billing.internal.a-intel.com",
    path: "/v1/refunds",
  },
  headers_hash: digest,
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
        scheme: "http",
        host: "ledger.internal.a-intel.com",
        port: 8443,
        service: "a_intel.ledger.v1.Ledger",
        method: "PostEntry",
      },
    };
    expect(relayEnvelopeSchema.safeParse(grpc).success).toBe(true);
  });

  it("refuses a target with no scheme or a scheme other than https and http", () => {
    const { scheme: _scheme, ...noScheme } = relayEnvelope.target;
    for (const target of [noScheme, { ...relayEnvelope.target, scheme: "ftp" }]) {
      expect(pathsAndMessages(relayEnvelopeSchema.safeParse({ ...relayEnvelope, target }))).toStrictEqual([
        { path: "target", message: "Invalid input" },
      ]);
    }
  });

  it("refuses an envelope with no headers_hash", () => {
    const { headers_hash: _headersHash, ...unbound } = relayEnvelope;
    expect(pathsAndMessages(relayEnvelopeSchema.safeParse(unbound))).toStrictEqual([
      { path: "headers_hash", message: "Required" },
    ]);
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

  it("refuses an instant whose offset is out of range, once, with the offset rule", () => {
    for (const field of ["issued_at", "expires_at"] as const) {
      const envelope = { ...relayEnvelope, [field]: "2026-09-26T12:00:00+99:99" };
      expect(pathsAndMessages(relayEnvelopeSchema.safeParse(envelope))).toStrictEqual([
        { path: field, message: "the offset must be Z, or +HH:MM or -HH:MM with hours 00 to 23 and minutes 00 to 59" },
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

describe("relayHeadersHash", () => {
  const headers = [
    ["Content-Type", "application/json"],
    ["X-Request-Source", "oxagen"],
  ] as const;

  it("hashes the RFC 8785 form of the [name, value] list with lowercase names", () => {
    // shasum -a 256 of [["content-type","application/json"],["x-request-source","oxagen"]]
    expect(relayHeadersHash(headers)).toBe(
      "sha256:a5978849699c271aa1eed6b04a1204fe942c5c5ff1859a1545c03f862b2a9820",
    );
  });

  it("lowercases names and keeps values as sent", () => {
    const lower = headers.map(([name, value]) => [name.toLowerCase(), value] as const);
    expect(relayHeadersHash(lower)).toBe(relayHeadersHash(headers));
    expect(relayHeadersHash([["x-request-source", "Oxagen"]])).not.toBe(
      relayHeadersHash([["x-request-source", "oxagen"]]),
    );
  });

  it("changes when the order changes", () => {
    expect(relayHeadersHash([...headers].reverse())).not.toBe(relayHeadersHash(headers));
  });

  it("hashes no headers as the empty list", () => {
    // shasum -a 256 of []
    expect(relayHeadersHash([])).toBe("sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
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

  it("keeps deadline_ms and signs it", () => {
    const bounded = { ...localEnvelope, deadline_ms: 45_000 };
    expect(localCallEnvelopeSchema.parse(bounded)).toStrictEqual(bounded);
    expect(envelopeSigningBytes({ ...bounded, deadline_ms: 300_000 })).not.toEqual(envelopeSigningBytes(bounded));
  });

  it.each([
    [0, "Number must be greater than or equal to 1"],
    [300_001, "Number must be less than or equal to 300000"],
    [1.5, "Expected integer, received float"],
  ])("refuses a deadline_ms of %s", (deadline, message) => {
    const result = localCallEnvelopeSchema.safeParse({ ...localEnvelope, deadline_ms: deadline });
    expect(pathsAndMessages(result)).toStrictEqual([{ path: "deadline_ms", message }]);
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
