import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  archiveFrameOf,
  computeEventDigest,
  computeEventStreamDigest,
  digestOfCanonicalJson,
  EVENT_SCHEMA_VERSION,
} from "@oxagen/run-ledger";
import {
  attesterKeyFromPem,
  digestBytes,
  hashEvent,
  type JsonValue,
  merkleRoot,
  verifyAttestation,
  verifyRunExport,
} from "@oxagen/tacho";
import { afterAll, describe, expect, it } from "vitest";
import { buildRunExportBundle, BUNDLE_FORMAT } from "./run-export-bundle";
import type { SealedSegment } from "./run-record";

const key = attesterKeyFromPem(
  generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
);
const dec = new TextDecoder();
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const OBSERVED = new Date("2026-09-14T11:59:00.000Z");

/**
 * One sealed ledger attempt, framed the way the seal writes its archive
 * segment (`archiveFrameOf`), so every digest a verifier recomputes is real.
 * Frame 2 carries a redacted credential and a retained body the bundle does
 * not ship.
 */
function ledgerSegment(over: Partial<SealedSegment> = {}): SealedSegment {
  const rows = [1, 2, 3].map((n) => {
    const payload = { n, note: `frame ${n}` };
    const payloadDigest = digestOfCanonicalJson(payload);
    const eventType = n === 2 ? "tool.call_completed" : "model.call_completed";
    const stage = n === 2 ? "tool" : "model";
    const observed = new Date(OBSERVED.getTime() + n * 1000);
    return {
      id: `e${n}`,
      attempt_seq: n,
      run_seq: String(n),
      event_schema_version: EVENT_SCHEMA_VERSION,
      event_type: eventType,
      stage,
      payload_digest: payloadDigest,
      event_digest: computeEventDigest({
        attemptSeq: n,
        eventSchemaVersion: EVENT_SCHEMA_VERSION,
        eventType,
        stage,
        payloadDigest,
        observedAt: observed.toISOString(),
      }),
      payload_inline: payload,
      encrypted_payload_ref: null,
      // Frame 3 is read back the way drizzle's postgres-js driver answers
      // timestamptz: Postgres text, not a Date.
      observed_at:
        n === 3
          ? observed.toISOString().replace("T", " ").replace("Z", "+00")
          : observed,
      created_at: observed,
      body_ref: n === 2 ? "evb:v1:k1:" + "a".repeat(64) : null,
      body_digest: n === 2 ? `sha256:${"a".repeat(64)}` : null,
      body_bytes: n === 2 ? 120 : null,
      redactions:
        n === 2
          ? [
              {
                path: "bytes:10-50",
                reason: "github_token",
                original_digest: `sha256:${"b".repeat(64)}`,
              },
            ]
          : null,
      fidelity: "full",
    };
  });
  const envelopes = rows.map((row) => archiveFrameOf(row).envelope);
  const digests = rows.map((row) => row.event_digest);
  return {
    attemptId: "a1",
    attemptPublicId: "arat_0123456789abcdefghjkmn",
    frameCount: 3,
    merkleRoot: merkleRoot(digests),
    archiveSegmentDigest: `sha256:${"9".repeat(64)}`,
    eventStreamDigest: computeEventStreamDigest(
      rows.map((row) => ({
        attemptSeq: row.attempt_seq,
        eventSchemaVersion: row.event_schema_version,
        eventType: row.event_type,
        payloadDigest: row.payload_digest,
      })),
    ),
    enforcementTier: "harness",
    completenessGaps: [],
    replayGrade: "view",
    envelopes,
    digests,
    ...over,
  };
}

