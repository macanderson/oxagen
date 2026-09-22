import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestBytes, digestJcs, jcs, type JsonValue } from "../digest";
import { hashEvent } from "../chain";
import { attesterKeyFromPem, signAttestation } from "./attestation";
import { merkleRoot } from "./merkle";
import {
  normalizeInstant,
  RUN_EXPORT_FORMAT,
  type RunExportFiles,
  summarizeRunExportRedactions,
  verifyRunExport,
} from "./run-export";

const key = attesterKeyFromPem(
  generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
);

function ledgerFrames(): JsonValue[] {
  return [1, 2].map((n) => {
    const payload = { n };
    const payload_digest = digestJcs(payload);
    const identity = {
      attempt_seq: n,
      event_schema_version: "1",
      event_type: "model.call_completed",
      stage: "model",
      payload_digest,
      observed_at: `2026-09-22T12:00:0${n}.000Z`,
    };
    return {
      ...identity,
      event_digest: digestJcs(identity),
      payload_inline: payload,
      encrypted_payload_ref: null,
      content: { digest: null, bytes_ref: null, redactions: [] },
    };
  });
}

function tachoFrames(): JsonValue[] {
  let prev: string = digestBytes("");
  return [0, 1, 2].map((seq) => {
    const hash = hashEvent({ seq, prev_hash: prev });
    const frame = {
      seq,
      prev_hash: prev,
      hash,
      content: {
        digest: null,
        bytes_ref: seq === 1 ? "tacho://body" : null,
        redactions:
          seq === 2
            ? [
                { path: "bytes:0-4", reason: "jwt", original_digest: hash },
                { path: "bytes:9-12", reason: "jwt", original_digest: hash },
              ]
            : [],
      },
    };
    prev = hash;
    return frame;
  });
}

function bundle(
  source: "ledger" | "tacho",
  frames: JsonValue[],
  over: { format?: string; redactions?: boolean; stream?: string | null } = {},
): RunExportFiles {
  const digests = frames.map(
    (f) =>
      ((f as Record<string, unknown>)["event_digest"] ??
        (f as Record<string, unknown>)["hash"]) as string,
  );
  const root = merkleRoot(digests);
  const stream =
    over.stream !== undefined
      ? over.stream
      : source === "ledger"
        ? frames.reduce<string>((prev, f) => {
            const e = f as Record<string, JsonValue>;
            return digestJcs({
              previous: prev,
              entry: [
                e["attempt_seq"] ?? null,
                e["event_schema_version"] ?? null,
                e["event_type"] ?? null,
                e["payload_digest"] ?? null,
              ],
            });
          }, digestJcs([]))
        : null;
  const attestation = signAttestation(
    {
      run_id: "run",
      attempt_id: "att",
      frame_count: frames.length,
      merkle_root: root,
      archive_segment_digest: digestBytes("x"),
      enforcement_tier: "harness",
      completeness_gaps: [],
      replay_grade: null,
    },
    key,
  );
  const files: RunExportFiles = {
    "manifest.json": JSON.stringify({
      format: over.format ?? RUN_EXPORT_FORMAT,
      run_id: source === "ledger" ? "arun_1" : "tse_1",
      source,
      exported_at: "2026-09-22T12:00:00.000Z",
      frame_count: frames.length,
      merkle_root: root,
      attester_key_id: key.keyId,
      attempts: [
        {
          attempt_id: "att",
          frame_count: frames.length,
          merkle_root: root,
          archive_segment_digest: null,
          event_stream_digest: stream,
          enforcement_tier: "harness",
          completeness_gaps: [],
          replay_grade: null,
        },
      ],
    }),
    "frames.ndjson": frames.map(jcs).join("\n"),
    "attestation.json": JSON.stringify({
      public_key_pem: key.publicKeyPem,
      key_id: key.keyId,
      attestations: [attestation],
    }),
  };
  if (over.redactions !== false) {
    files["redactions.json"] = JSON.stringify(
      summarizeRunExportRedactions(frames),
    );
  }
  return files;
}

