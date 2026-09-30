import {
  createPublicKey,
  createSecretKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { DONE_RECORD_PREDICATE_TYPE } from "../types";
import {
  DSSE_IN_TOTO_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  doneAttestationKey,
  doneAttestationKeyFromPem,
  doneAttestationRef,
  doneStatement,
  envelopeCarries,
  keyIdForPublicKeyPem,
  openEnvelope,
  pae,
  parseEnvelope,
  publishedDoneKey,
  signDoneAttestation,
  signEnvelope,
  verifyDoneAttestation,
  type DoneAttestationKey,
  type DsseEnvelope,
} from "./index";

function newKey(): DoneAttestationKey {
  return doneAttestationKey(generateKeyPairSync("ed25519").privateKey);
}

function heldStatement() {
  return doneStatement({
    item: "wi_0123456789ABCDEFGHJKMN",
    repository: "https://github.com/acme/api",
    commit: "a".repeat(40),
    recordDigest: `sha256:${"b".repeat(64)}`,
    outcome: {
      verdict: "held",
      reasons: [],
      criteria: [{ id: "tests-pass", state: "held" }],
    },
    evidence: [
      { id: "tests-pass", check: { ok: true, evidence: `sha256:${"c".repeat(64)}` } },
    ],
    stageModels: { build: "model-a", verify: "model-b" },
    decidedAt: new Date("2026-09-29T12:00:00.000Z"),
  });
}

function signRaw(key: DoneAttestationKey, text: string): DsseEnvelope {
  return signEnvelope(
    DSSE_IN_TOTO_PAYLOAD_TYPE,
    Buffer.from(text, "utf8"),
    key.privateKey,
    key.keyId,
  );
}

describe("signDoneAttestation and verifyDoneAttestation", () => {
  it("verifies a signed statement with the published key", () => {
    const key = newKey();
    const published = publishedDoneKey(key.publicKeyPem);
    const statement = heldStatement();
    const { envelope, ref } = signDoneAttestation(statement, key);

    // The envelope crosses a wire as JSON before anyone checks it.
    const received: unknown = JSON.parse(JSON.stringify(envelope));
    const check = verifyDoneAttestation(received, published.public_key_pem);

    expect(check).toEqual({ ok: true, statement, keyid: published.keyid });
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]?.keyid).toBe(published.keyid);
    expect(ref).toBe(doneAttestationRef(envelope));
    expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("verifies with node:crypto alone, the way an outside verifier would", () => {
    const key = newKey();
    const published = publishedDoneKey(key.publicKeyPem);
    const { envelope } = signDoneAttestation(heldStatement(), key);
    const payload = Buffer.from(envelope.payload, "base64");
    const message = Buffer.concat([
      Buffer.from(`DSSEv1 28 application/vnd.in-toto+json ${payload.length} `, "utf8"),
      payload,
    ]);
    const sig = Buffer.from(envelope.signatures[0]?.sig ?? "", "base64");

    expect(verify(null, message, createPublicKey(published.public_key_pem), sig)).toBe(true);
    const statement = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(DONE_RECORD_PREDICATE_TYPE);
    expect(statement.subject).toEqual([
      { name: "https://github.com/acme/api", digest: { gitCommit: "a".repeat(40) } },
    ]);
  });

  it("signs the same statement to the same envelope and ref", () => {
    const key = newKey();
    const first = signDoneAttestation(heldStatement(), key);
    const second = signDoneAttestation(heldStatement(), key);
    expect(second).toEqual(first);
  });

  it("tells whether an envelope carries a given statement", () => {
    const statement = heldStatement();
    const { envelope } = signDoneAttestation(statement, newKey());
    expect(envelopeCarries(envelope, statement)).toBe(true);
    const proven = {
      ...statement,
      predicate: { ...statement.predicate, verdict: "proven" as const },
    };
    expect(envelopeCarries(envelope, proven)).toBe(false);
  });

  it("refuses a payload changed after signing", () => {
    const key = newKey();
    const { envelope } = signDoneAttestation(heldStatement(), key);
    const statement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8"),
    ) as { predicate: { verdict: string } };
    statement.predicate.verdict = "proven";
    const forged = {
      ...envelope,
      payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
    };
    expect(verifyDoneAttestation(forged, key.publicKeyPem)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses an envelope signed by another key", () => {
    const { envelope } = signDoneAttestation(heldStatement(), newKey());
    expect(verifyDoneAttestation(envelope, newKey().publicKeyPem)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a signature whose keyid is right but whose bytes are another key's", () => {
    const signer = newKey();
    const checker = newKey();
    const { envelope } = signDoneAttestation(heldStatement(), signer);
    const relabelled = {
      ...envelope,
      signatures: [{ keyid: checker.keyId, sig: envelope.signatures[0]?.sig ?? "" }],
    };
    expect(verifyDoneAttestation(relabelled, checker.publicKeyPem)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("tries a signature with no keyid, and finds ours among several", () => {
    const key = newKey();
    const other = newKey();
    const { envelope } = signDoneAttestation(heldStatement(), key);
    const ours = envelope.signatures[0]?.sig ?? "";
    const theirs = signDoneAttestation(heldStatement(), other).envelope.signatures[0]?.sig ?? "";

    const noKeyid = { ...envelope, signatures: [{ keyid: "", sig: ours }] };
    expect(verifyDoneAttestation(noKeyid, key.publicKeyPem).ok).toBe(true);

    const several = {
      ...envelope,
      signatures: [
        { keyid: other.keyId, sig: theirs },
        { keyid: key.keyId, sig: ours },
      ],
    };
    expect(verifyDoneAttestation(several, key.publicKeyPem).ok).toBe(true);
  });

  it("refuses an envelope with another payload type", () => {
    const key = newKey();
    const { envelope } = signDoneAttestation(heldStatement(), key);
    expect(
      verifyDoneAttestation({ ...envelope, payloadType: "application/json" }, key.publicKeyPem),
    ).toEqual({ ok: false, reason: "wrong_payload_type" });
  });

  it.each([
    ["null", null],
    ["a string", "envelope"],
    ["a numeric payload", { payload: 1, payloadType: "t", signatures: [] }],
    ["a payload that is not base64", { payload: "!!", payloadType: "t", signatures: [] }],
    ["an empty payload type", { payload: "", payloadType: "", signatures: [] }],
    ["no signatures", { payload: "", payloadType: "t", signatures: [] }],
    ["signatures that are not a list", { payload: "", payloadType: "t", signatures: {} }],
    ["a null signature", { payload: "", payloadType: "t", signatures: [null] }],
    ["a numeric keyid", { payload: "", payloadType: "t", signatures: [{ keyid: 1, sig: "AA==" }] }],
    ["an empty sig", { payload: "", payloadType: "t", signatures: [{ keyid: "", sig: "" }] }],
    ["a sig that is not base64", { payload: "", payloadType: "t", signatures: [{ keyid: "", sig: "!" }] }],
  ])("refuses %s as a malformed envelope", (_name, envelope) => {
    expect(verifyDoneAttestation(envelope, newKey().publicKeyPem)).toEqual({
      ok: false,
      reason: "malformed_envelope",
    });
  });

  it.each([
    ["text that is not JSON", "not json", "malformed_statement"],
    ["a JSON list", "[]", "malformed_statement"],
    ["JSON null", "null", "malformed_statement"],
    ["another statement type", JSON.stringify({ _type: "https://in-toto.io/Statement/v0.1" }), "wrong_statement_type"],
    [
      "another predicate type",
      JSON.stringify({ _type: IN_TOTO_STATEMENT_TYPE, predicateType: "https://slsa.dev/provenance/v1" }),
      "wrong_predicate_type",
    ],
    [
      "a subject that is not a list",
      JSON.stringify({
        _type: IN_TOTO_STATEMENT_TYPE,
        predicateType: DONE_RECORD_PREDICATE_TYPE,
        subject: {},
        predicate: {},
      }),
      "malformed_statement",
    ],
    [
      "a null predicate",
      JSON.stringify({
        _type: IN_TOTO_STATEMENT_TYPE,
        predicateType: DONE_RECORD_PREDICATE_TYPE,
        subject: [],
        predicate: null,
      }),
      "malformed_statement",
    ],
  ])("refuses a signed payload holding %s", (_name, text, reason) => {
    const key = newKey();
    expect(verifyDoneAttestation(signRaw(key, text), key.publicKeyPem)).toEqual({
      ok: false,
      reason,
    });
  });

  it("throws when the caller's public key is not ed25519", () => {
    const { envelope } = signDoneAttestation(heldStatement(), newKey());
    const ed448 = generateKeyPairSync("ed448")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(() => verifyDoneAttestation(envelope, ed448)).toThrow(TypeError);
  });
});

describe("DSSE", () => {
  it("encodes PAE as the protocol's test vector does", () => {
    expect(
      pae("http://example.com/HelloWorld", Buffer.from("hello world", "utf8")).toString("utf8"),
    ).toBe("DSSEv1 29 http://example.com/HelloWorld 11 hello world");
  });

  it("opens an envelope it signed and returns the payload bytes", () => {
    const key = newKey();
    const envelope = signRaw(key, "payload");
    const parsed = parseEnvelope(envelope);
    expect(parsed).toEqual(envelope);
    const opened = openEnvelope(envelope, createPublicKey(key.publicKeyPem), key.keyId);
    expect(opened?.toString("utf8")).toBe("payload");
  });
});

describe("the done attestation key", () => {
  it("reads a PKCS#8 PEM and names the key by its public half", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const key = doneAttestationKeyFromPem(pem);
    expect(key.keyId).toBe(doneAttestationKey(privateKey).keyId);
    expect(key.keyId).toBe(keyIdForPublicKeyPem(key.publicKeyPem));
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses a key that is not an ed25519 private key", () => {
    const ed448 = generateKeyPairSync("ed448");
    expect(() => doneAttestationKey(ed448.privateKey)).toThrow(/ed25519 private key/);
    const ed25519 = generateKeyPairSync("ed25519");
    expect(() => doneAttestationKey(ed25519.publicKey)).toThrow(/got a public ed25519 key/);
    expect(() => doneAttestationKey(createSecretKey(Buffer.alloc(32)))).toThrow(
      /got a secret undefined key/,
    );
  });

  it("publishes the public key with the types a verifier checks", () => {
    const key = newKey();
    const published = publishedDoneKey(`${key.publicKeyPem}\n`);
    expect(published).toEqual({
      keyid: key.keyId,
      alg: "ed25519",
      public_key_pem: key.publicKeyPem,
      statement_type: "https://in-toto.io/Statement/v1",
      payload_type: "application/vnd.in-toto+json",
      predicate_type: "https://oxagen.sh/attestations/done-record/v1",
    });
  });

  it("refuses to publish a key that is not ed25519", () => {
    const pem = generateKeyPairSync("ed448")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(() => publishedDoneKey(pem)).toThrow(/must be ed25519, got ed448/);
  });
});
