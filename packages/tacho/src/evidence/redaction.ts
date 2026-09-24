/**
 * Redaction before write (Mission Control spec §8.2, §13.5: "Redaction runs
 * before the bytes are written. It is recorded per frame with the digest of
 * what was removed. A redacted body can therefore still be verified against
 * its digest.").
 *
 * The detectors match credential shapes with a fixed, recognisable prefix,
 * so a match is a secret with very high likelihood and a miss is never
 * reported as safety. Each removal is replaced by a marker naming its reason
 * and recorded as `{ path, reason, original_digest }`: `path` is the UTF-8
 * byte span in the original bytes, `original_digest` the sha256 of the bytes
 * removed, so an auditor holding the original can prove what was cut without
 * this module holding the secret.
 *
 * Bytes that are not valid UTF-8 are passed through untouched: the detectors
 * are textual, and rewriting a binary body would corrupt it.
 */
import { digestBytes, type Sha256Digest } from "../digest";

export interface Redaction {
  /** `bytes:<start>-<end>`, a half-open UTF-8 byte span in the original. */
  path: string;
  reason: RedactionReason;
  original_digest: Sha256Digest;
}

interface RedactionResult {
  bytes: Uint8Array;
  redactions: Redaction[];
}

export type RedactionReason =
  | "private_key"
  | "aws_access_key"
  | "github_token"
  | "gitlab_token"
  | "slack_token"
  | "model_api_key"
  | "google_api_key"
  | "stripe_key"
  | "npm_token"
  | "oxagen_api_key"
  | "oxagen_run_token"
  | "bearer_token"
  | "jwt";

interface Detector {
  reason: RedactionReason;
  pattern: RegExp;
  /** The capture group that holds the secret; the whole match by default. */
  group?: number;
}

/** PEM (`RSA PRIVATE KEY`, `OPENSSH PRIVATE KEY`, ...) and PGP armor labels. */
const PRIVATE_KEY_LABEL = "[A-Z ]*PRIVATE KEY(?: BLOCK)?";

/**
 * The key material after a BEGIN line whose END never arrived, as when a
 * tool's output is cut off mid-key: base64 lines and armor headers
 * (`Proc-Type:`, `Version:`), separated by whitespace or by the `\n` escapes
 * of a JSON string. It stops at the first thing that is neither, so the text
 * after a truncated key is kept.
 */
const TRUNCATED_KEY_BODY =
  '(?:(?:\\s|\\\\[rn])+(?:[A-Za-z][A-Za-z-]*: (?:[^\\r\\n\\\\"]|\\\\")*|[A-Za-z0-9+/=]+))*';

/** A base64url character: what may not border a fixed-length token. */
const B64URL = "[A-Za-z0-9_-]";

