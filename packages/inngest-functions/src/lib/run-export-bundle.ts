// run-export-bundle.ts — the signed, offline-verifiable bundle `export_run`
// produces (Mission Control spec §13.4; App. E; ADR-057). Pure: the segments
// and the attester key come from the caller.
//
//   manifest.json     the run, its sealed attempts and their seal figures
//   frames.ndjson     one JCS envelope per frame, in sequence order
//   attestation.json  one Ed25519 attestation per sealed attempt (spec §8.3)
//                     plus the verifying public key and its id
//   verify.mjs        recomputes the RFC 6962 root over frames.ndjson and
//                     checks every attestation with node:crypto alone
import { zipSync } from "fflate";
import {
  type Attestation,
  type AttesterKey,
  digestBytes,
  jcs,
  type JsonValue,
  merkleRoot,
  signAttestation,
} from "@oxagen/tacho";
import type { SealedSegment } from "./run-record";

export const BUNDLE_FORMAT = "oxagen.run-export/1";

export interface RunExportManifest {
  format: typeof BUNDLE_FORMAT;
  run_id: string;
  source: "ledger" | "tacho";
  exported_at: string;
  frame_count: number;
  /** RFC 6962 root over every frame digest in frames.ndjson, in order. */
  merkle_root: string;
  attester_key_id: string;
  attempts: Array<{
    attempt_id: string;
    frame_count: number;
    merkle_root: string;
    archive_segment_digest: string | null;
    enforcement_tier: string;
    completeness_gaps: string[];
    replay_grade: string | null;
  }>;
}

export interface RunExportBundle {
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
export function attestSegment(
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
      enforcement_tier: segment.enforcementTier,
      completeness_gaps: [...segment.completenessGaps],
      replay_grade: segment.replayGrade,
    })),
  };
  const frames = input.segments
    .flatMap((segment) => segment.envelopes)
    .map((envelope) => jcs(envelope))
    .join("\n");
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
      "verify.mjs": encoder.encode(VERIFIER_SCRIPT),
    },
    { level: 6 },
  );
  return { bytes, digest: digestBytes(bytes), manifest };
}

/**
 * The verifier an export ships. It depends on node:crypto and node:fs alone
 * and reimplements: JCS over the attestation payload (keys sorted, no
 * whitespace, which is what RFC 8785 yields for the flat payload); the RFC
 * 6962 tree over the frame digests; the Ed25519 check with the bundled key,
 * whose id must be the first 16 hex chars of sha256 over the JSON string of
 * the PEM (the platform's key-id rule).
 */
export const VERIFIER_SCRIPT = `#!/usr/bin/env node
// verify.mjs — verifies an Oxagen run export offline.
//   node verify.mjs <directory with manifest.json, frames.ndjson, attestation.json>
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const attestation = JSON.parse(readFileSync(join(dir, "attestation.json"), "utf8"));
const text = readFileSync(join(dir, "frames.ndjson"), "utf8");
const lines = text.length === 0 ? [] : text.split("\\n");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const hex = (buf) => "sha256:" + buf.toString("hex");

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function treeHash(leaves) {
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return sha256(Buffer.concat([Buffer.from([0]), leaves[0]]));
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha256(Buffer.concat([Buffer.from([1]), treeHash(leaves.slice(0, k)), treeHash(leaves.slice(k))]));
}

const frames = lines.map((line) => JSON.parse(line));
const digests = frames.map((frame) => frame.event_digest ?? frame.hash);
const failures = [];
if (digests.some((d) => typeof d !== "string" || !/^sha256:[0-9a-f]{64}$/.test(d))) failures.push("a frame carries no digest");
if (frames.length !== manifest.frame_count) failures.push(\`frame count \${frames.length} differs from the manifest's \${manifest.frame_count}\`);
const root = hex(treeHash(digests.map((d) => Buffer.from(d.slice(7), "hex"))));
if (root !== manifest.merkle_root) failures.push(\`Merkle root \${root} differs from the manifest's \${manifest.merkle_root}\`);

const keyId = sha256(Buffer.from(JSON.stringify(attestation.public_key_pem), "utf8")).toString("hex").slice(0, 16);
if (keyId !== attestation.key_id || keyId !== manifest.attester_key_id) failures.push("the bundled key does not match the recorded key id");
const publicKey = createPublicKey(attestation.public_key_pem);
let offset = 0;
for (const a of attestation.attestations) {
  const ok = a.alg === "ed25519" && a.key_id === keyId && verify(null, Buffer.from(canonical(a.payload), "utf8"), publicKey, Buffer.from(a.sig, "base64"));
  if (!ok) failures.push(\`attestation for \${a.payload.attempt_id} does not verify\`);
  const attemptDigests = digests.slice(offset, offset + a.payload.frame_count);
  offset += a.payload.frame_count;
  const attemptRoot = hex(treeHash(attemptDigests.map((d) => Buffer.from(d.slice(7), "hex"))));
  if (attemptRoot !== a.payload.merkle_root) failures.push(\`attempt \${a.payload.attempt_id}: frames do not hash to the attested root\`);
}
if (offset !== frames.length) failures.push("attestations do not cover every frame");

if (failures.length > 0) {
  for (const f of failures) console.error("FAIL " + f);
  process.exit(1);
}
console.log(\`OK \${manifest.run_id}: \${frames.length} frames, root \${root}, \${attestation.attestations.length} attestation(s) by key \${keyId}\`);
`;
