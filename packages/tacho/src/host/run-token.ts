/**
 * Run tokens: the one credential a brokered harness holds (Mission Control
 * spec §6.2 and §6.8, ADR-143).
 *
 * A wrapped harness on the brokered credential path never sees its model
 * vendor's key. It is given a run token instead, and it presents that token
 * where it used to present the key: Claude Code's `apiKeyHelper` prints one
 * and Claude Code sends it as `X-Api-Key`; Codex reads one from `auth.json`
 * and sends it as `Authorization: Bearer`. The loopback model proxy verifies
 * the token, takes it off the request, and attaches the vendor credential it
 * holds in custody (`credential-store.ts`). A run token is good for talking
 * to the gateway on this machine and for nothing else: the vendor refuses it,
 * and every other machine's gateway refuses it, because the key that signs it
 * never leaves this host.
 *
 * ## Shape
 *
 *     oxrt_<base64url(JCS claims)>.<base64url(HMAC-SHA256)>
 *
 * The claims name the host enrollment, the harness, the model provider the
 * token may be spent at, when it was minted and when it expires, and a token
 * id so a frame can cite a token without carrying it. Nothing in the claims
 * is secret; the signature is what makes the token one this gateway minted.
 *
 * ## Life
 *
 * The default life is fifteen minutes, the ceiling the specification sets
 * for a run token (§6.2) and the one the ARP design publishes for a
 * credential lease. A caller may ask for less and never for more. Claude Code
 * re-runs its helper on a five-minute cadence and on any 401, so a token
 * expires well before a session does and is refreshed without a restart. A
 * harness with no helper mechanism (Codex reads a static value) is issued a
 * `static` token whose life is bounded by the enrollment's own expiry; the
 * proxy still checks host status and revocation on every call, so a static
 * token dies with the enrollment even though its expiry is later.
 *
 * ## Revocation
 *
 * The signing key lives in one file, and a token is only ever as good as
 * that key: unenroll deletes the file after custody is shredded, so every
 * token this host issued is refused from the next call on, and a host
 * `revoke` reaches the proxy through `host_status` on the same request
 * path, so a revoked host refuses a valid token too.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { jcs } from "../digest";
import { writeSensitiveFileAtomic } from "./fs";

export const RUN_TOKEN_PREFIX = "oxrt_" as const;

/** Fifteen minutes: spec §6.2's default run token life, and the ceiling. */
export const RUN_TOKEN_MAX_TTL_MS = 15 * 60_000;
export const RUN_TOKEN_DEFAULT_TTL_MS = RUN_TOKEN_MAX_TTL_MS;

/** A static placement lives at most this long past its minting. */
export const RUN_TOKEN_STATIC_MAX_TTL_MS = 30 * 24 * 60 * 60_000;

/** The model providers a run token can be spent at. */
export const RUN_TOKEN_PROVIDERS = ["anthropic", "openai"] as const;
export type RunTokenProvider = (typeof RUN_TOKEN_PROVIDERS)[number];

/**
 * Where the harness keeps the token. `helper` is re-fetched by the harness
 * on a cadence (Claude Code's `apiKeyHelper`); `static` is written once into
 * a file the harness reads (Codex's `auth.json`).
 */
export const RUN_TOKEN_PLACEMENTS = ["helper", "static"] as const;
export type RunTokenPlacement = (typeof RUN_TOKEN_PLACEMENTS)[number];

