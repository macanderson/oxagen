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
  rotateRunTokenKey,
  RUN_TOKEN_MAX_TTL_MS,
  RUN_TOKEN_STATIC_MAX_TTL_MS,
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
    const flipped = `oxrt_${body}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    expect(
      verifyRunToken(flipped, {
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
});

describe("the signing key file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-token-key-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is created once, mode 0600, read back, and rotated to kill every token", () => {
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
    const rotated = rotateRunTokenKey(path);
    expect(rotated.id).not.toBe(first.key.id);
    expect(
      verifyRunToken(token, {
        key: rotated,
        host: HOST,
        provider: "openai",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "run_token_invalid" });
  });

  it("refuses a key file that does not hold a key", () => {
    const path = join(dir, "run-token.key");
    rmSync(path, { force: true });
    writeFileSync(path, "not a key\n");
    expect(() => readRunTokenKey(path)).toThrow(/64 hex/);
  });
});
