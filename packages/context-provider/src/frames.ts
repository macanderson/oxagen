/**
 * One engram memory record, rendered as one Context Graph Protocol frame.
 *
 * Everything here is pure: a record and a score in, a frame out, no store and
 * no clock. That is what lets the honesty rules the protocol cares about —
 * `token_cost`, the two digests, the provenance chain — be checked by a unit
 * test rather than by reading a live provider's output and hoping.
 *
 * ## The two digests are different hashes of different bytes
 *
 * `canonical_content_hash` is the record's own id, which engram computes as
 * `sha256(kind + namespace + body)` — a hash of the SOURCE. `content_digest`
 * is a hash of the bytes this frame actually carries, which is the rendered
 * text, not the body. They are equal only by coincidence and the spec keeps
 * them apart on purpose: a host holding a frame verifies the bytes it was
 * given, while the record it came from is identified by the other one.
 */
import { createHash } from "node:crypto";
import {
  budgetTokens,
  type ContextFrame,
  type Provenance as FrameProvenance,
} from "@contextgraphprotocol/typescript-sdk";
import type { MemoryRecord } from "@oxagen/engram";
import { frameKindOf } from "./kinds";

/** The scheme this provider addresses its records under. */
export const FRAME_URI_SCHEME = "engram";

/** A stable, workspace-scoped address for one record. */
export function frameUri(record: MemoryRecord): string {
  const { org, workspace } = record.namespace;
  return `${FRAME_URI_SCHEME}://${encodeURIComponent(org)}/${encodeURIComponent(
    workspace,
  )}/${record.id}`;
}

/**
 * The text a frame carries for a record.
 *
 * A record's `body` is `unknown` — its shape follows its kind — so a string
 * body is carried as itself and anything else is serialized. Serialization is
 * deterministic (sorted keys) because the digest below is taken over these
 * exact bytes: two identical records must not produce two digests because a
 * JSON engine chose a different key order.
 */
export function renderContent(body: unknown): string {
  if (typeof body === "string") return body;
  if (body === undefined) return "";
  return JSON.stringify(body, sortedKeys(body));
}

function sortedKeys(root: unknown): (key: string, value: unknown) => unknown {
  void root;
  return (_key, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) ordered[key] = source[key];
    return ordered;
  };
}

/** The digest of the bytes a frame carries. */
export function contentDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * A short human label for a record, used as the frame title.
 *
 * A title is for a person reading a citation, so it is the first line of the
 * content clipped to a length that stays readable in a list — never the whole
 * body, which is what `content` is for.
 */
export function frameTitle(record: MemoryRecord, content: string): string {
  const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
  const label = firstLine.length > 0 ? firstLine : `${record.kind} record`;
  return label.length <= 80 ? label : `${label.slice(0, 77)}…`;
}

/**
 * The provenance chain for a record: where it came from, and through what.
 *
 * The first link is always the record itself, because that is the claim the
 * frame can actually support — this content was read from this address, and
 * the address is a content hash. The tool and model links are added only when
 * the record names them, since an absent link says less than a link naming
 * "unknown".
 */
export function frameProvenance(record: MemoryRecord): FrameProvenance[] {
  const chain: FrameProvenance[] = [
    {
      type: "engram-record",
      uri: frameUri(record),
      digest: record.id,
      method: "content-address",
      by: record.provenance.author,
    },
  ];
  if (record.provenance.tool) {
    chain.push({ type: "tool", by: record.provenance.tool });
  }
  if (record.provenance.model) {
    chain.push({ type: "model", by: record.provenance.model });
  }
  for (const parent of record.provenance.derivedFrom) {
    chain.push({ type: "derived-from", digest: parent });
  }
  return chain;
}

/**
 * Render one record as a full-representation frame.
 *
 * `score` is the caller's relevance judgement, clamped into `[0, 1]` rather
 * than trusted: the protocol says the range is normalized, and a provider that
 * emits 1.4 has broken the host's ranking rather than won it.
 */
export function toFrame(record: MemoryRecord, score: number): ContextFrame {
  const content = renderContent(record.body);
  const frame: ContextFrame = {
    id: record.id,
    kind: frameKindOf(record.kind),
    title: frameTitle(record, content),
    content,
    content_digest: contentDigest(content),
    canonical_content_hash: record.id,
    uri: frameUri(record),
    representation: "full",
    content_fidelity: "exact",
    score: clampScore(score),
    // The protocol's B3 rule, computed by the SDK rather than restated here.
    token_cost: budgetTokens(content),
    valid_from: new Date(record.createdAt).toISOString(),
    recorded_at: new Date(record.provenance.timestamp).toISOString(),
    provenance: frameProvenance(record),
    citation_label: `${record.kind}:${record.id.slice(0, 12)}`,
  };
  // A record with a TTL stops being true at it; one without never expires, and
  // an absent `valid_to` is how the protocol says so.
  if (record.ttl !== undefined) {
    frame.valid_to = new Date(record.ttl).toISOString();
  }
  return frame;
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}