const DETECTORS: readonly Detector[] = [
  {
    // A complete block runs to its END line. The scan for END stops at the
    // next BEGIN, so a truncated key cannot swallow the text up to a later
    // key's END, and many truncated keys stay linear rather than each
    // scanning to the end of the text.
    reason: "private_key",
    pattern: new RegExp(
      `-----BEGIN ${PRIVATE_KEY_LABEL}-----(?:(?:(?!-----BEGIN )[\\s\\S])*?-----END ${PRIVATE_KEY_LABEL}-----|${TRUNCATED_KEY_BODY})`,
      "g",
    ),
  },
  { reason: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    reason: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  { reason: "gitlab_token", pattern: /\bglpat-[0-9A-Za-z_-]{20,}/g },
  { reason: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { reason: "model_api_key", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  {
    reason: "google_api_key",
    pattern: new RegExp(`\\bAIza${B64URL}{35}(?!${B64URL})`, "g"),
  },
  { reason: "stripe_key", pattern: /\b[rs]k_live_[0-9A-Za-z]{16,}\b/g },
  { reason: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    // `ox_` and the base64url of 32 bytes, as `generateApiKey`
    // (@oxagen/handlers) mints it. The length is exact, so an identifier
    // that merely starts `ox_` does not match.
    reason: "oxagen_api_key",
    pattern: new RegExp(`(?<!${B64URL})ox_${B64URL}{43}(?!${B64URL})`, "g"),
  },
  {
    // `oxrt_<claims>.<hmac>` (host/run-token.ts). The claims are not secret,
    // but the whole token is removed: it is spendable until it expires.
    reason: "oxagen_run_token",
    pattern: new RegExp(`(?<!${B64URL})oxrt_${B64URL}{8,}\\.${B64URL}+`, "g"),
  },
  {
    // The scheme is case-insensitive (RFC 9110 §11.1), and RFC 6750's
    // b64token includes `_`: without it a token was cut at its first `_`
    // and the rest shipped in the clear.
    reason: "bearer_token",
    pattern: /\bbearer\s+([A-Za-z0-9_.~+/=-]{20,})/gi,
    group: 1,
  },
  {
    reason: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

interface Span {
  start: number;
  end: number;
  reason: RedactionReason;
}

function findSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    for (const match of text.matchAll(detector.pattern)) {
      const whole = match[0];
      const secret =
        detector.group === undefined ? whole : match[detector.group];
      if (secret === undefined) continue;
      const offset = detector.group === undefined ? 0 : whole.indexOf(secret);
      const start = (match.index ?? 0) + offset;
      spans.push({
        start,
        end: start + secret.length,
        reason: detector.reason,
      });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  // Overlapping matches (a JWT inside a bearer header) keep the earliest,
  // longest span so no byte is redacted twice.
  const kept: Span[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    kept.push(span);
    cursor = span.end;
  }
  return kept;
}

const encoder = new TextEncoder();

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function redactionMarker(reason: RedactionReason): string {
  return `[redacted:${reason}]`;
}

/**
 * Remove every credential the detectors recognise and record each removal.
 * Returns the input bytes unchanged, with no redactions, when nothing
 * matched or the bytes are not text.
 */
export function redactBytes(bytes: Uint8Array): RedactionResult {
  const text = decodeUtf8(bytes);
  if (text === null) return { bytes, redactions: [] };
  const spans = findSpans(text);
  if (spans.length === 0) return { bytes, redactions: [] };

  let out = "";
  let last = 0;
  // Bytes of the ORIGINAL text before `last`, carried forward rather than
  // recomputed. Re-encoding `text.slice(0, span.start)` for each span made
  // this quadratic in the number of matches and their distance into the
  // text, and this runs on the blocking hook path for every turn: a pasted
  // token log would hold the daemon, and every hook queued behind it, for as
  // long as it took.
  let byteStart = 0;
  const redactions: Redaction[] = [];
  for (const span of spans) {
    const kept = text.slice(last, span.start);
    out += kept;
    out += redactionMarker(span.reason);
    byteStart += encoder.encode(kept).length;
    const removed = encoder.encode(text.slice(span.start, span.end));
    redactions.push({
      path: `bytes:${byteStart}-${byteStart + removed.length}`,
      reason: span.reason,
      original_digest: digestBytes(removed),
    });
    byteStart += removed.length;
    last = span.end;
  }
  out += text.slice(last);
  return { bytes: encoder.encode(out), redactions };
}

/**
 * The same removals on a value that ships inline rather than as a body, such
 * as an event attribute: each credential is replaced by its marker. Nothing
 * is recorded, because an inline value has no byte span or digest of its
 * own to cite; the marker names the reason.
 */
export function redactText(text: string): string {
  const spans = findSpans(text);
  if (spans.length === 0) return text;
  let out = "";
  let last = 0;
  for (const span of spans) {
    out += text.slice(last, span.start) + redactionMarker(span.reason);
    last = span.end;
  }
  return out + text.slice(last);
}

/** A frame's content after redaction: what is chained, and what was cut. */
export interface ContentFrame {
  /** The digest that goes on the chain, over the redacted bytes. */
  digest: Sha256Digest;
  /** The bytes a body ships, if the workspace retains this class. */
  bytes: Uint8Array;
  redactions: Redaction[];
}

/**
 * Prepare a frame's content: redact first, then digest what is left.
 *
 * The order is not a preference. The control plane refuses a shipped body
 * whose bytes still carry a credential, and it verifies the bytes against the
 * frame's chained digest, so a digest taken before redaction can never be
 * satisfied by bytes that pass the credential check. Digesting the redacted
 * bytes in every retention mode also keeps one meaning for the digest: a host
 * that ships no body and a host that ships one chain the same value for the
 * same content.
 */
export function contentFrameOf(text: string): ContentFrame {
  const { bytes, redactions } = redactBytes(encoder.encode(text));
  return { digest: digestBytes(bytes), bytes, redactions };
}
