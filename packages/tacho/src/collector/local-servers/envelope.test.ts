import { describe, expect, it } from "vitest";
import { keyIdForPublicKey } from "../../host/key-id";
import { DEFAULT_CLOCK_SKEW_MS, verifyCallDelivery, type VerifyCallOptions } from "./envelope";
import {
  argumentsMismatch,
  envelopeExpired,
  envelopeInvalid,
  envelopeReplayed,
  launchMismatch,
  wrongMachine,
} from "./errors";
import { createNonceLedger } from "./nonces";
import { callDelivery, MACHINE, NOW, npmLaunch, signingKey, type SigningKey } from "./test-support";
import type { CallDelivery, LocalCallEnvelope } from "./wire";

const key = signingKey();

function options(overrides?: Partial<VerifyCallOptions>): VerifyCallOptions {
  return {
    machine: MACHINE,
    publicKeyPem: key.publicKeyPem,
    nonces: createNonceLedger({ skewMs: DEFAULT_CLOCK_SKEW_MS }),
    now: NOW,
    skewMs: DEFAULT_CLOCK_SKEW_MS,
    ...overrides,
  };
}

function delivery(envelope?: Partial<Omit<LocalCallEnvelope, "signature">>, signer: SigningKey = key): CallDelivery {
  return callDelivery({ key: signer, launch: npmLaunch(), arguments: { path: "notes.md" }, envelope });
}

function withSignature(call: CallDelivery, signature: Partial<LocalCallEnvelope["signature"]>): CallDelivery {
  return { ...call, envelope: { ...call.envelope, signature: { ...call.envelope.signature, ...signature } } };
}

describe("verifyCallDelivery", () => {
  it("accepts a signed envelope for this machine and records its nonce", () => {
    const opts = options();
    expect(verifyCallDelivery(delivery(), opts)).toEqual({ ok: true });
    expect(opts.nonces.size()).toBe(1);
  });

  it("refuses an algorithm other than ed25519", () => {
    const call = withSignature(delivery(), { alg: "rsa" as unknown as "ed25519" });
    expect(verifyCallDelivery(call, options())).toEqual({
      ok: false,
      refusal: envelopeInvalid("it is signed with rsa, and this machine accepts only ed25519"),
    });
  });

  it("refuses an envelope signed by a key this machine does not trust", () => {
    const other = signingKey();
    expect(verifyCallDelivery(delivery(undefined, other), options())).toEqual({
      ok: false,
      refusal: envelopeInvalid(`it names signing key ${other.keyId}, and this machine trusts key ${key.keyId}`),
    });
  });

  it("refuses an envelope changed after it was signed", () => {
    const call = delivery();
    const changed = { ...call, envelope: { ...call.envelope, tool: "files.write_file" } };
    expect(verifyCallDelivery(changed, options())).toEqual({
      ok: false,
      refusal: envelopeInvalid("the signature does not match its contents"),
    });
  });

  it("refuses when the trusted key is not a public key", () => {
    const call = withSignature(delivery(), { key_id: keyIdForPublicKey("not a key") });
    expect(verifyCallDelivery(call, options({ publicKeyPem: "not a key" }))).toEqual({
      ok: false,
      refusal: envelopeInvalid("the signature does not match its contents"),
    });
  });

  it("refuses an envelope for another machine", () => {
    expect(verifyCallDelivery(delivery({ machine: "tch_other" }), options())).toEqual({
      ok: false,
      refusal: wrongMachine("tch_other"),
    });
  });

  const unordered: [string, Partial<Omit<LocalCallEnvelope, "signature">>][] = [
    ["expires when it is issued", { issued_at: new Date(NOW).toISOString(), expires_at: new Date(NOW).toISOString() }],
    ["has an issued_at that is not a time", { issued_at: "not a time" }],
    ["has an expires_at that is not a time", { expires_at: "not a time" }],
  ];
  it.each(unordered)("refuses an envelope that %s", (_name, envelope) => {
    expect(verifyCallDelivery(delivery(envelope), options())).toEqual({
      ok: false,
      refusal: envelopeInvalid("its expires_at is not later than its issued_at"),
    });
  });

  it("refuses an envelope issued later than the clock skew allows", () => {
    const issuedAt = new Date(NOW + 10_000).toISOString();
    const call = delivery({ issued_at: issuedAt, expires_at: new Date(NOW + 20_000).toISOString() });
    expect(verifyCallDelivery(call, options())).toEqual({
      ok: false,
      refusal: envelopeInvalid(`it was issued at ${issuedAt}, later than this machine's clock allows`),
    });
  });

  it("refuses an expired envelope", () => {
    const expiresAt = new Date(NOW - 30_000).toISOString();
    const call = delivery({ issued_at: new Date(NOW - 40_000).toISOString(), expires_at: expiresAt });
    expect(verifyCallDelivery(call, options())).toEqual({ ok: false, refusal: envelopeExpired(expiresAt) });
  });

  it("expires an envelope at the TTL cap, whatever its expires_at says", () => {
    const call = delivery({
      issued_at: new Date(NOW - 36_000).toISOString(),
      expires_at: new Date(NOW + 60_000).toISOString(),
    });
    expect(verifyCallDelivery(call, options())).toEqual({
      ok: false,
      refusal: envelopeExpired(new Date(NOW - 6_000).toISOString()),
    });
  });

  it("accepts an envelope that expired within the clock skew", () => {
    const call = delivery({
      issued_at: new Date(NOW - 10_000).toISOString(),
      expires_at: new Date(NOW - 2_000).toISOString(),
    });
    expect(verifyCallDelivery(call, options())).toEqual({ ok: true });
  });

  it("refuses a launch whose package digest the envelope does not sign", () => {
    const call = delivery();
    const other = `sha256:${"c".repeat(64)}`;
    const changed = { ...call, launch: npmLaunch({ package: { ...call.launch.package, digest: other } }) };
    expect(verifyCallDelivery(changed, options())).toEqual({
      ok: false,
      refusal: launchMismatch(
        `the launch pins package digest ${other}, and the envelope signs ${call.envelope.package_digest}`,
      ),
    });
  });

  it("refuses arguments that do not hash to arguments_hash, and keeps the nonce free", () => {
    const opts = options();
    const call = { ...delivery(), arguments: { path: "/etc/passwd" } };
    expect(verifyCallDelivery(call, opts)).toEqual({ ok: false, refusal: argumentsMismatch() });
    expect(opts.nonces.size()).toBe(0);
  });

  it("refuses a replayed envelope", () => {
    const opts = options();
    const call = delivery();
    expect(verifyCallDelivery(call, opts)).toEqual({ ok: true });
    expect(verifyCallDelivery(call, opts)).toEqual({ ok: false, refusal: envelopeReplayed() });
  });
});
