import { createHmac } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateRunTokenKey,
  loadOrCreateRunTokenKey,
  looksLikeRunToken,
  mintRunToken,
  peekRunTokenClaims,
  readRunTokenKey,
  RUN_TOKEN_MAX_TTL_MS,
  RUN_TOKEN_STATIC_MAX_TTL_MS,
  type RunTokenKey,
  verifyRunToken,
} from "./run-token";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const HOST = "tch_0123456789abcdefghijkl";

function mint(overrides: Partial<Parameters<typeof mintRunToken>[0]> = {}) {
  return mintRunToken({
    key,
    host: HOST,
    harness: "claude-code",
    provider: "anthropic",
    placement: "helper",
    now: NOW,
    ...overrides,
  });
}

let key = generateRunTokenKey();
beforeEach(() => {
  key = generateRunTokenKey();
});

/** A token in the published shape over `text`, signed the way the codec signs. */
function tokenOver(text: string, signer: RunTokenKey = key): string {
  const sig = createHmac("sha256", signer.bytes).update(text, "utf8").digest();
  return `oxrt_${Buffer.from(text, "utf8").toString("base64url")}.${sig.toString("base64url")}`;
}

const verify = (token: string, now = NOW) =>
  verifyRunToken(token, { key, host: HOST, provider: "anthropic", now });

