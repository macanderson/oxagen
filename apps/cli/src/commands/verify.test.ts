/**
 * `oxagen verify <bundle>` against a real bundle built in the test.
 *
 * The bundle is assembled here from @oxagen/tacho's own primitives rather
 * than @oxagen/inngest-functions' builder, because the CLI must not depend on
 * the job package. It follows the same rules: three ledger frames whose
 * `payload_digest` and `event_digest` are JCS digests, the attempt's
 * `event_stream_digest` fold, the RFC 6962 root over the frame digests, and an
 * Ed25519 attestation by a key generated for the test. No network is touched.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  attesterKeyFromPem,
  digestJcs,
  jcs,
  merkleRoot,
  RUN_EXPORT_FORMAT,
  signAttestation,
  summarizeRunExportRedactions,
} from "@oxagen/tacho";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandWriter } from "../lib/capture-writer.js";
import { verifyBundle } from "./verify.js";

const RUN_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const ATTEMPT_ID = "arat_0a1b2c3d4e5f";

const privateKeyPem = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const key = attesterKeyFromPem(privateKeyPem);

type Payload = { tool: string; step: number };

function ledgerFrame(seq: number, payload: Payload) {
  const identity = {
    attempt_seq: seq,
    event_schema_version: 1,
    event_type: "tool_call",
    stage: "execute",
    payload_digest: digestJcs(payload),
    observed_at: `2026-09-22T09:00:0${seq}.000Z`,
  };
  return {
    ...identity,
    event_digest: digestJcs(identity),
    payload_inline: payload,
  };
}

type Frame = ReturnType<typeof ledgerFrame>;

/** The bundle's text files; `tamper` edits frame 2's payload after signing. */
function bundleFiles(tamper = false): Record<string, string> {
  const frames: Frame[] = [1, 2, 3].map((seq) =>
    ledgerFrame(seq, { tool: "read_file", step: seq }),
  );
  let stream = digestJcs([]);
  for (const f of frames) {
    stream = digestJcs({
      previous: stream,
      entry: [
        f.attempt_seq,
        f.event_schema_version,
        f.event_type,
        f.payload_digest,
      ],
    });
  }
  const root = merkleRoot(frames.map((f) => f.event_digest));
  const segmentDigest = digestJcs(frames.map((f) => f.event_digest));
  const attestation = signAttestation(
    {
      run_id: RUN_ID,
      attempt_id: ATTEMPT_ID,
      frame_count: frames.length,
      merkle_root: root,
      archive_segment_digest: segmentDigest,
      enforcement_tier: "observe",
      completeness_gaps: [],
      replay_grade: null,
    },
    key,
  );
  const manifest = {
    format: RUN_EXPORT_FORMAT,
    run_id: RUN_ID,
    source: "ledger",
    exported_at: "2026-09-22T09:10:00.000Z",
    frame_count: frames.length,
    merkle_root: root,
    attester_key_id: key.keyId,
    attempts: [
      {
        attempt_id: ATTEMPT_ID,
        frame_count: frames.length,
        merkle_root: root,
        archive_segment_digest: segmentDigest,
        event_stream_digest: stream,
        enforcement_tier: "observe",
        completeness_gaps: [],
        replay_grade: null,
      },
    ],
  };
  const redactions = summarizeRunExportRedactions(frames);
  const shipped = tamper
    ? frames.map((f) =>
        f.attempt_seq === 2
          ? { ...f, payload_inline: { tool: "write_file", step: 2 } }
          : f,
      )
    : frames;
  return {
    "manifest.json": JSON.stringify(manifest, null, 2),
    "frames.ndjson": shipped.map((f) => jcs(f)).join("\n"),
    "attestation.json": JSON.stringify(
      {
        public_key_pem: key.publicKeyPem,
        key_id: key.keyId,
        attestations: [attestation],
      },
      null,
      2,
    ),
    "redactions.json": JSON.stringify(redactions, null, 2),
  };
}

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

let dir: string;

function writeZip(files: Record<string, string>): string {
  const path = join(dir, "bundle.zip");
  const entries = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
  );
  writeFileSync(path, zipSync(entries));
  return path;
}

function writeDirectory(files: Record<string, string>): string {
  const path = join(dir, "extracted");
  mkdirSync(path);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(path, name), text);
  }
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-verify-"));
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("oxagen verify", () => {
  it("prints HELD for a clean zip and leaves the exit code at 0", async () => {
    const { writer, out, err } = memoryWriter();
    await verifyBundle(writeZip(bundleFiles()), {}, writer);
    const text = out.join("\n");
    expect(err).toEqual([]);
    expect(text).toContain(
      `frame 1  attempt ${ATTEMPT_ID} #1  held  digest held  link held`,
    );
    expect(text).toContain("merkle root  held");
    expect(text).toContain(`signature ${ATTEMPT_ID}  held`);
    expect(text).toContain("Redacted: none");
    expect(text).toContain("Withheld: none");
    expect(out.at(-1)).toBe(`HELD ${RUN_ID}: 3 frames`);
    expect(text).not.toContain("—");
    expect(process.exitCode).toBeUndefined();
  });

  it("marks a tampered frame 2 broken, keeps 1 and 3 held, and exits 1 (negative)", async () => {
    const { writer, out } = memoryWriter();
    await verifyBundle(writeZip(bundleFiles(true)), {}, writer);
    const text = out.join("\n");
    expect(text).toContain(
      `frame 1  attempt ${ATTEMPT_ID} #1  held  digest held  link held`,
    );
    expect(text).toContain(
      `frame 2  attempt ${ATTEMPT_ID} #2  broken  digest broken  link held  payload does not hash to payload_digest`,
    );
    expect(text).toContain(
      `frame 3  attempt ${ATTEMPT_ID} #3  held  digest held  link held`,
    );
    expect(out.at(-1)).toBe(
      `BROKEN ${RUN_ID}: 1 of 3 frames broken, 0 checks broken`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("verifies an extracted directory the same way", async () => {
    const { writer, out } = memoryWriter();
    await verifyBundle(writeDirectory(bundleFiles()), {}, writer);
    expect(out.at(-1)).toBe(`HELD ${RUN_ID}: 3 frames`);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the verification object with --json", async () => {
    const { writer, out } = memoryWriter();
    await verifyBundle(writeZip(bundleFiles(true)), { json: true }, writer);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] as string) as {
      ok: boolean;
      run_id: string;
      frames: { line: number; status: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.run_id).toBe(RUN_ID);
    expect(parsed.frames.map((f) => f.status)).toEqual([
      "held",
      "broken",
      "held",
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a bundle missing its manifest, on stderr, with exit 1 (negative)", async () => {
    const files = bundleFiles();
    delete files["manifest.json"];
    const { writer, out, err } = memoryWriter();
    await verifyBundle(writeZip(files), {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/missing manifest\.json/);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a file that is not a zip (negative)", async () => {
    const path = join(dir, "bundle.zip");
    writeFileSync(path, "not a zip");
    const { writer, out, err } = memoryWriter();
    await verifyBundle(path, {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/is not a readable zip/);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a path that does not exist (negative)", async () => {
    const { writer, err } = memoryWriter();
    await verifyBundle(join(dir, "nope.zip"), {}, writer);
    expect(err.join("\n")).toMatch(/does not exist/);
    expect(process.exitCode).toBe(1);
  });
});
