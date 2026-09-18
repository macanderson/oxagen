/**
 * Frame bodies on the host (Mission Control spec §8.2; tacho spec §2 "Bodies
 * are digested, content is governed"). The chain carries a digest of every
 * prompt, tool input, tool result and assistant message; the bytes those
 * digests name ride next to their events as `bodies[]` in the same ingest
 * batch, and the control plane verifies each one against the digest the
 * event chained before it keeps them.
 *
 * Three rules are settled here so the recorder, the WAL and the shipper
 * agree on them:
 *
 * 1. Redaction runs before the digest. The control plane refuses any body its
 *    own detectors would redact, so the host must have already cut the
 *    secret out, and `content.digest` must name the bytes it ships, not the
 *    bytes the harness handed it. The cut is recorded per frame as
 *    `{ path, reason, original_digest }`, so an auditor holding the original
 *    can still prove what was removed.
 * 2. A body over `TACHO_MAX_BODY_BYTES` is not shipped. The digest stays on
 *    the chain and the event says why the bytes are missing
 *    (`attrs["body_omitted"]`), so a replay reads the gap as a size limit
 *    rather than as a host that never captured.
 * 3. Retention is the workspace's decision, not the host's. The bundle names
 *    a mode and the content classes it retains exact bytes for; a body is
 *    only attached when the mode is `content_exact` and the frame's class is
 *    listed. The server enforces the mode as well, and refuses harmlessly
 *    when the two disagree, so a bundle the host has not fetched yet costs
 *    nothing but one refused body.
 */
import { digestBytes, type Sha256Digest } from "../digest";
import { type PolicyBundle, TACHO_MAX_BODY_BYTES } from "../wire";
import { type Redaction, redactBytes } from "./redaction";

/**
 * The most redactions one event may record (`contentSchema` caps the list at
 * 256). A body that needs more is not shipped at all: truncating the list
 * would chain a record that says less was removed than was.
 */
export const TACHO_MAX_REDACTIONS = 256;

/** What a hook draft hands the recorder: the bytes before redaction. */
export interface DraftContent {
  content_type: string;
  bytes: Uint8Array;
}

/** A body the recorder holds for an event until the batch it ships in is built. */
export interface FrameBody {
  event_id_idem: string;
  /** The chain the event is on, so the WAL files the body beside it. */
  session_uuid: string;
  seq: number;
  content_type: string;
  bytes: Uint8Array;
  /** The retention class the daemon checks the bundle against. */
  content_class: RetentionContentClass;
}

/**
 * The retention classes a frame body can fall under, spelled exactly as
 * `RETENTION_CONTENT_CLASSES` in `@oxagen/run-ledger` spells them: the bundle
 * copies that list into `retention.classes`, and a class this host spells
 * differently is a body that never ships.
 */
export type RetentionContentClass =
  | "model_call"
  | "tool_call"
  | "approval_receipt";

/**
 * The retention class of an event kind's body. Prompts, assistant messages
 * and subagent results are model traffic; tool requests and results are tool
 * traffic; a permission request is an approval receipt. Anything else has no
 * body to classify.
 */
export function contentClassOf(
  kind: string,
): RetentionContentClass | undefined {
  switch (kind) {
    case "turn_start":
    case "turn_end":
    case "oxagen:message":
    case "subagent_stop":
    case "llm_call":
      return "model_call";
    case "tool_requested":
    case "tool_call":
    case "token_denied":
      return "tool_call";
    case "approval_request":
      return "approval_receipt";
    default:
      return undefined;
  }
}

/** Whether the bundle's retention clause lets a body of this class ship. */
export function retentionAllows(
  retention: PolicyBundle["retention"],
  contentClass: RetentionContentClass,
): boolean {
  return (
    retention.mode === "content_exact" &&
    retention.classes.includes(contentClass)
  );
}

/**
 * What the recorder chains for a frame, and the body it holds for it. The
 * digest, when there is one, is always the digest of the redacted bytes,
 * whether or not they ship, so the chain never names bytes that carry a
 * secret. A body that needs more redactions than one event can record gets
 * no digest at all: chaining one over a shorter list would say less was
 * removed than was.
 */
export type PreparedContent =
  | {
      digest: Sha256Digest;
      redactions: Redaction[];
      body: { content_type: string; bytes: Uint8Array };
      omitted?: undefined;
    }
  | {
      digest: Sha256Digest;
      redactions: Redaction[];
      body?: undefined;
      omitted: "too_large";
    }
  | { digest?: undefined; body?: undefined; omitted: "too_many_redactions" };

/** Redact, size-check and digest a draft's content. */
export function prepareContent(content: DraftContent): PreparedContent {
  const { bytes, redactions } = redactBytes(content.bytes);
  if (redactions.length > TACHO_MAX_REDACTIONS) {
    return { omitted: "too_many_redactions" };
  }
  const digest = digestBytes(bytes);
  if (bytes.byteLength > TACHO_MAX_BODY_BYTES) {
    return { digest, redactions, omitted: "too_large" };
  }
  return {
    digest,
    redactions,
    body: { content_type: content.content_type, bytes },
  };
}

const encoder = new TextEncoder();

/** UTF-8 text as draft content. */
export function textContent(text: string): DraftContent {
  return {
    content_type: "text/plain; charset=utf-8",
    bytes: encoder.encode(text),
  };
}

/** Canonical JSON text (already JCS) as draft content. */
export function jsonContent(canonical: string): DraftContent {
  return { content_type: "application/json", bytes: encoder.encode(canonical) };
}
