// run-export-bundle.ts — the signed, offline-verifiable bundle `export_run`
// produces (Mission Control spec §13.4; App. E; ADR-058). Pure: the segments
// and the attester key come from the caller.
//
//   manifest.json     the run, its sealed attempts and their seal figures
//   frames.ndjson     one JCS envelope per frame, in sequence order
//   attestation.json  one Ed25519 attestation per sealed attempt (spec §8.3)
//                     plus the verifying public key and its id
//   redactions.json   what the host redacted and what the bundle withholds,
//                     as kinds and counts, never a value
//   verify.mjs        recomputes the RFC 6962 root over frames.ndjson and
//                     checks every attestation with node:crypto alone
//
// `oxagen verify <bundle>` (@oxagen/tacho `verifyRunExport`) is the full
// check an auditor runs: it recomputes every frame's digest and chain link and
// reports held or broken per frame.
import { zipSync } from "fflate";
import {
  type Attestation,
  type AttesterKey,
  digestBytes,
  jcs,
  type JsonValue,
  merkleRoot,
  RUN_EXPORT_FORMAT,
  type RunExportManifest,
  signAttestation,
  summarizeRunExportRedactions,
} from "@oxagen/tacho";
import type { SealedSegment } from "./run-record";

export const BUNDLE_FORMAT = RUN_EXPORT_FORMAT;

interface RunExportBundle {
  bytes: Uint8Array;
  digest: string;
  manifest: RunExportManifest;
}

const encoder = new TextEncoder();

/**
 * The attestation payload of one sealed attempt. A wrapped session has no
 * archive segment: its root is computed here over the chain hashes and its
 * segment digest is the digest of the NDJSON lines the bundle carries, so
 * the attestation still names the bytes a verifier holds.
 */
function attestSegment(
  runId: string,
  segment: SealedSegment,
  key: AttesterKey,
): { attestation: Attestation; merkleRoot: string; segmentDigest: string } {
  const root =
    segment.merkleRoot === ""
      ? merkleRoot(segment.digests)
      : segment.merkleRoot;
  const segmentDigest =
    segment.archiveSegmentDigest ??
    digestBytes(encoder.encode(segment.envelopes.map(jcs).join("\n")));
  const attestation = signAttestation(
    {
      run_id: runId,
      attempt_id: segment.attemptPublicId,
      frame_count: segment.frameCount,
      merkle_root: root,
      archive_segment_digest: segmentDigest,
      enforcement_tier: segment.enforcementTier,
      completeness_gaps: [...segment.completenessGaps],
      replay_grade: segment.replayGrade,
    },
    key,
  );
  return { attestation, merkleRoot: root, segmentDigest };
}

export function buildRunExportBundle(input: {
  runId: string;
  source: "ledger" | "tacho";
  segments: readonly SealedSegment[];
  key: AttesterKey;
  now: Date;
}): RunExportBundle {
  const attested = input.segments.map((segment) =>
    attestSegment(input.runId, segment, input.key),
  );
  const digests = input.segments.flatMap((segment) => segment.digests);
  const manifest: RunExportManifest = {
    format: BUNDLE_FORMAT,
    run_id: input.runId,
    source: input.source,
    exported_at: input.now.toISOString(),
    frame_count: digests.length,
    merkle_root: merkleRoot(digests),
    attester_key_id: input.key.keyId,
    attempts: input.segments.map((segment, i) => ({
      attempt_id: segment.attemptPublicId,
      frame_count: segment.frameCount,
      merkle_root: attested[i]?.merkleRoot ?? "",
      archive_segment_digest: attested[i]?.segmentDigest ?? null,
      event_stream_digest: segment.eventStreamDigest,
      enforcement_tier: segment.enforcementTier,
      completeness_gaps: [...segment.completenessGaps],
      replay_grade: segment.replayGrade,
    })),
  };
  const envelopes = input.segments.flatMap((segment) => segment.envelopes);
  const frames = envelopes.map((envelope) => jcs(envelope)).join("\n");
  const redactions = summarizeRunExportRedactions(envelopes);
  const attestationFile: JsonValue = {
    public_key_pem: input.key.publicKeyPem,
    key_id: input.key.keyId,
    attestations: attested.map((a) => a.attestation as unknown as JsonValue),
  };
  const bytes = zipSync(
    {
      "manifest.json": encoder.encode(JSON.stringify(manifest, null, 2)),
      "frames.ndjson": encoder.encode(frames),
      "attestation.json": encoder.encode(
        JSON.stringify(attestationFile, null, 2),
      ),
      "redactions.json": encoder.encode(JSON.stringify(redactions, null, 2)),
      "verify.mjs": encoder.encode(VERIFIER_SCRIPT),
    },
    { level: 6 },
  );
  return { bytes, digest: digestBytes(bytes), manifest };
}