describe("verifyRunExport", () => {
  it("holds a clean ledger bundle, including the stream fold", () => {
    const result = verifyRunExport(bundle("ledger", ledgerFrames()));
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "stream att")?.status).toBe(
      "held",
    );
  });

  it("breaks the stream check when the sealed fold differs (negative)", () => {
    const result = verifyRunExport(
      bundle("ledger", ledgerFrames(), { stream: digestBytes("other") }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "stream att")?.status).toBe(
      "broken",
    );
  });

  it("breaks a ledger frame whose attempt_seq skips or whose identity was edited (negative)", () => {
    const frames = ledgerFrames();
    (frames[1] as Record<string, JsonValue>)["event_type"] =
      "tool.call_completed";
    const result = verifyRunExport(bundle("ledger", frames));
    expect(result.frames[1]).toMatchObject({
      status: "broken",
      digest: "broken",
      reasons: ["identity fields do not hash to event_digest"],
    });
    expect(result.frames[0]?.status).toBe("held");
  });

  it("checks a wrapped session's links and says its content digest is not carried", () => {
    const result = verifyRunExport(bundle("tacho", tachoFrames()));
    expect(result.ok).toBe(true);
    expect(result.frames.map((f) => [f.seq, f.digest, f.link])).toEqual([
      [0, "not_carried", "held"],
      [1, "not_carried", "held"],
      [2, "not_carried", "held"],
    ]);
    expect(result.redactions).toEqual({
      format: "oxagen.run-export.redactions/1",
      redacted: [{ kind: "jwt", count: 2, frames: 1 }],
      redacted_total: 2,
      withheld: [{ kind: "frame_body", count: 1, frames: 1 }],
    });
  });

  it("breaks the frame after a re-linked wrapped frame (negative)", () => {
    const frames = tachoFrames();
    (frames[2] as Record<string, JsonValue>)["prev_hash"] = digestBytes("x");
    const result = verifyRunExport(bundle("tacho", frames));
    expect(result.frames[2]).toMatchObject({
      status: "broken",
      link: "broken",
      reasons: ["prev_hash is not the previous frame's hash"],
    });
  });

  it("accepts a format-1 bundle without redactions.json, and requires it at format 2 (negative)", () => {
    expect(
      verifyRunExport(
        bundle("ledger", ledgerFrames(), {
          format: "oxagen.run-export/1",
          redactions: false,
        }),
      ).ok,
    ).toBe(true);
    const missing = verifyRunExport(
      bundle("ledger", ledgerFrames(), { redactions: false }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((c) => c.name === "redactions")?.detail).toBe(
      "redactions.json is missing",
    );
  });

  it("breaks a non-JSON line, a frame outside every attempt and unreadable files (negative)", () => {
    const files = bundle("ledger", ledgerFrames());
    const junk = verifyRunExport({
      ...files,
      "frames.ndjson": `${files["frames.ndjson"]}\nnot json`,
    });
    expect(junk.ok).toBe(false);
    expect(junk.frames[2]).toMatchObject({
      line: 3,
      status: "broken",
      reasons: ["line is not a JSON object"],
    });
    const extra = verifyRunExport({
      ...files,
      "frames.ndjson": `${files["frames.ndjson"]}\n{"hash":"x"}`,
    });
    expect(extra.frames[2]?.reasons).toEqual([
      "frame lies outside every attested attempt",
    ]);
    const unreadable = verifyRunExport({ ...files, "manifest.json": "{" });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.checks[0]).toMatchObject({
      name: "manifest",
      status: "broken",
    });
  });

  it("breaks the key and signature checks under a foreign key (negative)", () => {
    const files = bundle("ledger", ledgerFrames());
    const other = attesterKeyFromPem(
      generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    );
    const attestation = JSON.parse(files["attestation.json"]);
    const result = verifyRunExport({
      ...files,
      "attestation.json": JSON.stringify({
        ...attestation,
        public_key_pem: other.publicKeyPem,
      }),
    });
    expect(result.ok).toBe(false);
    const broken = result.checks
      .filter((c) => c.status === "broken")
      .map((c) => c.name);
    expect(broken).toEqual(["attester key", "signature att"]);
  });

  it("holds a ledger frame whose observed_at the archive spelled as Postgres text", () => {
    const frames = ledgerFrames();
    (frames[0] as Record<string, JsonValue>)["observed_at"] =
      "2026-09-22 12:00:01+00";
    (frames[1] as Record<string, JsonValue>)["observed_at"] =
      "2026-09-22 14:00:02.000000+02";
    expect(verifyRunExport(bundle("ledger", frames)).ok).toBe(true);
  });
});

describe("normalizeInstant", () => {
  it.each([
    ["2026-07-21 12:00:00.123+00", "2026-07-21T12:00:00.123Z"],
    ["2026-07-21 12:00:00.123456+00", "2026-07-21T12:00:00.123Z"],
    ["2026-07-21T14:00:00+02:00", "2026-07-21T12:00:00.000Z"],
    ["2026-07-21 07:30:00-0430", "2026-07-21T12:00:00.000Z"],
    ["2026-07-21T12:00:00.123Z", "2026-07-21T12:00:00.123Z"],
  ])("reads %s as %s", (raw, iso) => {
    expect(normalizeInstant(raw)).toBe(iso);
  });

  it("leaves a value that is not an instant alone (negative)", () => {
    expect(normalizeInstant("yesterday")).toBe("yesterday");
    expect(normalizeInstant("2026-13-45 99:00:00+00")).toBe(
      "2026-13-45 99:00:00+00",
    );
  });
});
