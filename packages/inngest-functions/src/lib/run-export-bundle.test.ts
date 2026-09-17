import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  attesterKeyFromPem,
  digestBytes,
  merkleRoot,
  verifyAttestation,
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

function segment(over: Partial<SealedSegment> = {}): SealedSegment {
  const envelopes = [1, 2, 3].map((n) => ({
    event_id: `e${n}`,
    run_seq: String(n),
    event_type: n === 2 ? "tool.call_completed" : "model.call_completed",
    event_digest: `sha256:${String(n).padStart(64, "0")}`,
  }));
  return {
    attemptId: "a1",
    attemptPublicId: "arat_0123456789abcdefghjkmn",
    frameCount: 3,
    merkleRoot: merkleRoot(envelopes.map((e) => e.event_digest)),
    archiveSegmentDigest: `sha256:${"9".repeat(64)}`,
    enforcementTier: "harness",
    completenessGaps: [],
    replayGrade: "view",
    envelopes,
    digests: envelopes.map((e) => e.event_digest),
    ...over,
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
      segments: [segment()],
      key,
      now: new Date("2026-09-14T12:00:00.000Z"),
    });
    expect(bundle.digest).toBe(digestBytes(bundle.bytes));
    const files = unpack(bundle.bytes);
    expect(Object.keys(files).sort()).toEqual([
      "attestation.json",
      "frames.ndjson",
      "manifest.json",
      "verify.mjs",
    ]);
    const manifest = JSON.parse(files["manifest.json"] as string);
    expect(manifest).toMatchObject({
      format: BUNDLE_FORMAT,
      run_id: "arun_5f0c2e9a1b7d4c3e8f6a02",
      frame_count: 3,
      merkle_root: segment().merkleRoot,
      attester_key_id: key.keyId,
    });
    expect(manifest.attempts[0]).toMatchObject({
      attempt_id: "arat_0123456789abcdefghjkmn",
      replay_grade: "view",
      archive_segment_digest: `sha256:${"9".repeat(64)}`,
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
      segments: [
        segment({
          merkleRoot: "",
          archiveSegmentDigest: null,
          enforcementTier: "gateway",
          replayGrade: "fork",
        }),
      ],
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
          lines[0]?.replace("0000000001", "0000000002") ?? "",
          ...lines.slice(1),
        ].join("\n"),
      }),
    );
    expect(changed).toMatchObject({ ok: false });
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
    const seg = segment({ merkleRoot: "", archiveSegmentDigest: null });
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
});
