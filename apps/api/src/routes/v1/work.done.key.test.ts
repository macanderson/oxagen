// GET /v1/work/done/key: the public key document a verifier checks a done
// attestation with, and the attester key variable it comes from.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doneAttestationKeyFromPem,
  doneStatement,
  publishedDoneKey,
  signDoneAttestation,
  verifyDoneAttestation,
  type PublishedDoneKey,
} from "@oxagen/done-record/attestation";
import { ATTESTER_KEY_ENV } from "@oxagen/run-ledger/attester-key";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../middleware/logger", () => ({ logger: { warn: mocks.warn } }));

import {
  createWorkDoneKeyRoute,
  doneAttestationKeyFromEnv,
  workDoneKeyRoute,
} from "./work.done.key";

function ed25519Pem(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

async function get(route = workDoneKeyRoute): Promise<Response> {
  return await route.fetch(new Request("http://localhost/", { method: "GET" }));
}

const saved = process.env[ATTESTER_KEY_ENV];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (saved === undefined) delete process.env[ATTESTER_KEY_ENV];
  else process.env[ATTESTER_KEY_ENV] = saved;
});

describe("doneAttestationKeyFromEnv", () => {
  it("returns null when the variable is unset or empty", () => {
    expect(doneAttestationKeyFromEnv({})).toBeNull();
    expect(doneAttestationKeyFromEnv({ [ATTESTER_KEY_ENV]: "" })).toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("reads a PEM with real newlines", () => {
    const pem = ed25519Pem();
    const key = doneAttestationKeyFromEnv({ [ATTESTER_KEY_ENV]: pem });
    expect(key?.publicKeyPem).toBe(doneAttestationKeyFromPem(pem).publicKeyPem);
  });

  it("reads a PEM whose newlines a one-line store kept as \\n", () => {
    const pem = ed25519Pem();
    const oneLine = pem.replace(/\n/g, "\\n");
    expect(oneLine).not.toContain("\n");
    const key = doneAttestationKeyFromEnv({ [ATTESTER_KEY_ENV]: oneLine });
    expect(key?.keyId).toBe(doneAttestationKeyFromPem(pem).keyId);
  });

  it("parses one value once", () => {
    const env = { [ATTESTER_KEY_ENV]: ed25519Pem() };
    expect(doneAttestationKeyFromEnv(env)).toBe(doneAttestationKeyFromEnv(env));
  });

  it("returns null and warns once for a value that is not a PEM", () => {
    const env = { [ATTESTER_KEY_ENV]: "not a key" };
    expect(doneAttestationKeyFromEnv(env)).toBeNull();
    expect(doneAttestationKeyFromEnv(env)).toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ env: ATTESTER_KEY_ENV, reason: expect.any(String) }),
      expect.stringContaining("not an Ed25519 private key"),
    );
  });

  it("returns null for a private key of another type", () => {
    const ed448 = generateKeyPairSync("ed448")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(doneAttestationKeyFromEnv({ [ATTESTER_KEY_ENV]: ed448 })).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining("ed25519") }),
      expect.any(String),
    );
  });
});

describe("GET /v1/work/done/key", () => {
  it("serves the published document for the deployment's key", async () => {
    const pem = ed25519Pem();
    process.env[ATTESTER_KEY_ENV] = pem;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const doc = (await res.json()) as PublishedDoneKey;
    const key = doneAttestationKeyFromPem(pem);
    expect(doc).toEqual(publishedDoneKey(key.publicKeyPem));
    expect(doc.keyid).toBe(key.keyId);
    expect(doc.alg).toBe("ed25519");
    expect(doc.public_key_pem).not.toContain("PRIVATE");
  });

  it("serves a key that verifies a statement the same key signed", async () => {
    const pem = ed25519Pem();
    process.env[ATTESTER_KEY_ENV] = pem;
    const statement = doneStatement({
      item: "wi_0123456789ABCDEFGHJKMN",
      repository: "https://github.com/acme/api",
      commit: "c".repeat(40),
      recordDigest: `sha256:${"d".repeat(64)}`,
      outcome: { verdict: "proven", reasons: [], criteria: [{ id: "tests-pass", state: "proven" }] },
      decidedAt: new Date("2026-09-29T12:00:00.000Z"),
    });
    const { envelope } = signDoneAttestation(statement, doneAttestationKeyFromPem(pem));

    const doc = (await (await get()).json()) as PublishedDoneKey;
    const verified = verifyDoneAttestation(envelope, doc.public_key_pem);
    expect(verified).toEqual({ ok: true, statement, keyid: doc.keyid });
  });

  it("answers 503 when no key is set", async () => {
    delete process.env[ATTESTER_KEY_ENV];
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "not_configured" });
  });

  it("answers 503 when the injected key reader has no key", async () => {
    const res = await get(createWorkDoneKeyRoute({ signingKey: () => null }));
    expect(res.status).toBe(503);
  });
});