describe("a run token", () => {
  it("is signed, carries its claims, and verifies for its host and provider", () => {
    const { token, claims } = mint();
    expect(token.startsWith("oxrt_")).toBe(true);
    expect(looksLikeRunToken(token)).toBe(true);
    expect(claims.tid).toMatch(/^rt_[0-9a-f]{20}$/);
    expect(claims.exp - claims.iat).toBe(RUN_TOKEN_MAX_TTL_MS);
    const verdict = verifyRunToken(token, {
      key,
      host: HOST,
      provider: "anthropic",
      now: NOW + 60_000,
    });
    expect(verdict).toEqual({ ok: true, claims });
    // The claims are readable without the key, and say nothing secret.
    expect(peekRunTokenClaims(token)).toEqual(claims);
    expect(JSON.stringify(claims)).not.toContain("secret");
  });

  it("caps the life a caller asks for at fifteen minutes, and lets it ask for less", () => {
    expect(mint({ ttlMs: 60 * 60_000 }).claims.exp - NOW).toBe(
      RUN_TOKEN_MAX_TTL_MS,
    );
    expect(mint({ ttlMs: 30_000 }).claims.exp - NOW).toBe(30_000);
    expect(() => mint({ ttlMs: 0 })).toThrow(/positive/);
  });

  it("bounds a static placement by the enrollment's expiry", () => {
    const enrollmentEnds = NOW + 3 * 24 * 60 * 60_000;
    const stat = mint({
      harness: "codex",
      provider: "openai",
      placement: "static",
      notAfter: enrollmentEnds,
    });
    expect(stat.claims.exp).toBe(enrollmentEnds);
    const open = mint({ placement: "static" });
    expect(open.claims.exp - NOW).toBe(RUN_TOKEN_STATIC_MAX_TTL_MS);
    expect(() => mint({ placement: "static", notAfter: NOW - 1 })).toThrow(
      /already be expired/,
    );
  });

  it("lets a static placement be shortened too, and caps it at its own ceiling", () => {
    expect(mint({ placement: "static", ttlMs: 60_000 }).claims.exp - NOW).toBe(
      60_000,
    );
    expect(
      mint({ placement: "static", ttlMs: 10 * RUN_TOKEN_STATIC_MAX_TTL_MS })
        .claims.exp - NOW,
    ).toBe(RUN_TOKEN_STATIC_MAX_TTL_MS);
    // The enrollment's expiry still wins over a shorter ask when it is sooner.
    expect(
      mint({ placement: "static", ttlMs: 60_000, notAfter: NOW + 1_000 }).claims
        .exp,
    ).toBe(NOW + 1_000);
    for (const ttlMs of [Number.POSITIVE_INFINITY, Number.NaN, -1])
      expect(() => mint({ ttlMs })).toThrow(/positive/);
  });

  it("is refused once expired, and the refusal names the token", () => {
    const { token, claims } = mint({ ttlMs: 1_000 });
    const verdict = verifyRunToken(token, {
      key,
      host: HOST,
      provider: "anthropic",
      now: NOW + 1_000,
    });
    expect(verdict).toEqual({
      ok: false,
      code: "run_token_expired",
      claims,
    });
  });

  it("is refused for another host or another provider", () => {
    const { token } = mint();
    expect(
      verifyRunToken(token, {
        key,
        host: "tch_zzzzzzzzzzzzzzzzzzzzzz",
        provider: "anthropic",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "run_token_mismatch" });
    expect(
      verifyRunToken(token, {
        key,
        host: HOST,
        provider: "openai",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "run_token_mismatch" });
  });

  it("is refused under another key, with a bit flipped, or re-encoded", () => {
    const { token, claims } = mint();
    const other = generateRunTokenKey();
    expect(
      verifyRunToken(token, {
        key: other,
        host: HOST,
        provider: "anthropic",
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "run_token_invalid", claims });
    const [body, sig] = token.slice("oxrt_".length).split(".") as [
      string,
      string,
    ];
    const flipped = `oxrt_${body}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect(
      verifyRunToken(flipped, {
        key,
        host: HOST,
        provider: "anthropic",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "run_token_invalid" });
    // The last character of a 32-byte signature carries two padding bits the
    // decoder ignores. Every other spelling of those bits decodes to the same
    // bytes, and each one is refused.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(sig.at(-1) as string);
    const respelled = [0, 1, 2, 3]
      .map((low) => alphabet[(last & ~3) | low] as string)
      .filter((c) => c !== sig.at(-1));
    expect(respelled).toHaveLength(3);
    for (const c of respelled)
      expect(
        verifyRunToken(`oxrt_${body}.${sig.slice(0, -1)}${c}`, {
          key,
          host: HOST,
          provider: "anthropic",
          now: NOW,
        }),
      ).toMatchObject({ ok: false, code: "run_token_invalid" });
    // The same claims with a longer life, signed by nobody.
    const forged = `oxrt_${Buffer.from(
      JSON.stringify({ ...claims, exp: claims.exp + 10 ** 9 }),
    ).toString("base64url")}.${sig}`;
    expect(
      verifyRunToken(forged, {
        key,
        host: HOST,
        provider: "anthropic",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "run_token_invalid" });
  });

  it("refuses anything that is not shaped like a token", () => {
    for (const junk of [
      "",
      "sk-ant-api03-real-key",
      "oxrt_",
      "oxrt_abc",
      "oxrt_.sig",
      "oxrt_abc.",
      `oxrt_${"a".repeat(2048)}.sig`,
    ])
      expect(
        verifyRunToken(junk, {
          key,
          host: HOST,
          provider: "anthropic",
          now: NOW,
        }),
      ).toEqual({ ok: false, code: "run_token_malformed" });
    expect(looksLikeRunToken("sk-ant-api03-real-key")).toBe(false);
    expect(peekRunTokenClaims("oxrt_notbase64.sig")).toBeUndefined();
  });

  it("refuses a token this key signed whose claims are not claims, or are not canonical", () => {
    // The signature holds, so the refusal is the codec's own reading of the
    // text, never the vendor's: a signed blob that is not JSON, or JSON that
    // is not a claim set, is malformed.
    expect(verify(tokenOver("not json"))).toEqual({
      ok: false,
      code: "run_token_malformed",
    });
    expect(verify(tokenOver(JSON.stringify({ v: 1 })))).toEqual({
      ok: false,
      code: "run_token_malformed",
    });
    // The same claims in a different key order carry a valid signature over
    // that text, and are refused: the signature is over the canonical form.
    const { claims } = mint();
    const shuffled = JSON.stringify(
      Object.fromEntries(Object.entries(claims).reverse()),
    );
    expect(verify(tokenOver(shuffled))).toEqual({
      ok: false,
      code: "run_token_invalid",
    });
    // An unknown claim is not admitted either, however it was signed.
    expect(
      verify(tokenOver(JSON.stringify({ ...claims, scope: "everything" }))),
    ).toEqual({ ok: false, code: "run_token_malformed" });
  });

  it("peeks claims off a token without trusting them, and reads junk as no claims", () => {
    const { token, claims } = mint();
    // A forgery under another key still yields its claims to a peek: the
    // refusal frame cites the id, and only verify decides.
    const forged = tokenOver(JSON.stringify(claims), generateRunTokenKey());
    expect(peekRunTokenClaims(forged)).toEqual(claims);
    expect(verify(forged)).toMatchObject({
      ok: false,
      code: "run_token_invalid",
      claims,
    });
    expect(peekRunTokenClaims(token.slice(0, token.indexOf(".")))).toBe(
      undefined,
    );
    for (const text of ["not json", "[]", JSON.stringify({ v: 2 })])
      expect(
        peekRunTokenClaims(
          `oxrt_${Buffer.from(text).toString("base64url")}.sig`,
        ),
      ).toBeUndefined();
    expect(peekRunTokenClaims("")).toBeUndefined();
  });
});

describe("the signing key file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-token-key-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is created once, mode 0600, read back, and refuses a token another key signed", () => {
    const path = join(dir, "run-token.key");
    expect(readRunTokenKey(path)).toBeUndefined();
    const first = loadOrCreateRunTokenKey(path);
    expect(first.created).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    const again = loadOrCreateRunTokenKey(path);
    expect(again.created).toBe(false);
    expect(again.key.id).toBe(first.key.id);
    expect(readRunTokenKey(path)?.id).toBe(first.key.id);

    const { token } = mintRunToken({
      key: first.key,
      host: HOST,
      harness: "codex",
      provider: "openai",
      placement: "static",
      now: NOW,
    });
    // A fresh key refuses every token the old one signed: this is what
    // deleting the key file at unenroll relies on.
    const other = generateRunTokenKey();
    expect(other.id).not.toBe(first.key.id);
    expect(
      verifyRunToken(token, {
        key: other,
        host: HOST,
        provider: "openai",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "run_token_invalid" });
  });

  it("refuses a key file that does not hold a key, and never replaces it with a fresh one", () => {
    const path = join(dir, "run-token.key");
    rmSync(path, { force: true });
    writeFileSync(path, "not a key\n");
    expect(() => readRunTokenKey(path)).toThrow(/64 hex/);
    // The daemon's load-or-create must not read a damaged key as absent: a
    // silently minted replacement would refuse every token in flight with no
    // word about why.
    expect(() => loadOrCreateRunTokenKey(path)).toThrow(/64 hex/);
    expect(readFileSync(path, "utf8")).toBe("not a key\n");
  });

  it("reads a key however the hex is cased or padded with whitespace", () => {
    const path = join(dir, "run-token.key");
    const { key: written } = loadOrCreateRunTokenKey(path);
    writeFileSync(
      path,
      `  ${readFileSync(path, "utf8").trim().toUpperCase()}\n\n`,
    );
    expect(readRunTokenKey(path)?.id).toBe(written.id);
  });
});
