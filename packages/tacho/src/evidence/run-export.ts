/**
 * The run export bundle's shared shape and its offline verifier (Mission
 * Control spec §13.4, App. E; ADR-058).
 *
 * `export_run` writes a zip with `manifest.json`, `frames.ndjson`,
 * `attestation.json`, `redactions.json` and `verify.mjs`. The builder lives
 * in @oxagen/inngest-functions; this module holds what the builder and the
 * verifier must agree on, and the verifier itself, so `oxagen verify` checks a
 * bundle on a machine with nothing but the CLI and no network.
 *
 * What the verifier recomputes, per frame:
 *
 *   ledger frame (`arun_…`)
 *     payload  sha256(JCS(payload_inline)) = payload_digest, when the payload
 *              is inline; an encrypted payload is not carried.
 *     digest   sha256(JCS({attempt_seq, event_schema_version, event_type,
 *              stage, payload_digest, observed_at})) = event_digest.
 *     link     attempt_seq is dense from 1 inside its attempt.
 *
 *   wrapped frame (`tse_…`)
 *     link     prev_hash is the previous frame's hash (sha256("") at seq 0)
 *              and seq is dense.
 *     export   the exact exported segment bytes match the signed
 *              archive_segment_digest, authenticating the projection.
 *     digest   from format 3, the frame carries `event`, the sealed Tacho
 *              event rebuilt from its stored row: sha256(JCS(event without
 *              hash)) = hash, and every member the frame shows beside it is
 *              what `wrappedFrameOf` reads from that event. A frame whose
 *              event the export could not rebuild, and every wrapped frame
 *              of a format-1 or format-2 bundle, is `not carried`.
 *
 * And over the bundle: the frame count, the RFC 6962 Merkle root over every
 * frame digest, each attempt's root against its signed attestation, each
 * Ed25519 signature and key id, each ledger attempt's `event_stream_digest`
 * fold, and the redaction summary against the frames it summarises.
 */
import { hashEvent } from "../chain";
import { digestBytes, digestJcs, jcs, type JsonValue } from "../digest";
import { keyIdForPublicKey } from "../host/key-id";
import { type Attestation, verifyAttestation } from "./attestation";
import { merkleRoot } from "./merkle";

/**
 * Version 2 added `redactions.json` and each attempt's stream digest.
 * Version 3 added `event` to a wrapped frame, so its hash is recomputed.
 */
export const RUN_EXPORT_FORMAT = "oxagen.run-export/3";
const FORMAT_1 = "oxagen.run-export/1";
const ACCEPTED_FORMATS = new Set([
  FORMAT_1,
  "oxagen.run-export/2",
  RUN_EXPORT_FORMAT,
]);

export const RUN_EXPORT_REDACTIONS_FORMAT = "oxagen.run-export.redactions/1";

