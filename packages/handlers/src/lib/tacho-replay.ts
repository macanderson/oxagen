// tacho-replay.ts — the pure half of the wrapped-agent recorder (ADR-058):
// which shipped bodies the control plane accepts, and the replay grade a
// session seals with.
//
// A host redacts and digests a body before it chains `content.digest`, so the
// control plane is a verifier here: the bytes must hash to the digest the
// chain commits to, and they must carry nothing the platform's own detectors
// would redact. A body that fails either test is refused and the frame is
// recorded without one; the response names the refusal so the host can
// correct its collector, and the session seals with a `body_missing` gap.
import {
  digestBytes,
  isContentBearingFrame,
  redactBytes,
  type TachoBody,
  type TachoEvent,
} from "@oxagen/tacho";
import type { TachoEventsIngestOutput } from "@oxagen/oxagen/contracts/tacho.events.ingest";

export type BodyRejection = TachoEventsIngestOutput["body_rejections"][number];

export interface VerifiedBody {
  eventIdIdem: string;
  sessionUuid: string;
  /** The event's kind: the seal counts tool result bodies from it. */
  kind: string;
  digest: string;
  contentType: string;
  bytes: Uint8Array;
}

interface BodyVerification {
  accepted: VerifiedBody[];
  rejected: BodyRejection[];
}

/**
 * Check every shipped body against the batch: it names an event in the
 * batch, that event chained a content digest, the bytes hash to it, and the
 * bytes carry no credential. Order is preserved; one body per event, a
 * second body for the same event is refused as a duplicate digest mismatch
 * only if it differs, and ignored when identical.
 */
export function verifyBatchBodies(
  events: readonly TachoEvent[],
  bodies: readonly TachoBody[] | undefined,
): BodyVerification {
  const accepted: VerifiedBody[] = [];
  const rejected: BodyRejection[] = [];
  if (!bodies || bodies.length === 0) return { accepted, rejected };
  const byIdem = new Map(events.map((event) => [event.event_id_idem, event]));
  const seen = new Set<string>();
  for (const body of bodies) {
    const event = byIdem.get(body.event_id_idem);
    if (!event) {
      rejected.push({
        event_id_idem: body.event_id_idem,
        reason: "unknown_event",
      });
      continue;
    }
    const digest = event.content?.digest;
    if (!digest) {
      rejected.push({
        event_id_idem: body.event_id_idem,
        reason: "no_content_digest",
      });
      continue;
    }
    const bytes = new Uint8Array(Buffer.from(body.bytes_base64, "base64"));
    if (digestBytes(bytes) !== digest) {
      rejected.push({
        event_id_idem: body.event_id_idem,
        reason: "digest_mismatch",
      });
      continue;
    }
    if (redactBytes(bytes).redactions.length > 0) {
      rejected.push({
        event_id_idem: body.event_id_idem,
        reason: "credential_detected",
      });
      continue;
    }
    if (seen.has(body.event_id_idem)) continue;
    seen.add(body.event_id_idem);
    accepted.push({
      eventIdIdem: body.event_id_idem,
      sessionUuid: event.session_uuid,
      kind: event.kind,
      digest,
      contentType: body.content_type,
      bytes,
    });
  }
  return { accepted, rejected };
}

/**
 * How many events in a batch carried content: a content-bearing kind
 * (`isContentBearingFrame`: `llm_call`, `tool_call`), whether or not the
 * host chained a digest for it, or any other kind that did. A body is only
 * accepted for an event that chained a digest, so a session's body count
 * never exceeds this one.
 */
export function countContentFrames(events: readonly TachoEvent[]): number {
  return events.filter(
    (event) =>
      event.content?.digest !== undefined || isContentBearingFrame(event.kind),
  ).length;
}

/**
 * The seal grading for a wrapped session lives beside the grade it computes,
 * in `@oxagen/tacho`, so ingest and the control plane's idle close
 * (`tacho.session-idle-close`) grade a session with the same rule.
 */
export { sealTachoSession } from "@oxagen/tacho";