export const runTokenClaimsSchema = z
  .object({
    v: z.literal(1),
    /** `rt_` + 20 hex: cited on frames in place of the token. */
    tid: z.string().regex(/^rt_[0-9a-f]{20}$/),
    /** The host enrollment the token was minted for. */
    host: z.string().min(1).max(64),
    /** The harness it was handed to. */
    harness: z.string().min(1).max(32),
    provider: z.enum(RUN_TOKEN_PROVIDERS),
    placement: z.enum(RUN_TOKEN_PLACEMENTS),
    /** Epoch milliseconds. */
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type RunTokenClaims = z.output<typeof runTokenClaimsSchema>;

const KEY_BYTES = 32;

/** The secret that signs this host's run tokens: 32 random bytes, hex. */
export interface RunTokenKey {
  readonly bytes: Buffer;
  /** First 16 hex of sha256 over the key, for a frame or a log line. */
  readonly id: string;
}

function keyFromBytes(bytes: Buffer): RunTokenKey {
  if (bytes.length !== KEY_BYTES)
    throw new Error(
      `run token key must be ${KEY_BYTES} bytes, got ${bytes.length}`,
    );
  const id = createHmac("sha256", "tacho.run-token-key-id")
    .update(bytes)
    .digest("hex")
    .slice(0, 16);
  return { bytes, id };
}

export function generateRunTokenKey(): RunTokenKey {
  return keyFromBytes(randomBytes(KEY_BYTES));
}

export function runTokenKeyFromHex(hex: string): RunTokenKey {
  const trimmed = hex.trim();
  if (!/^[0-9a-f]{64}$/i.test(trimmed))
    throw new Error("run token key file does not hold 64 hex characters");
  return keyFromBytes(Buffer.from(trimmed, "hex"));
}

/** Load the key at `path`, generating and persisting one when absent. */
export function loadOrCreateRunTokenKey(path: string): {
  key: RunTokenKey;
  created: boolean;
} {
  try {
    return {
      key: runTokenKeyFromHex(readFileSync(path, "utf8")),
      created: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = generateRunTokenKey();
  writeSensitiveFileAtomic(path, `${key.bytes.toString("hex")}\n`);
  return { key, created: true };
}

/** Read the key at `path`, or undefined when there is none. */
export function readRunTokenKey(path: string): RunTokenKey | undefined {
  try {
    return runTokenKeyFromHex(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sign(key: RunTokenKey, claimsText: string): Buffer {
  return createHmac("sha256", key.bytes).update(claimsText, "utf8").digest();
}

export interface MintRunTokenOptions {
  key: RunTokenKey;
  host: string;
  harness: string;
  provider: RunTokenProvider;
  placement: RunTokenPlacement;
  now: number;
  /**
   * How long the token should live. Clamped to the placement's ceiling: a
   * caller may shorten a token and never lengthen one past what the gateway
   * publishes (the defect the ARP audit named: a caller-chosen expiry let the
   * caller mint a long-lived credential).
   */
  ttlMs?: number;
  /** Static placements only: the enrollment's expiry, which bounds the token. */
  notAfter?: number;
}

export interface MintedRunToken {
  token: string;
  claims: RunTokenClaims;
}

export function mintRunToken(options: MintRunTokenOptions): MintedRunToken {
  const ceiling =
    options.placement === "static"
      ? RUN_TOKEN_STATIC_MAX_TTL_MS
      : RUN_TOKEN_MAX_TTL_MS;
  const asked =
    options.ttlMs === undefined
      ? options.placement === "static"
        ? RUN_TOKEN_STATIC_MAX_TTL_MS
        : RUN_TOKEN_DEFAULT_TTL_MS
      : options.ttlMs;
  if (!Number.isFinite(asked) || asked <= 0)
    throw new Error(`run token ttl must be positive, got ${String(asked)}`);
  let exp = options.now + Math.min(asked, ceiling);
  if (options.notAfter !== undefined) exp = Math.min(exp, options.notAfter);
  if (exp <= options.now)
    throw new Error("run token would already be expired when minted");
  const claims: RunTokenClaims = {
    v: 1,
    tid: `rt_${randomBytes(10).toString("hex")}`,
    host: options.host,
    harness: options.harness,
    provider: options.provider,
    placement: options.placement,
    iat: options.now,
    exp,
  };
  const text = jcs(claims);
  const token = `${RUN_TOKEN_PREFIX}${b64url(Buffer.from(text, "utf8"))}.${b64url(sign(options.key, text))}`;
  return { token, claims };
}

/** Whether a header value is shaped like a run token, before any check. */
export function looksLikeRunToken(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(RUN_TOKEN_PREFIX) &&
    value.length < 2048
  );
}

/**
 * The claims of a token without checking its signature, for a refusal frame
 * that wants to cite the token id it refused. Never trust these for a
 * decision: `verifyRunToken` is the only path that admits a call.
 */
export function peekRunTokenClaims(token: string): RunTokenClaims | undefined {
  if (!looksLikeRunToken(token)) return undefined;
  const body = token.slice(RUN_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(body.slice(0, dot), "base64url").toString("utf8"),
    );
    const claims = runTokenClaimsSchema.safeParse(parsed);
    return claims.success ? claims.data : undefined;
  } catch {
    return undefined;
  }
}

export type RunTokenRefusal =
  | "run_token_malformed"
  | "run_token_invalid"
  | "run_token_expired"
  | "run_token_mismatch";

export type RunTokenVerdict =
  | { ok: true; claims: RunTokenClaims }
  | { ok: false; code: RunTokenRefusal; claims?: RunTokenClaims };

export interface VerifyRunTokenOptions {
  key: RunTokenKey;
  /** The host enrollment the proxy serves; a token for another is refused. */
  host: string;
  /** The provider the request is for; a token for another is refused. */
  provider: RunTokenProvider;
  now: number;
}

export function verifyRunToken(
  token: string,
  options: VerifyRunTokenOptions,
): RunTokenVerdict {
  if (!looksLikeRunToken(token))
    return { ok: false, code: "run_token_malformed" };
  const body = token.slice(RUN_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1)
    return { ok: false, code: "run_token_malformed" };
  const bodyText = body.slice(0, dot);
  let text: string;
  try {
    text = Buffer.from(bodyText, "base64url").toString("utf8");
  } catch {
    return { ok: false, code: "run_token_malformed" };
  }
  // Compare the signature as the canonical base64url text, not as decoded
  // bytes. The last character of a 32-byte signature carries two padding bits
  // the decoder ignores, so a byte comparison admits up to four spellings of
  // one token. The same holds for the claims segment, so it must round-trip too.
  const presented = Buffer.from(body.slice(dot + 1), "utf8");
  const expected = Buffer.from(
    sign(options.key, text).toString("base64url"),
    "utf8",
  );
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected) ||
    Buffer.from(text, "utf8").toString("base64url") !== bodyText
  ) {
    // The claims are readable whether or not the signature holds; a refusal
    // frame may cite the id, and nothing else, of a token it did not admit.
    return { ok: false, code: "run_token_invalid", ...peeked(text) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "run_token_malformed" };
  }
  const claims = runTokenClaimsSchema.safeParse(parsed);
  if (!claims.success) return { ok: false, code: "run_token_malformed" };
  // The signature covers the canonical text and nothing else, so a token
  // whose claims were re-encoded non-canonically is refused too.
  if (jcs(claims.data) !== text)
    return { ok: false, code: "run_token_invalid" };
  if (claims.data.exp <= options.now)
    return { ok: false, code: "run_token_expired", claims: claims.data };
  if (
    claims.data.host !== options.host ||
    claims.data.provider !== options.provider
  )
    return { ok: false, code: "run_token_mismatch", claims: claims.data };
  return { ok: true, claims: claims.data };
}

function peeked(text: string): { claims?: RunTokenClaims } {
  try {
    const claims = runTokenClaimsSchema.safeParse(JSON.parse(text));
    return claims.success ? { claims: claims.data } : {};
  } catch {
    return {};
  }
}
