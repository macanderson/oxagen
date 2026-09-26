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
  type Attestation,
  type AttestationPayload,
  attesterKeyFromPem,
  type ChainCursor,
  digestBytes,
  GENESIS_CURSOR,
  hashEvent,
  type JsonValue,
  legacyJcs,
  merkleRoot,
  sealEvent,
  signAttestation,
  type UnsealedTachoEvent,
  verifyAttestation,
  verifyRunExport,
  wrappedFrameOf,
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
    sealAttestation: null,
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
    sealAttestation: null,
  };
}

/**
 * A wrapped session whose frames carry their sealed events, built the way
 * the export builds them when the stored row rebuilds each event (#3733).
 */
function carriedTachoSegment(
  over: {
    attrs?: Record<string, string>;
    attempt?: string;
    /** Hash each event the way a build before tacho's own `jcs` did. */
    olderHost?: boolean;
  } = {},
): SealedSegment {
  const session = "0a1b2c3d-0000-4000-8000-000000000000";
  const unsealed = (
    kind: string,
    body: Record<string, unknown>,
  ): UnsealedTachoEvent =>
    ({
      v: "tacho/1.0",
      event_id: `ev_${kind}`,
      session_id: "harness-session",
      session_uuid: session,
      root_session_uuid: session,
      ts: "2026-09-14T12:00:00.000Z",
      fidelity: "sdk",
      source: "hook",
      agent: {
        agent_key: "acme.core.cc-laptop",
        fleet_id: "wrk_test",
        runtime: "claude-code",
        harness: "claude-code",
        wrapper_version: "2.1.1",
      },
      turn: { turn_seq: 1 },
      ...(over.attrs === undefined ? {} : { attrs: over.attrs }),
      kind,
      body,
    }) as UnsealedTachoEvent;
  let cursor: ChainCursor = GENESIS_CURSOR;
  const events = [
    unsealed("turn_start", { prompt_length: 12 }),
    unsealed("tool_call", { tool_name: "Read", tool_status: "ok" }),
    unsealed("turn_end", {}),
  ].map((event) => {
    const sealed = sealEvent(event, cursor);
    if (over.olderHost !== true) {
      cursor = sealed.next;
      return sealed.event;
    }
    const { hash: _hash, ...rest } = sealed.event;
    const hash = digestBytes(
      legacyJcs(JSON.parse(JSON.stringify(rest)) as JsonValue),
    );
    cursor = { seq: cursor.seq + 1, prevHash: hash };
    return { ...sealed.event, hash };
  });
  const envelopes = events.map((event) =>
    wrappedFrameOf(event as unknown as Record<string, JsonValue>, null),
  );
  return {
    ...tachoSegment(),
    ...(over.attempt === undefined ? {} : { attemptPublicId: over.attempt }),
    envelopes,
    digests: events.map((event) => event.hash),
  };
}