const GENESIS_PREV_HASH = digestBytes("");
const EMPTY_EVENT_STREAM_DIGEST = digestJcs([]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface RunExportAttempt {
  attempt_id: string;
  frame_count: number;
  merkle_root: string;
  archive_segment_digest: string | null;
  /** The seal's stream fold; null for a wrapped session, which has none. */
  event_stream_digest?: string | null;
  enforcement_tier: string;
  completeness_gaps: string[];
  replay_grade: string | null;
}

export interface RunExportManifest {
  format: string;
  run_id: string;
  source: "ledger" | "tacho";
  exported_at: string;
  frame_count: number;
  /** RFC 6962 root over every frame digest in frames.ndjson, in order. */
  merkle_root: string;
  attester_key_id: string;
  attempts: RunExportAttempt[];
}

/** One kind of thing the host removed or the bundle does not carry. */
export interface RedactionCount {
  kind: string;
  count: number;
  /** How many frames carry at least one. */
  frames: number;
}

/**
 * `redactions.json`: what is absent from the bundle and why, as kinds and
 * counts. It never holds a value, a byte span or an `original_digest`; those
 * stay on each frame, under the frame's own digest.
 */
export interface RunExportRedactions {
  format: typeof RUN_EXPORT_REDACTIONS_FORMAT;
  /** Credentials the host cut before the bytes were written, by reason. */
  redacted: RedactionCount[];
  redacted_total: number;
  /** Content the frames name by digest but the bundle does not carry. */
  withheld: RedactionCount[];
}

/**
 * An instant in the `Date.toISOString()` form (`2026-07-21T12:00:00.123Z`).
 *
 * The ledger digests `observed_at` in that form, but drizzle's postgres-js
 * driver returns `timestamptz` as Postgres text (`2026-07-21 12:00:00.123+00`),
 * and archive segments written before this function existed carry it that
 * way. Both spellings name the same instant, so the verifier compares the
 * instant, not the spelling. A value that is not an instant is returned as
 * is, and its digest then fails honestly.
 */
export function normalizeInstant(value: string): string {
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
      value,
    );
  if (!m) return value;
  const [, day, time, frac, zone] = m as unknown as [
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const ms = (frac ?? "").slice(0, 3).padEnd(3, "0");
  let offset = zone;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offset = `${zone[0]}${digits.slice(0, 2)}:${(digits.slice(2) || "00").padEnd(2, "0")}`;
  }
  const instant = new Date(`${day}T${time}.${ms}${offset}`);
  return Number.isNaN(instant.getTime()) ? value : instant.toISOString();
}

/**
 * A wrapped frame as the bundle writes it: what the Run page shows of the
 * event, then the event itself. `bytesRef` is where the control plane kept
 * the frame's body, a server fact the event does not hold, so the export
 * passes it separately and the verifier reads it back off the frame.
 *
 * The export and both verifiers build the frame with this rule, so a member
 * edited beside the event no longer matches what the event says.
 */
export function wrappedFrameOf(
  event: Record<string, JsonValue | undefined>,
  bytesRef: string | null,
): Record<string, JsonValue> {
  const body = asRecord(event["body"]) ?? {};
  const content = asRecord(event["content"]);
  const turn = asRecord(event["turn"]);
  const text = (value: JsonValue | undefined) =>
    typeof value === "string" ? value : "";
  const count = (value: JsonValue | undefined) =>
    typeof value === "number" ? value : null;
  return {
    event_id: event["event_id"] ?? null,
    seq: event["seq"] ?? null,
    ts: event["ts"] ?? null,
    kind: event["kind"] ?? null,
    prev_hash: event["prev_hash"] ?? null,
    hash: event["hash"] ?? null,
    content: {
      digest: content?.["digest"] ?? null,
      bytes_ref: bytesRef,
      redactions: content?.["redactions"] ?? [],
    },
    body: event["body"] ?? null,
    tool_name: text(body["tool_name"]),
    tool_status: text(body["tool_status"]),
    tool_use_id: text(body["tool_use_id"]),
    model: text(body["model"]),
    provider: text(body["provider"]),
    policy_decision: text(body["policy_decision"]),
    cost_usd_micros: count(body["cost_usd_micros"]),
    turn_seq: count(turn?.["turn_seq"]),
    event: event as JsonValue,
  };
}

const WITHHELD_BODY = "frame_body";
const WITHHELD_ENCRYPTED_PAYLOAD = "encrypted_payload";

type Envelope = Record<string, JsonValue | undefined>;

function asRecord(value: JsonValue | undefined): Envelope | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Envelope)
    : null;
}