/**
 * The verifier an export ships, for a reviewer who will not install the
 * Oxagen CLI. It depends on node:crypto and node:fs alone and reimplements
 * what `oxagen verify` checks: JCS (keys sorted, no whitespace, which is what
 * RFC 8785 yields for these shapes); each ledger frame's payload and event
 * digest and dense attempt sequence; each wrapped frame's prev_hash link;
 * each ledger attempt's stream fold; the RFC 6962 tree over the frame
 * digests; the Ed25519 check with the bundled key, whose id must be the first
 * 16 hex chars of sha256 over the JSON string of the PEM (the platform's
 * key-id rule); and the redaction summary against the frames.
 */
const VERIFIER_SCRIPT = `#!/usr/bin/env node
// verify.mjs — verifies an Oxagen run export offline.
//   node verify.mjs <directory with manifest.json, frames.ndjson, attestation.json>
// Prints held or broken for every frame, then every bundle check. Exit 1 on
// anything broken. \`oxagen verify <bundle.zip>\` runs the same checks.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const read = (name) => readFileSync(join(dir, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const attestation = JSON.parse(read("attestation.json"));
const text = read("frames.ndjson");
const lines = text.length === 0 ? [] : text.split("\\n");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const hex = (buf) => "sha256:" + buf.toString("hex");
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}
const digestJcs = (value) => hex(sha256(Buffer.from(canonical(value), "utf8")));
// The ledger digests observed_at as Date.toISOString(); an older segment may
// spell the same instant as Postgres text (2026-07-21 12:00:00.123+00).
function instant(value) {
  const m = typeof value === "string" && /^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d+))?(Z|[+-]\\d{2}(?::?\\d{2})?)$/.exec(value);
  if (!m) return value;
  const ms = (m[3] ?? "").slice(0, 3).padEnd(3, "0");
  let zone = m[4];
  if (zone !== "Z") { const d = zone.slice(1).replace(":", ""); zone = zone[0] + d.slice(0, 2) + ":" + (d.slice(2) || "00").padEnd(2, "0"); }
  const t = new Date(m[1] + "T" + m[2] + "." + ms + zone);
  return Number.isNaN(t.getTime()) ? value : t.toISOString();
}

function treeHash(leaves) {
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return sha256(Buffer.concat([Buffer.from([0]), leaves[0]]));
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha256(Buffer.concat([Buffer.from([1]), treeHash(leaves.slice(0, k)), treeHash(leaves.slice(k))]));
}
const rootOf = (digests) => hex(treeHash(digests.map((d) => Buffer.from(d.slice(7), "hex"))));

const failures = [];
if (!((manifest.source === "ledger" && typeof manifest.run_id === "string" && manifest.run_id.startsWith("arun_")) || (manifest.source === "tacho" && typeof manifest.run_id === "string" && manifest.run_id.startsWith("tse_")))) failures.push("the source is invalid or does not match the run identifier");
const frames = lines.map((line) => { try { return JSON.parse(line); } catch { return {}; } });
const digests = frames.map((frame) => frame.event_digest ?? frame.hash);

let offset = 0;
for (const attempt of manifest.attempts) {
  let prevSeq = null;
  let prevHash = null;
  let stream = digestJcs([]);
  for (let i = offset; i < Math.min(offset + attempt.frame_count, frames.length); i += 1) {
    const f = frames[i];
    const why = [];
    if (typeof digests[i] !== "string" || !DIGEST.test(digests[i])) why.push("no sha256 digest");
    if (manifest.source === "ledger") {
      if (f.payload_inline !== null && f.payload_inline !== undefined && digestJcs(f.payload_inline) !== f.payload_digest) why.push("payload does not hash to payload_digest");
      const eventDigest = digestJcs({ attempt_seq: f.attempt_seq, event_schema_version: f.event_schema_version, event_type: f.event_type, stage: f.stage, payload_digest: f.payload_digest, observed_at: instant(f.observed_at) });
      if (eventDigest !== f.event_digest) why.push("identity fields do not hash to event_digest");
      const due = prevSeq === null ? 1 : prevSeq + 1;
      if (f.attempt_seq !== due) why.push("attempt_seq " + f.attempt_seq + " where " + due + " was due");
      prevSeq = f.attempt_seq;
      stream = digestJcs({ previous: stream, entry: [f.attempt_seq, f.event_schema_version, f.event_type, f.payload_digest] });
    } else {
      const expected = prevHash ?? (f.seq === 0 ? hex(sha256(Buffer.alloc(0))) : null);
      if (expected !== null && f.prev_hash !== expected) why.push("prev_hash does not link to the previous frame");
      if (prevSeq !== null && f.seq !== prevSeq + 1) why.push("seq " + f.seq + " where " + (prevSeq + 1) + " was due");
      prevSeq = f.seq;
      prevHash = f.hash;
    }
    const label = "frame " + (i + 1) + " (" + attempt.attempt_id + " #" + (f.attempt_seq ?? f.seq) + ")";
    if (why.length > 0) failures.push(label + " broken: " + why.join("; "));
    else console.log(label + " held");
  }
  if (manifest.source === "ledger" && typeof attempt.event_stream_digest === "string" && stream !== attempt.event_stream_digest) failures.push("attempt " + attempt.attempt_id + ": frames do not fold to the sealed event_stream_digest");
  offset += attempt.frame_count;
}
if (frames.length !== manifest.frame_count) failures.push(\`frame count \${frames.length} differs from the manifest's \${manifest.frame_count}\`);
const allDigests = digests.every((d) => typeof d === "string" && DIGEST.test(d));
const root = allDigests ? rootOf(digests) : "none";
if (root !== manifest.merkle_root) failures.push(\`Merkle root \${root} differs from the manifest's \${manifest.merkle_root}\`);

const keyId = sha256(Buffer.from(JSON.stringify(attestation.public_key_pem), "utf8")).toString("hex").slice(0, 16);
if (keyId !== attestation.key_id || keyId !== manifest.attester_key_id) failures.push("the bundled key does not match the recorded key id");
const publicKey = createPublicKey(attestation.public_key_pem);
let covered = 0;
for (const a of attestation.attestations) {
  const ok = a.alg === "ed25519" && a.key_id === keyId && verify(null, Buffer.from(canonical(a.payload), "utf8"), publicKey, Buffer.from(a.sig, "base64"));
  if (!ok) failures.push(\`attestation for \${a.payload.attempt_id} does not verify\`);
  const slice = digests.slice(covered, covered + a.payload.frame_count);
  if (manifest.source === "tacho") {
    const exportedDigest = hex(sha256(Buffer.from(lines.slice(covered, covered + a.payload.frame_count).join("\\n"), "utf8")));
    if (exportedDigest !== a.payload.archive_segment_digest) failures.push("attempt " + a.payload.attempt_id + ": exported frame bytes do not match the signed segment digest");
  }
  if (a.payload.run_id !== manifest.run_id) failures.push("the manifest run differs from the signed run");
  covered += a.payload.frame_count;
  if (!allDigests || rootOf(slice) !== a.payload.merkle_root) failures.push(\`attempt \${a.payload.attempt_id}: frames do not hash to the attested root\`);
}
if (covered !== frames.length) failures.push("attestations do not cover every frame");

if (existsSync(join(dir, "redactions.json"))) {
  const claimed = JSON.parse(read("redactions.json"));
  const redacted = new Map();
  const withheld = new Map();
  let total = 0;
  const bump = (map, kind, count) => { const e = map.get(kind) ?? { count: 0, frames: 0 }; e.count += count; e.frames += 1; map.set(kind, e); };
  for (const f of frames) {
    const list = f.content?.redactions;
    if (Array.isArray(list)) {
      const per = new Map();
      for (const r of list) { const k = typeof r?.reason === "string" ? r.reason : "unknown"; per.set(k, (per.get(k) ?? 0) + 1); }
      for (const [k, n] of per) { bump(redacted, k, n); total += n; }
    }
    if (typeof f.content?.bytes_ref === "string") bump(withheld, "frame_body", 1);
    if (typeof f.encrypted_payload_ref === "string") bump(withheld, "encrypted_payload", 1);
  }
  const tally = (m) => [...m.entries()].map(([kind, v]) => ({ kind, count: v.count, frames: v.frames })).sort((x, y) => x.kind.localeCompare(y.kind));
  const recomputed = { format: claimed.format, redacted: tally(redacted), redacted_total: total, withheld: tally(withheld) };
  if (canonical(recomputed) !== canonical(claimed)) failures.push("redactions.json does not match what the frames record");
}

if (failures.length > 0) {
  for (const f of failures) console.error("BROKEN " + f);
  process.exit(1);
}
console.log(\`HELD \${manifest.run_id}: \${frames.length} frames, root \${root}, \${attestation.attestations.length} attestation(s) by key \${keyId}\`);
`;