/** One wrapped session: three frames hash-chained from genesis. */
function tachoSegment(): SealedSegment {
  let prev = digestBytes("");
  const envelopes: JsonValue[] = [0, 1, 2].map((seq) => {
    const body = { seq, kind: "tool.post", prev_hash: prev };
    const hash = hashEvent(body);
    prev = hash;
    return {
      event_id: `ev${seq}`,
      seq,
      ts: "2026-09-14T12:00:00.000Z",
      kind: "tool.post",
      prev_hash: body.prev_hash,
      hash,
      content: { digest: null, bytes_ref: null, redactions: [] },
      body: null,
    };
  });
  const digests = envelopes.map((e) => (e as { hash: string }).hash);
  return {
    attemptId: "s1",
    attemptPublicId: "0a1b2c3d-0000-4000-8000-000000000000",
    frameCount: 3,
    merkleRoot: "",
    archiveSegmentDigest: null,
    eventStreamDigest: null,
    enforcementTier: "gateway",
    completenessGaps: [],
    replayGrade: "fork",
    envelopes,
    digests,
  };
}

function unpack(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, dec.decode(data)]),
  );
}

function writeBundle(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "run-export-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return dir;
}

function runVerifier(dir: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [join(dir, "verify.mjs"), dir],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("the run export bundle", () => {
  it("carries the manifest, the frames, one attestation per sealed attempt and the verifier, and the verifier passes", () => {
    const bundle = buildRunExportBundle({
      runId: "arun_5f0c2e9a1b7d4c3e8f6a02",
      source: "ledger",
      segments: [ledgerSegment()],
      key,
      now: new Date("2026-09-14T12:00:00.000Z"),
    });
    expect(bundle.digest).toBe(digestBytes(bundle.bytes));
    const files = unpack(bundle.bytes);
    expect(Object.keys(files).sort()).toEqual([
      "attestation.json",
      "frames.ndjson",
      "manifest.json",
      "redactions.json",
      "verify.mjs",
    ]);
    const manifest = JSON.parse(files["manifest.json"] as string);
    expect(manifest).toMatchObject({
      format: BUNDLE_FORMAT,
      run_id: "arun_5f0c2e9a1b7d4c3e8f6a02",
      frame_count: 3,
      merkle_root: ledgerSegment().merkleRoot,
      attester_key_id: key.keyId,
    });
    expect(manifest.attempts[0]).toMatchObject({
      attempt_id: "arat_0123456789abcdefghjkmn",
      replay_grade: "view",
      archive_segment_digest: `sha256:${"9".repeat(64)}`,
      event_stream_digest: ledgerSegment().eventStreamDigest,
    });
    expect((files["frames.ndjson"] as string).split("\n")).toHaveLength(3);
    const attestation = JSON.parse(files["attestation.json"] as string);
    expect(attestation.key_id).toBe(key.keyId);
    expect(
      verifyAttestation(
        attestation.attestations[0],
        attestation.public_key_pem,
      ),
    ).toBe(true);

    expect(runVerifier(writeBundle(files))).toMatchObject({ ok: true });
  });

  it("the verifier fails on a changed frame, a dropped frame and a foreign key (negative)", () => {
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [tachoSegment()],
      key,
      now: new Date(),
    });
    const files = unpack(bundle.bytes);
    expect(runVerifier(writeBundle(files)).ok).toBe(true);

    const lines = (files["frames.ndjson"] as string).split("\n");
    const changed = runVerifier(
      writeBundle({
        ...files,
        "frames.ndjson": [
          lines[0]?.replace(
            /"hash":"sha256:[0-9a-f]{64}"/,
            `"hash":"sha256:${"0".repeat(64)}"`,
          ) ?? "",
          ...lines.slice(1),
        ].join("\n"),
      }),
    );
    expect(changed).toMatchObject({ ok: false });
    expect(changed.output).toMatch(/frame 2 .*broken: prev_hash/);
    expect(changed.output).toMatch(/Merkle root/);

    const dropped = runVerifier(
      writeBundle({ ...files, "frames.ndjson": lines.slice(0, 2).join("\n") }),
    );
    expect(dropped.ok).toBe(false);
    expect(dropped.output).toMatch(/frame count/);

    const other = attesterKeyFromPem(
      generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    );
    const attestation = JSON.parse(files["attestation.json"] as string);
    const foreign = runVerifier(
      writeBundle({
        ...files,
        "attestation.json": JSON.stringify({
          ...attestation,
          public_key_pem: other.publicKeyPem,
        }),
      }),
    );
    expect(foreign.ok).toBe(false);
    expect(foreign.output).toMatch(/key id/);
  });

  it("roots a wrapped session over its chain hashes and attests the NDJSON it ships", () => {
    const seg = tachoSegment();
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [seg],
      key,
      now: new Date(),
    });
    expect(bundle.manifest.attempts[0]?.merkle_root).toBe(
      merkleRoot(seg.digests),
    );
    expect(bundle.manifest.attempts[0]?.archive_segment_digest).toMatch(
      /^sha256:/,
    );
  });

  it("exports a sealed run, and verify reports broken at the one frame that was tampered with", () => {
    const bundle = buildRunExportBundle({
      runId: "arun_5f0c2e9a1b7d4c3e8f6a02",
      source: "ledger",
      segments: [ledgerSegment()],
      key,
      now: new Date("2026-09-14T12:00:00.000Z"),
    });
    const files = unpack(bundle.bytes);
    const bundleFiles = {
      "manifest.json": files["manifest.json"] as string,
      "frames.ndjson": files["frames.ndjson"] as string,
      "attestation.json": files["attestation.json"] as string,
      "redactions.json": files["redactions.json"] as string,
    };

    const clean = verifyRunExport(bundleFiles);
    expect(clean.ok).toBe(true);
    expect(
      clean.frames.map((f) => [f.line, f.status, f.digest, f.link]),
    ).toEqual([
      [1, "held", "held", "held"],
      [2, "held", "held", "held"],
      [3, "held", "held", "held"],
    ]);
    expect(clean.checks.every((c) => c.status === "held")).toBe(true);
    expect(clean.checks.map((c) => c.name)).toContain(
      "stream arat_0123456789abcdefghjkmn",
    );

    // Rewrite what frame 2 says happened, and leave its digests alone.
    const lines = bundleFiles["frames.ndjson"].split("\n");
    const tampered = JSON.parse(lines[1] as string);
    tampered.payload_inline.note = "frame 2, edited after the seal";
    lines[1] = JSON.stringify(tampered);
    const result = verifyRunExport({
      ...bundleFiles,
      "frames.ndjson": lines.join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(result.frames.map((f) => f.status)).toEqual([
      "held",
      "broken",
      "held",
    ]);
    expect(result.frames[1]).toMatchObject({
      line: 2,
      seq: 2,
      digest: "broken",
      link: "held",
      reasons: ["payload does not hash to payload_digest"],
    });
    // The shipped verify.mjs, with no Oxagen code, reaches the same verdict.
    const script = runVerifier(
      writeBundle({ ...files, "frames.ndjson": lines.join("\n") }),
    );
    expect(script.ok).toBe(false);
    expect(script.output).toMatch(/frame 2 .*broken: payload/);
    expect(script.output).toMatch(/frame 1 .*held/);
  });

  it("lists what the host redacted and what the bundle withholds by kind and count, never the value", () => {
    const bundle = buildRunExportBundle({
      runId: "arun_5f0c2e9a1b7d4c3e8f6a02",
      source: "ledger",
      segments: [ledgerSegment()],
      key,
      now: new Date(),
    });
    const files = unpack(bundle.bytes);
    const text = files["redactions.json"] as string;
    expect(JSON.parse(text)).toEqual({
      format: "oxagen.run-export.redactions/1",
      redacted: [{ kind: "github_token", count: 1, frames: 1 }],
      redacted_total: 1,
      withheld: [{ kind: "frame_body", count: 1, frames: 1 }],
    });
    expect(text).not.toContain("original_digest");
    expect(text).not.toContain("bbbb");

    // An edited summary is caught: it is unsigned, and trusted only because
    // it matches the frames.
    const edited = verifyRunExport({
      "manifest.json": files["manifest.json"] as string,
      "frames.ndjson": files["frames.ndjson"] as string,
      "attestation.json": files["attestation.json"] as string,
      "redactions.json": JSON.stringify({
        ...JSON.parse(text),
        redacted: [],
        redacted_total: 0,
      }),
    });
    expect(edited.ok).toBe(false);
    expect(edited.checks.find((c) => c.name === "redactions")?.status).toBe(
      "broken",
    );
  });
});