function tally(counts: Map<string, { count: number; frames: number }>) {
  return [...counts.entries()]
    .map(([kind, { count, frames }]) => ({ kind, count, frames }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/** The redaction summary of a bundle's frames. Pure; the verifier reruns it. */
export function summarizeRunExportRedactions(
  envelopes: readonly JsonValue[],
): RunExportRedactions {
  const redacted = new Map<string, { count: number; frames: number }>();
  const withheld = new Map<string, { count: number; frames: number }>();
  const bump = (
    map: Map<string, { count: number; frames: number }>,
    kind: string,
    count: number,
  ) => {
    const entry = map.get(kind) ?? { count: 0, frames: 0 };
    entry.count += count;
    entry.frames += 1;
    map.set(kind, entry);
  };
  let total = 0;
  for (const envelope of envelopes) {
    const frame = asRecord(envelope);
    if (!frame) continue;
    const content = asRecord(frame["content"]);
    const list = content?.["redactions"];
    if (Array.isArray(list)) {
      const perReason = new Map<string, number>();
      for (const item of list) {
        const reason = asRecord(item)?.["reason"];
        const kind = typeof reason === "string" ? reason : "unknown";
        perReason.set(kind, (perReason.get(kind) ?? 0) + 1);
      }
      for (const [kind, count] of perReason) {
        bump(redacted, kind, count);
        total += count;
      }
    }
    if (typeof content?.["bytes_ref"] === "string") {
      bump(withheld, WITHHELD_BODY, 1);
    }
    if (typeof frame["encrypted_payload_ref"] === "string") {
      bump(withheld, WITHHELD_ENCRYPTED_PAYLOAD, 1);
    }
  }
  return {
    format: RUN_EXPORT_REDACTIONS_FORMAT,
    redacted: tally(redacted),
    redacted_total: total,
    withheld: tally(withheld),
  };
}

// ── Verification ────────────────────────────────────────────────────────────

export type CheckState = "held" | "broken" | "not_carried";

export interface FrameVerdict {
  /** 1-based line in frames.ndjson. */
  line: number;
  attempt_id: string;
  /** `attempt_seq` on a ledger frame, `seq` on a wrapped one. */
  seq: number | null;
  status: "held" | "broken";
  /** The frame's own content digest, recomputed. */
  digest: CheckState;
  /** The frame's place in its chain. */
  link: "held" | "broken";
  reasons: string[];
}

export interface BundleCheck {
  name: string;
  status: "held" | "broken";
  detail: string;
}

export interface RunExportVerification {
  ok: boolean;
  run_id: string | null;
  format: string | null;
  frames: FrameVerdict[];
  checks: BundleCheck[];
  redactions: RunExportRedactions | null;
}

/** The bundle's text files, as read from the zip or an extracted directory. */
export interface RunExportFiles {
  "manifest.json": string;
  "frames.ndjson": string;
  "attestation.json": string;
  /** Absent from a format-1 bundle. */
  "redactions.json"?: string;
}

interface AttestationFile {
  public_key_pem: string;
  key_id: string;
  attestations: Attestation[];
}

function digestOf(frame: Envelope): string | null {
  const value = frame["event_digest"] ?? frame["hash"];
  return typeof value === "string" && DIGEST.test(value) ? value : null;
}

function safeDigestJcs(value: JsonValue): string | null {
  try {
    return digestJcs(value);
  } catch {
    return null;
  }
}

/**
 * A wrapped frame's own check. Without `event` there is nothing to hash.
 * With it, the event must hash to the frame's `hash`, and the frame must
 * show exactly what `wrappedFrameOf` reads from that event.
 */
function checkWrappedFrame(
  frame: Envelope,
  attemptId: string,
): {
  digest: CheckState;
  reasons: string[];
} {
  if (frame["event"] === undefined || frame["event"] === null) {
    return { digest: "not_carried", reasons: [] };
  }
  const event = asRecord(frame["event"]);
  if (!event) {
    return { digest: "broken", reasons: ["event is not a JSON object"] };
  }
  const reasons: string[] = [];
  // A wrapped run's one attempt is its session, so every event must be one
  // of that session's: a frame from another chain does not belong here.
  if (event["session_uuid"] !== attemptId) {
    reasons.push(
      `the event belongs to session ${String(event["session_uuid"])}, not ${attemptId}`,
    );
  }
  let recomputed: string | null;
  try {
    recomputed = hashEvent(event);
  } catch {
    recomputed = null;
  }
  if (recomputed !== frame["hash"]) {
    reasons.push("the event does not hash to hash");
  }
  const content = asRecord(frame["content"]);
  const bytesRef =
    typeof content?.["bytes_ref"] === "string" ? content["bytes_ref"] : null;
  const expected = wrappedFrameOf(event, bytesRef);
  const differs = [
    ...new Set([...Object.keys(expected), ...Object.keys(frame)]),
  ]
    .filter((name) => name !== "event")
    .filter((name) => {
      const shown = frame[name];
      const read = expected[name];
      if (shown === undefined || read === undefined) return true;
      return jcs(shown) !== jcs(read);
    })
    .sort();
  if (differs.length > 0) {
    const verb = differs.length === 1 ? "differs" : "differ";
    reasons.push(`${differs.join(", ")} ${verb} from the hashed event`);
  }
  return { digest: reasons.length > 0 ? "broken" : "held", reasons };
}

/** A ledger envelope's own checks: payload, event digest. */
function checkLedgerFrame(frame: Envelope): {
  digest: CheckState;
  reasons: string[];
} {
  const reasons: string[] = [];
  const payloadDigest = frame["payload_digest"];
  let digest: CheckState = "held";
  if (
    frame["payload_inline"] !== null &&
    frame["payload_inline"] !== undefined
  ) {
    const recomputed = safeDigestJcs(frame["payload_inline"] as JsonValue);
    if (recomputed !== payloadDigest) {
      digest = "broken";
      reasons.push("payload does not hash to payload_digest");
    }
  } else if (typeof frame["encrypted_payload_ref"] !== "string") {
    digest = "broken";
    reasons.push("frame carries neither a payload nor an encrypted reference");
  }
  const recomputed = safeDigestJcs({
    attempt_seq: frame["attempt_seq"] ?? null,
    event_schema_version: frame["event_schema_version"] ?? null,
    event_type: frame["event_type"] ?? null,
    stage: frame["stage"] ?? null,
    payload_digest: payloadDigest ?? null,
    observed_at:
      typeof frame["observed_at"] === "string"
        ? normalizeInstant(frame["observed_at"])
        : (frame["observed_at"] ?? null),
  });
  if (recomputed !== frame["event_digest"]) {
    digest = "broken";
    reasons.push("identity fields do not hash to event_digest");
  }
  return { digest, reasons };
}

function parseJson<T>(
  text: string,
  name: string,
  checks: BundleCheck[],
): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    checks.push({ name, status: "broken", detail: `${name} is not JSON` });
    return null;
  }
}

/**
 * Verify a run export bundle offline. Pure: no network, no clock, no Oxagen
 * service. Every frame gets a verdict; every bundle-level figure gets a check.
 */
export function verifyRunExport(files: RunExportFiles): RunExportVerification {
  const checks: BundleCheck[] = [];
  const hold = (name: string, ok: boolean, held: string, broken: string) =>
    checks.push({
      name,
      status: ok ? "held" : "broken",
      detail: ok ? held : broken,
    });

  const manifest = parseJson<RunExportManifest>(
    files["manifest.json"],
    "manifest",
    checks,
  );
  const attestationFile = parseJson<AttestationFile>(
    files["attestation.json"],
    "attestation",
    checks,
  );
  // One trailing newline ends the last line rather than starting a new one:
  // an editor that saves the file adds it, and the frame count and Merkle root
  // still catch a frame that was added or dropped.
  const raw = files["frames.ndjson"];
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = text.length === 0 ? [] : text.split("\n");
  const frames: Envelope[] = [];
  const verdicts: FrameVerdict[] = [];
  lines.forEach((line, i) => {
    let parsed: Envelope | null = null;
    try {
      parsed = asRecord(JSON.parse(line) as JsonValue);
    } catch {
      parsed = null;
    }
    frames.push(parsed ?? {});
    if (!parsed) {
      verdicts.push({
        line: i + 1,
        attempt_id: "",
        seq: null,
        status: "broken",
        digest: "broken",
        link: "broken",
        reasons: ["line is not a JSON object"],
      });
    }
  });

  if (!manifest || !attestationFile) {
    return {
      ok: false,
      run_id: manifest?.run_id ?? null,
      format: manifest?.format ?? null,
      frames: verdicts,
      checks,
      redactions: null,
    };
  }

  hold(
    "format",
    ACCEPTED_FORMATS.has(manifest.format),
    manifest.format,
    `unknown bundle format ${String(manifest.format)}`,
  );

  hold(
    "source",
    typeof manifest.run_id === "string" &&
      ((manifest.source === "ledger" && manifest.run_id.startsWith("arun_")) ||
        (manifest.source === "tacho" && manifest.run_id.startsWith("tse_"))),
    "the source matches the run identifier",
    "the source is invalid or does not match the run identifier",
  );

  // Per-frame checks, walking the attempts the manifest declares.
  const byLine = new Map(verdicts.map((v) => [v.line, v]));
  let offset = 0;
  for (const attempt of manifest.attempts ?? []) {
    let prevHash: string | null = null;
    let prevSeq: number | null = null;
    let stream = EMPTY_EVENT_STREAM_DIGEST as string;
    const end = Math.min(offset + attempt.frame_count, frames.length);
    for (let i = offset; i < end; i += 1) {
      const line = i + 1;
      if (byLine.has(line)) continue;
      const frame = frames[i] as Envelope;
      const reasons: string[] = [];
      let digest: CheckState;
      let link: "held" | "broken" = "held";
      let seq: number | null = null;
      if (manifest.source === "ledger") {
        const own = checkLedgerFrame(frame);
        digest = own.digest;
        reasons.push(...own.reasons);
        const attemptSeq = frame["attempt_seq"];
        seq = typeof attemptSeq === "number" ? attemptSeq : null;
        const expected: number = prevSeq === null ? 1 : prevSeq + 1;
        if (seq !== expected) {
          link = "broken";
          reasons.push(`attempt_seq ${String(seq)} where ${expected} was due`);
        }
        prevSeq = seq;
        stream = digestJcs({
          previous: stream,
          entry: [
            frame["attempt_seq"] ?? null,
            frame["event_schema_version"] ?? null,
            frame["event_type"] ?? null,
            frame["payload_digest"] ?? null,
          ],
        });
      } else {
        const own = checkWrappedFrame(frame, attempt.attempt_id);
        digest = own.digest;
        reasons.push(...own.reasons);
        const rawSeq = frame["seq"];
        seq = typeof rawSeq === "number" ? rawSeq : null;
        const expectedPrev: string | null =
          prevHash ?? (seq === 0 ? GENESIS_PREV_HASH : null);
        if (expectedPrev !== null && frame["prev_hash"] !== expectedPrev) {
          link = "broken";
          reasons.push(
            prevHash === null
              ? 'genesis prev_hash is not sha256("")'
              : "prev_hash is not the previous frame's hash",
          );
        }
        if (prevSeq !== null && seq !== prevSeq + 1) {
          link = "broken";
          reasons.push(`seq ${String(seq)} where ${prevSeq + 1} was due`);
        }
        prevSeq = seq;
        prevHash = typeof frame["hash"] === "string" ? frame["hash"] : null;
      }
      if (digestOf(frame) === null) {
        digest = "broken";
        reasons.push("frame carries no sha256 digest");
      }
      verdicts.push({
        line,
        attempt_id: attempt.attempt_id,
        seq,
        status: digest === "broken" || link === "broken" ? "broken" : "held",
        digest,
        link,
        reasons,
      });
    }
    if (
      manifest.source === "ledger" &&
      typeof attempt.event_stream_digest === "string"
    ) {
      hold(
        `stream ${attempt.attempt_id}`,
        stream === attempt.event_stream_digest,
        "the frames fold to the sealed event_stream_digest",
        `the frames fold to ${stream}, the seal recorded ${attempt.event_stream_digest}`,
      );
    }
    offset += attempt.frame_count;
  }
  // Frames past the last attempt belong to nothing the seal named.
  for (let i = offset; i < frames.length; i += 1) {
    if (byLine.has(i + 1)) continue;
    verdicts.push({
      line: i + 1,
      attempt_id: "",
      seq: null,
      status: "broken",
      digest: "broken",
      link: "broken",
      reasons: ["frame lies outside every attested attempt"],
    });
  }
  verdicts.sort((a, b) => a.line - b.line);

  hold(
    "frame count",
    frames.length === manifest.frame_count,
    `${frames.length} frames`,
    `${frames.length} frames where the manifest says ${manifest.frame_count}`,
  );

  const digests = frames.map(digestOf);
  const allDigests = digests.every((d): d is string => d !== null);
  const root = allDigests ? merkleRoot(digests) : null;
  hold(
    "merkle root",
    root === manifest.merkle_root,
    `root ${manifest.merkle_root}`,
    `frames hash to ${root ?? "nothing"}, the manifest says ${manifest.merkle_root}`,
  );

  // Attestations: the key, each signature, and each attempt's root.
  const pem = attestationFile.public_key_pem;
  let keyId: string | null = null;
  try {
    keyId = keyIdForPublicKey(pem);
  } catch {
    keyId = null;
  }
  hold(
    "attester key",
    keyId !== null &&
      keyId === attestationFile.key_id &&
      keyId === manifest.attester_key_id,
    `key ${String(keyId)}`,
    "the bundled public key does not match the recorded key id",
  );
  let covered = 0;
  const attestations = attestationFile.attestations ?? [];
  attestations.forEach((a, i) => {
    const attemptId = a.payload?.attempt_id ?? `#${i + 1}`;
    hold(
      `signature ${attemptId}`,
      keyId !== null && verifyAttestation(a, pem),
      "Ed25519 signature verifies",
      "the attestation signature does not verify",
    );
    const slice = digests.slice(
      covered,
      covered + (a.payload?.frame_count ?? 0),
    );
    if (manifest.source === "tacho") {
      const exportedDigest = digestBytes(
        lines
          .slice(covered, covered + (a.payload?.frame_count ?? 0))
          .join("\n"),
      );
      hold(
        `exported content ${attemptId}`,
        exportedDigest === a.payload?.archive_segment_digest,
        "the exported frame bytes match the signed segment digest",
        "the exported frame bytes do not match the signed segment digest",
      );
    }
    hold(
      `run identity ${attemptId}`,
      a.payload?.run_id === manifest.run_id,
      "the attestation names this run",
      "the manifest run differs from the signed run",
    );
    covered += a.payload?.frame_count ?? 0;
    const attemptRoot = slice.every((d): d is string => d !== null)
      ? merkleRoot(slice)
      : null;
    hold(
      `attested root ${attemptId}`,
      attemptRoot === a.payload?.merkle_root,
      "the attempt's frames hash to the signed root",
      `the attempt's frames hash to ${attemptRoot ?? "nothing"}, the attestation signed ${String(a.payload?.merkle_root)}`,
    );
  });
  hold(
    "coverage",
    covered === frames.length && attestations.length > 0,
    "the attestations cover every frame",
    `the attestations cover ${covered} of ${frames.length} frames`,
  );

  // The redaction summary is unsigned; it is trusted only because it matches.
  let redactions: RunExportRedactions | null = null;
  const redactionsText = files["redactions.json"];
  if (redactionsText !== undefined) {
    redactions = parseJson<RunExportRedactions>(
      redactionsText,
      "redactions",
      checks,
    );
    if (redactions) {
      const recomputed = summarizeRunExportRedactions(frames as JsonValue[]);
      hold(
        "redactions",
        digestJcs(recomputed as unknown as JsonValue) ===
          digestJcs(redactions as unknown as JsonValue),
        `${recomputed.redacted_total} redaction(s) summarised`,
        "redactions.json does not match what the frames record",
      );
    }
  } else if (manifest.format !== FORMAT_1) {
    hold("redactions", false, "", "redactions.json is missing");
  }

  const ok =
    verdicts.length === frames.length &&
    verdicts.every((v) => v.status === "held") &&
    checks.every((c) => c.status === "held");
  return {
    ok,
    run_id: manifest.run_id,
    format: manifest.format,
    frames: verdicts,
    checks,
    redactions,
  };
}