/** Both verifiers' verdict on one wrapped bundle, as files on disk and in memory. */
function bothVerdicts(files: Record<string, string>) {
  return {
    cli: verifyRunExport({
      "manifest.json": files["manifest.json"]!,
      "attestation.json": files["attestation.json"]!,
      "frames.ndjson": files["frames.ndjson"]!,
      "redactions.json": files["redactions.json"]!,
    }),
    script: runVerifier(writeBundle(files)),
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

  describe("the signature the seal wrote (ADR-195)", () => {
    const RUN = "arun_5f0c2e9a1b7d4c3e8f6a02";

    /** The payload the export recomputes for one ledger segment. */
    function payloadOf(segment: SealedSegment): AttestationPayload {
      return {
        run_id: RUN,
        attempt_id: segment.attemptPublicId,
        frame_count: segment.frameCount,
        merkle_root: segment.merkleRoot,
        archive_segment_digest: String(segment.archiveSegmentDigest),
        enforcement_tier: segment.enforcementTier,
        completeness_gaps: [...segment.completenessGaps],
        replay_grade: segment.replayGrade,
      };
    }

    function exportOf(segment: SealedSegment) {
      const files = unpack(
        buildRunExportBundle({
          runId: RUN,
          source: "ledger",
          segments: [segment],
          key,
          now: new Date("2026-09-14T12:00:00.000Z"),
        }).bytes,
      );
      const attestation = JSON.parse(files["attestation.json"] as string);
      return { files, shipped: attestation.attestations[0] as Attestation };
    }

    it("ships the seal's signature when the seal's key is the deployment's key, and both verifiers hold", () => {
      const base = ledgerSegment({ enforcementTier: "gateway" });
      const sealed = signAttestation(payloadOf(base), key);
      const { files, shipped } = exportOf({
        ...base,
        sealAttestation: { keyId: key.keyId, sig: sealed.sig },
      });
      expect(shipped).toEqual(sealed);
      expect(shipped.payload.enforcement_tier).toBe("gateway");
      expect(verifyAttestation(shipped, key.publicKeyPem)).toBe(true);
      expect(runVerifier(writeBundle(files))).toMatchObject({ ok: true });
    });

    it("ships the seal's signature unchanged when the figures moved after the seal, and the verifier says so (negative)", () => {
      // The seal signed two frames; the segment the export read holds three.
      // Re-signing would attest the new figures. The export never does.
      const base = ledgerSegment();
      const sealed = signAttestation(
        { ...payloadOf(base), frame_count: 2 },
        key,
      );
      const { files, shipped } = exportOf({
        ...base,
        sealAttestation: { keyId: key.keyId, sig: sealed.sig },
      });
      expect(shipped.sig).toBe(sealed.sig);
      expect(shipped.payload.frame_count).toBe(3);
      expect(verifyAttestation(shipped, key.publicKeyPem)).toBe(false);
      const script = runVerifier(writeBundle(files));
      expect(script.ok).toBe(false);
      expect(script.output).toMatch(
        /attestation for arat_0123456789abcdefghjkmn does not verify/,
      );
    });

    it("signs with the current key when the seal's key was rotated away from", () => {
      const rotated = attesterKeyFromPem(
        generateKeyPairSync("ed25519")
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      );
      const base = ledgerSegment();
      const sealed = signAttestation(payloadOf(base), rotated);
      const { files, shipped } = exportOf({
        ...base,
        sealAttestation: { keyId: rotated.keyId, sig: sealed.sig },
      });
      expect(shipped.key_id).toBe(key.keyId);
      expect(shipped.sig).not.toBe(sealed.sig);
      expect(verifyAttestation(shipped, key.publicKeyPem)).toBe(true);
      expect(runVerifier(writeBundle(files))).toMatchObject({ ok: true });
    });

    it("signs with the current key a seal that was written unsigned", () => {
      const { shipped } = exportOf(ledgerSegment());
      expect(shipped.key_id).toBe(key.keyId);
      expect(verifyAttestation(shipped, key.publicKeyPem)).toBe(true);
    });
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

  it("checks exported wrapped content with both offline verifiers", () => {
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [tachoSegment()],
      key,
      now: new Date(),
    });
    const files = unpack(bundle.bytes);
    expect(runVerifier(writeBundle(files)).ok).toBe(true);
    const cliFiles = {
      "manifest.json": files["manifest.json"]!,
      "attestation.json": files["attestation.json"]!,
      "frames.ndjson": files["frames.ndjson"]!,
      "redactions.json": files["redactions.json"]!,
    };
    expect(verifyRunExport(cliFiles).ok).toBe(true);
    const lines = cliFiles["frames.ndjson"].split("\n");
    const changed = JSON.parse(lines[0]!);
    changed.body = { tool_status: "changed" };
    lines[0] = JSON.stringify(changed);
    const tampered = { ...files, "frames.ndjson": lines.join("\n") };
    const standalone = runVerifier(writeBundle(tampered));
    expect(standalone.ok).toBe(false);
    expect(standalone.output).toContain("exported frame bytes do not match");
    const cli = verifyRunExport({
      ...cliFiles,
      "frames.ndjson": tampered["frames.ndjson"],
    });
    expect(cli.ok).toBe(false);
    for (const source of [undefined, "bogus", "ledger"]) {
      const sourceTampered = {
        ...tampered,
        "manifest.json": JSON.stringify({
          ...JSON.parse(files["manifest.json"]!),
          source,
        }),
      };
      const result = runVerifier(writeBundle(sourceTampered));
      expect(result.ok).toBe(false);
      expect(result.output).toContain("the source is invalid");
      expect(
        verifyRunExport({
          ...cliFiles,
          "manifest.json": sourceTampered["manifest.json"],
          "frames.ndjson": tampered["frames.ndjson"],
        }).ok,
      ).toBe(false);
    }
    expect(cli.checks).toContainEqual(
      expect.objectContaining({
        status: "broken",
        detail:
          "the exported frame bytes do not match the signed segment digest",
      }),
    );
  });

  it("recomputes each wrapped frame's hash in both verifiers, and both name the tampered frame (#3733)", () => {
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [carriedTachoSegment()],
      key,
      now: new Date(),
    });
    const files = unpack(bundle.bytes);
    expect(JSON.parse(files["manifest.json"]!).format).toBe(
      "oxagen.run-export/3",
    );
    const cliFiles = {
      "manifest.json": files["manifest.json"]!,
      "attestation.json": files["attestation.json"]!,
      "frames.ndjson": files["frames.ndjson"]!,
      "redactions.json": files["redactions.json"]!,
    };
    const clean = verifyRunExport(cliFiles);
    expect(clean.ok).toBe(true);
    expect(clean.frames.map((f) => [f.seq, f.digest, f.link])).toEqual([
      [0, "held", "held"],
      [1, "held", "held"],
      [2, "held", "held"],
    ]);
    const script = runVerifier(writeBundle(files));
    expect(script.ok).toBe(true);
    expect(script.output).not.toContain("not carried");
    expect(
      runVerifier(
        writeBundle({
          ...files,
          "frames.ndjson": `${files["frames.ndjson"]}\n`,
        }),
      ).ok,
    ).toBe(true);

    // Change what frame 2's tool call returned, in the event and beside it.
    const lines = cliFiles["frames.ndjson"].split("\n");
    const frame = JSON.parse(lines[1]!);
    frame.event.body.tool_status = "error";
    frame.body.tool_status = "error";
    frame.tool_status = "error";
    lines[1] = JSON.stringify(frame);
    const edited = lines.join("\n");
    const cli = verifyRunExport({ ...cliFiles, "frames.ndjson": edited });
    expect(cli.ok).toBe(false);
    expect(cli.frames.map((f) => f.status)).toEqual(["held", "broken", "held"]);
    expect(cli.frames[1]).toMatchObject({
      line: 2,
      seq: 1,
      digest: "broken",
      link: "held",
      reasons: ["the event does not hash to hash"],
    });
    const standalone = runVerifier(
      writeBundle({ ...files, "frames.ndjson": edited }),
    );
    expect(standalone.ok).toBe(false);
    expect(standalone.output).toMatch(
      /frame 2 .*broken: the event does not hash to hash/,
    );
    expect(standalone.output).toMatch(/frame 1 .*held/);

    // Change only the kind shown beside the event.
    const shown = JSON.parse(lines[2]!);
    shown.kind = "tool_call";
    const kindLines = cliFiles["frames.ndjson"].split("\n");
    kindLines[2] = JSON.stringify(shown);
    const kindEdited = kindLines.join("\n");
    expect(
      verifyRunExport({ ...cliFiles, "frames.ndjson": kindEdited }).frames[2],
    ).toMatchObject({
      status: "broken",
      reasons: ["kind differs from the hashed event"],
    });
    expect(
      runVerifier(writeBundle({ ...files, "frames.ndjson": kindEdited }))
        .output,
    ).toMatch(/frame 3 .*broken: kind differs from the hashed event/);
  });

  it("holds in both verifiers when a host names an attribute toJSON, with its keys sorted like any other object", () => {
    // W-09: tacho's jcs follows RFC 8785 for a toJSON member too, so the
    // frame's keys are sorted and verify.mjs reaches the same bytes.
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [carriedTachoSegment({ attrs: { toJSON: "x", a: "y" } })],
      key,
      now: new Date(),
    });
    const files = unpack(bundle.bytes);
    expect(files["frames.ndjson"]).toContain('"attrs":{"a":"y","toJSON":"x"}');
    const { cli, script } = bothVerdicts(files);
    expect(cli.ok).toBe(true);
    expect(cli.frames.every((f) => f.digest === "held")).toBe(true);
    expect(script.output).toMatch(/^HELD /m);
    expect(script.ok).toBe(true);
  });

  it("holds in both verifiers for an older host's event that names an attribute toJSON, in the order it was sealed", () => {
    // canonicalize@1.0.8 wrote an object with a toJSON member by
    // JSON.stringify, keys unsorted, and an older host hashed that text. The
    // frame keeps those keys in the order they were sealed in, and both
    // verifiers accept the older form for such an event.
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [
        carriedTachoSegment({
          attrs: { toJSON: "x", a: "y" },
          olderHost: true,
        }),
      ],
      key,
      now: new Date(),
    });
    const files = unpack(bundle.bytes);
    expect(files["frames.ndjson"]).toContain('"attrs":{"toJSON":"x","a":"y"}');
    const { cli, script } = bothVerdicts(files);
    expect(cli.ok).toBe(true);
    expect(cli.frames.every((f) => f.digest === "held")).toBe(true);
    expect(script.output).toMatch(/^HELD /m);
    expect(script.ok).toBe(true);
  });

  it("breaks the signed content check in both verifiers when a frame's event is stripped (negative)", () => {
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [carriedTachoSegment()],
      key,
      now: new Date(),
    });
    const files = unpack(bundle.bytes);
    const lines = files["frames.ndjson"]!.split("\n");
    const frame = JSON.parse(lines[1]!);
    delete frame.event;
    lines[1] = JSON.stringify(frame);
    const { cli, script } = bothVerdicts({
      ...files,
      "frames.ndjson": lines.join("\n"),
    });
    // The frame alone reads as an older export's frame would...
    expect(cli.frames[1]).toMatchObject({
      status: "held",
      digest: "not_carried",
    });
    // ...and the attester's signature over the exported bytes is what catches it.
    expect(cli.ok).toBe(false);
    expect(cli.checks).toContainEqual(
      expect.objectContaining({
        name: "exported content 0a1b2c3d-0000-4000-8000-000000000000",
        status: "broken",
      }),
    );
    expect(script.ok).toBe(false);
    expect(script.output).toContain("exported frame bytes do not match");
  });

  it("breaks every frame in both verifiers when the events belong to another session than the attempt (negative)", () => {
    const other = "0a1b2c3d-0000-4000-8000-0000000000ff";
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [carriedTachoSegment({ attempt: other })],
      key,
      now: new Date(),
    });
    const { cli, script } = bothVerdicts(unpack(bundle.bytes));
    const reason = `the event belongs to session 0a1b2c3d-0000-4000-8000-000000000000, not ${other}`;
    expect(cli.ok).toBe(false);
    expect(cli.frames.map((f) => f.reasons)).toEqual([
      [reason],
      [reason],
      [reason],
    ]);
    expect(script.ok).toBe(false);
    expect(script.output).toContain(`frame 1 (${other} #0) broken: ${reason}`);
  });

  it("says a wrapped frame without its event is not carried, in the shipped verifier", () => {
    const bundle = buildRunExportBundle({
      runId: "tse_0a1b2c",
      source: "tacho",
      segments: [tachoSegment()],
      key,
      now: new Date(),
    });
    const script = runVerifier(writeBundle(unpack(bundle.bytes)));
    expect(script.ok).toBe(true);
    expect(script.output).toMatch(/frame 1 .*held \(digest not carried\)/);
    expect(script.output).toContain("digest not carried on 3 wrapped frame(s)");
  });

  it.each<[string, (frame: Record<string, unknown>) => void, string | null]>([
    [
      "a null event",
      (f) => {
        f["event"] = null;
      },
      null,
    ],
    [
      "an array for an event",
      (f) => {
        f["event"] = [];
      },
      "event is not a JSON object",
    ],
    [
      "a dropped member",
      (f) => {
        delete f["tool_name"];
      },
      "tool_name differs from the hashed event",
    ],
    [
      "three shown members edited",
      (f) => {
        f["ts"] = "2026-09-14T12:00:59.000Z";
        f["kind"] = "turn_end";
        f["tool_name"] = "Write";
      },
      "kind, tool_name, ts differ from the hashed event",
    ],
    [
      "the event's own hash member edited",
      (f) => {
        (f["event"] as Record<string, unknown>)["hash"] =
          `sha256:${"e".repeat(64)}`;
      },
      "hash differs from the hashed event",
    ],
    [
      "an edited event and nothing beside it",
      (f) => {
        (f["event"] as Record<string, unknown>)["kind"] = "turn_end";
      },
      "the event does not hash to hash; kind differs from the hashed event",
    ],
    [
      "a bytes_ref that is not a string",
      (f) => {
        f["content"] = {
          ...(f["content"] as Record<string, unknown>),
          bytes_ref: 7,
        };
      },
      "content differs from the hashed event",
    ],
  ])(
    "both verifiers give one verdict on a wrapped frame with %s (#3733)",
    (_name, edit, reason) => {
      const files = unpack(
        buildRunExportBundle({
          runId: "tse_0a1b2c",
          source: "tacho",
          segments: [carriedTachoSegment()],
          key,
          now: new Date(),
        }).bytes,
      );
      const lines = files["frames.ndjson"]!.split("\n");
      const frame = JSON.parse(lines[1]!) as Record<string, unknown>;
      edit(frame);
      lines[1] = JSON.stringify(frame);
      const edited: Record<string, string> = {
        ...files,
        "frames.ndjson": lines.join("\n"),
      };

      const cli = verifyRunExport({
        "manifest.json": edited["manifest.json"]!,
        "attestation.json": edited["attestation.json"]!,
        "frames.ndjson": edited["frames.ndjson"]!,
        "redactions.json": edited["redactions.json"]!,
      }).frames[1];
      const script = runVerifier(writeBundle(edited)).output;
      if (reason === null) {
        expect(cli).toMatchObject({ status: "held", digest: "not_carried" });
        expect(script).toMatch(/frame 2 \([^)]*\) held \(digest not carried\)/);
        expect(script).toContain("digest not carried on 1 wrapped frame(s)");
      } else {
        expect(cli).toMatchObject({
          status: "broken",
          reasons: reason.split("; "),
        });
        expect(script).toContain(`frame 2 (`);
        expect(script).toMatch(
          new RegExp(
            `frame 2 \\([^)]*\\) broken: ${reason.replace(/[()]/g, "\\$&")}\\n`,
          ),
        );
      }
    },
  );

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

  it("verifies a frames file an editor saved with one trailing newline", () => {
    const bundle = buildRunExportBundle({
      runId: "arun_5f0c2e9a1b7d4c3e8f6a02",
      source: "ledger",
      segments: [ledgerSegment()],
      key,
      now: new Date("2026-09-14T12:00:00.000Z"),
    });
    const files = unpack(bundle.bytes);
    const frames = files["frames.ndjson"] as string;
    const saved = runVerifier(
      writeBundle({ ...files, "frames.ndjson": `${frames}\n` }),
    );
    expect(saved.ok).toBe(true);
    expect(saved.output).toMatch(/^HELD /m);
    const blank = runVerifier(
      writeBundle({ ...files, "frames.ndjson": `${frames}\n\n` }),
    );
    expect(blank.ok).toBe(false);
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

  // #3814 kept the top-level `body` beside `event.body` in format 3
  // (docs/capabilities/run.export.md). This pins the reason the bytes allow
  // it: the second copy sits in the same line, well inside deflate's 32 KiB
  // window, so the zip stores it as back-references.
  it("stores a carried frame's second copy of its body for a few bytes once zipped", () => {
    const session = "0a1b2c3d-0000-4000-8000-000000000000";
    const frames = (withTopLevelBody: boolean): JsonValue[] =>
      Array.from({ length: 50 }, (_, seq) => {
        // About 2 KB of facts per frame that do not compress on their own.
        const facts = Array.from({ length: 30 }, (_, i) =>
          digestBytes(`${seq}:${i}`),
        );
        const event = {
          v: "tacho/1.0",
          event_id: `ev_${seq}`,
          session_uuid: session,
          seq,
          ts: "2026-09-14T12:00:00.000Z",
          kind: "tool_call",
          prev_hash: digestBytes(`prev:${seq}`),
          hash: digestBytes(`hash:${seq}`),
          body: { tool_name: "Read", tool_status: "ok", facts },
        };
        const frame = wrappedFrameOf(event, null);
        if (withTopLevelBody) return frame;
        const { body: _shown, ...rest } = frame;
        return rest;
      });
    const bundleOf = (envelopes: JsonValue[]) =>
      buildRunExportBundle({
        runId: "tse_0a1b2c",
        source: "tacho",
        segments: [{ ...tachoSegment(), frameCount: 50, envelopes }],
        key,
        now: OBSERVED,
      });
    const kept = bundleOf(frames(true));
    const dropped = bundleOf(frames(false));
    const ndjson = (bytes: Uint8Array) =>
      unpack(bytes)["frames.ndjson"]?.length ?? 0;
    // Unzipped, the second copy grows the frames by more than a third.
    expect(ndjson(kept.bytes)).toBeGreaterThan(
      ndjson(dropped.bytes) * (4 / 3),
    );
    // Zipped, it grows the bundle by less than five percent.
    expect(kept.bytes.length).toBeLessThan(dropped.bytes.length * 1.05);
  });
});
