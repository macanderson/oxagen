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
import { MAX_CONTENT_REDACTIONS } from "../envelope";
import { type PolicyBundle, TACHO_MAX_BODY_BYTES } from "../wire";
import { type Redaction, redactBytes } from "./redaction";
import {
  RETENTION_CLASS_BY_KIND,
  type RetentionContentClass,
} from "./retention";

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
export type { RetentionContentClass } from "./retention";

/**
 * The retention class of an event kind's body. Prompts, assistant messages
 * and subagent results are model traffic; tool requests and results are tool
 * traffic; a permission request is an approval receipt. Anything else has no
 * body to classify.
 *
 * This reads `RETENTION_CLASS_BY_KIND` rather than restating it. The host
 * asks this function whether to write a body and the control plane asks
 * `retainsBody` whether to accept one, so the two answers have to come from
 * the same table. When they were separate tables one fell behind, and the
 * host spent a turn writing bodies the control plane then refused.
 */
export function contentClassOf(
  kind: string,
): RetentionContentClass | undefined {
  return RETENTION_CLASS_BY_KIND[kind];
}

/**
 * Whether the bundle's retention clause lets a body of this class ship.
 *
 * The clause is taken structurally rather than as `PolicyBundle["retention"]`
 * so that a caller holding a narrowed one (the daemon substitutes a
 * keep-nothing mandate while the cached bundle does not verify) passes the
 * same function what the bundle would.
 */
export function retentionAllows(
  retention: {
    mode: PolicyBundle["retention"]["mode"];
    classes: readonly string[];
  },
  contentClass: RetentionContentClass,
): boolean {
  return (
    retention.mode === "content_exact" &&
    retention.classes.includes(contentClass)
  );
}

/** The digest names redacted bytes, including when size prevents shipment. */
export type PreparedContent = {
  digest: Sha256Digest;
  redactions: Redaction[];
  redactionsTotal: number;
} & (
  | {
      body: { content_type: string; bytes: Uint8Array };
      omitted?: undefined;
    }
  | {
      body?: undefined;
      omitted: "too_large";
    }
);

/** Redact every match, bound the detail list, and digest the resulting bytes. */
export function prepareContent(content: DraftContent): PreparedContent {
  const { bytes, redactions } = redactBytes(content.bytes);
  const evidence = {
    digest: digestBytes(bytes),
    redactions: redactions.slice(0, MAX_CONTENT_REDACTIONS),
    redactionsTotal: redactions.length,
  };
  if (bytes.byteLength > TACHO_MAX_BODY_BYTES) {
    return { ...evidence, omitted: "too_large" };
  }
  return {
    ...evidence,
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
