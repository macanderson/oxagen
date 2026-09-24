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
  wrappedFrameOf,
} from "./run-export";
import { minimalSession } from "../test-helpers";

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
  over: {
    format?: string;
    redactions?: boolean;
    stream?: string | null;
    attempt?: string;
  } = {},
): RunExportFiles {
  // A wrapped run's attempt is its session: frames that carry their event
  // name it, and the verifier holds them to it.
  const firstEvent = (frames[0] as Record<string, JsonValue> | undefined)?.[
    "event"
  ] as Record<string, JsonValue> | undefined;
  const attempt =
    over.attempt ??
    (typeof firstEvent?.["session_uuid"] === "string"
      ? firstEvent["session_uuid"]
      : "att");
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
      run_id: source === "ledger" ? "arun_1" : "tse_1",
      attempt_id: attempt,
      frame_count: frames.length,
      merkle_root: root,
      archive_segment_digest: digestBytes(frames.map(jcs).join("\n")),
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
          attempt_id: attempt,
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

  it("accepts a format-1 bundle without redactions.json, and requires it from format 2 (negative)", () => {
    expect(
      verifyRunExport(
        bundle("ledger", ledgerFrames(), {
          format: "oxagen.run-export/1",
          redactions: false,
        }),
      ).ok,
    ).toBe(true);
    for (const format of ["oxagen.run-export/2", RUN_EXPORT_FORMAT]) {
      expect(
        verifyRunExport(
          bundle("ledger", ledgerFrames(), { format, redactions: false }),
        ).ok,
      ).toBe(false);
    }
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

  it("holds a frames file an editor saved with one trailing newline", () => {
    const files = bundle("ledger", ledgerFrames());
    const saved = verifyRunExport({
      ...files,
      "frames.ndjson": `${files["frames.ndjson"]}\n`,
    });
    expect(saved.ok).toBe(true);
    expect(saved.frames).toHaveLength(2);
    // A second newline is a blank line, and a blank line is not a frame.
    const blank = verifyRunExport({
      ...files,
      "frames.ndjson": `${files["frames.ndjson"]}\n\n`,
    });
    expect(blank.ok).toBe(false);
    expect(blank.frames[2]?.reasons).toEqual(["line is not a JSON object"]);
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

describe("exported wrapped content", () => {
  it.each(["body", "kind", "content"])(
    "refuses a changed %s with original chain hashes",
    (field) => {
      const files = bundle("tacho", tachoFrames());
      const lines = files["frames.ndjson"].split("\n");
      const frame = JSON.parse(lines[0]!);
      frame[field] = field === "kind" ? "changed" : { changed: true };
      lines[0] = jcs(frame);
      const result = verifyRunExport({
        ...files,
        "frames.ndjson": lines.join("\n"),
      });
      expect(result.ok).toBe(false);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          name: "exported content att",
          status: "broken",
        }),
      );
    },
  );

  it("refuses a manifest naming a different run", () => {
    const files = bundle("tacho", tachoFrames());
    const manifest = JSON.parse(files["manifest.json"]);
    manifest.run_id = "tse_other";
    const result = verifyRunExport({
      ...files,
      "manifest.json": JSON.stringify(manifest),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "run identity att", status: "broken" }),
    );
  });
});

it.each([undefined, "bogus", "ledger"])(
  "rejects source %s when wrapped bytes change",
  (source) => {
    const files = bundle("tacho", tachoFrames());
    const manifest = { ...JSON.parse(files["manifest.json"]), source };
    const lines = files["frames.ndjson"].split("\n");
    const frame = JSON.parse(lines[0]!);
    frame.body = { changed: true };
    lines[0] = jcs(frame);
    const result = verifyRunExport({
      ...files,
      "manifest.json": JSON.stringify(manifest),
      "frames.ndjson": lines.join("\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "source", status: "broken" }),
    );
  },
);

describe("wrapped frames that carry their event (#3733)", () => {
  /** A real sealed session, each frame built the way the export builds it. */
  function carriedFrames(): JsonValue[] {
    return minimalSession().map((event, i) =>
      wrappedFrameOf(
        event as unknown as Record<string, JsonValue>,
        i === 1 ? "tacho://body" : null,
      ),
    );
  }

  /** Edit one frame and re-sign, so only the frame's own check can catch it. */
  function tampered(edit: (frame: Record<string, JsonValue>) => void) {
    const frames = carriedFrames();
    edit(frames[3] as Record<string, JsonValue>);
    return verifyRunExport(bundle("tacho", frames));
  }

  it("recomputes every frame's hash from its event and holds", () => {
    const result = verifyRunExport(bundle("tacho", carriedFrames()));
    expect(result.ok).toBe(true);
    expect(result.frames.every((f) => f.digest === "held")).toBe(true);
    expect(result.frames.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("holds when a bundle mixes carried and not-carried frames", () => {
    const frames = carriedFrames();
    const bare = { ...(frames[2] as Record<string, JsonValue>) };
    delete bare["event"];
    frames[2] = bare;
    const result = verifyRunExport(bundle("tacho", frames));
    expect(result.ok).toBe(true);
    expect(result.frames.map((f) => f.digest)).toEqual([
      "held",
      "held",
      "not_carried",
      "held",
      "held",
      "held",
      "held",
      "held",
    ]);
  });

  it("names the frame whose shown kind differs from its event (negative)", () => {
    const result = tampered((frame) => {
      frame["kind"] = "tool_call";
    });
    expect(result.ok).toBe(false);
    const broken = result.frames.filter((f) => f.status === "broken");
    expect(broken).toEqual([
      expect.objectContaining({
        line: 4,
        seq: 3,
        digest: "broken",
        link: "held",
        reasons: ["kind differs from the hashed event"],
      }),
    ]);
  });

  it("names the frame whose event was edited, even when the shown copy was edited to match (negative)", () => {
    const result = tampered((frame) => {
      const event = frame["event"] as Record<string, JsonValue>;
      const body = { ...(event["body"] as Record<string, JsonValue>) };
      body["tool_name"] = "Write";
      event["body"] = body;
      frame["body"] = body;
      frame["tool_name"] = "Write";
    });
    expect(result.frames[3]).toMatchObject({
      status: "broken",
      digest: "broken",
      reasons: ["the event does not hash to hash"],
    });
    expect(result.frames.filter((f) => f.status === "broken")).toHaveLength(1);
  });

  it("breaks a frame whose event is not an object or which gained a member (negative)", () => {
    expect(
      tampered((frame) => {
        frame["event"] = "not an event";
      }).frames[3],
    ).toMatchObject({
      digest: "broken",
      reasons: ["event is not a JSON object"],
    });
    expect(
      tampered((frame) => {
        frame["note"] = "added";
      }).frames[3],
    ).toMatchObject({
      digest: "broken",
      reasons: ["note differs from the hashed event"],
    });
  });

  it("reads bytes_ref off the frame, where the control plane kept the body", () => {
    const [, second] = carriedFrames() as Array<Record<string, JsonValue>>;
    expect(
      (second?.["content"] as Record<string, JsonValue>)["bytes_ref"],
    ).toBe("tacho://body");
    const result = verifyRunExport(bundle("tacho", carriedFrames()));
    expect(result.redactions?.withheld).toEqual([
      { kind: "frame_body", count: 1, frames: 1 },
    ]);
  });

  it("reads a null event as not carried, the same as an absent one", () => {
    const result = tampered((frame) => {
      frame["event"] = null;
    });
    expect(result.ok).toBe(true);
    expect(result.frames[3]).toMatchObject({
      status: "held",
      digest: "not_carried",
    });
  });

  it("breaks a frame whose event is an array (negative)", () => {
    expect(
      tampered((frame) => {
        frame["event"] = [];
      }).frames[3],
    ).toMatchObject({
      digest: "broken",
      reasons: ["event is not a JSON object"],
    });
  });

  it("breaks a frame that dropped a member its event determines (negative)", () => {
    expect(
      tampered((frame) => {
        delete frame["tool_name"];
      }).frames[3],
    ).toMatchObject({
      digest: "broken",
      reasons: ["tool_name differs from the hashed event"],
    });
  });

  it("names every differing member, sorted, with the plural verb (negative)", () => {
    expect(
      tampered((frame) => {
        // Frame order is ts, kind, tool_name; the reason sorts them.
        frame["tool_name"] = "Write";
        frame["kind"] = "tool_call";
        frame["ts"] = "2026-09-08T10:06:59.000Z";
      }).frames[3],
    ).toMatchObject({
      digest: "broken",
      reasons: ["kind, tool_name, ts differ from the hashed event"],
    });
  });

  it("breaks a frame whose event names a different hash than the frame (negative)", () => {
    // hashEvent leaves `hash` out, so the recomputation still matches; the
    // event's own `hash` member must still be the frame's.
    const result = tampered((frame) => {
      const event = frame["event"] as Record<string, JsonValue>;
      event["hash"] = `sha256:${"e".repeat(64)}`;
    });
    expect(result.frames[3]).toMatchObject({
      digest: "broken",
      reasons: ["hash differs from the hashed event"],
    });
  });

  it("reports both a hash that does not recompute and a member that differs (negative)", () => {
    const result = tampered((frame) => {
      const event = frame["event"] as Record<string, JsonValue>;
      event["kind"] = "tool_call";
    });
    expect(result.frames[3]).toMatchObject({
      digest: "broken",
      reasons: [
        "the event does not hash to hash",
        "kind differs from the hashed event",
      ],
    });
  });

  it("reads a bytes_ref that is not a string as none, so the frame's content differs (negative)", () => {
    const result = tampered((frame) => {
      frame["content"] = {
        ...(frame["content"] as Record<string, JsonValue>),
        bytes_ref: 7,
      };
    });
    expect(result.frames[3]).toMatchObject({
      digest: "broken",
      reasons: ["content differs from the hashed event"],
    });
  });
});

describe("a wrapped frame spliced in from another session (#3733)", () => {
  it("breaks every frame whose event names a session other than the attempt (negative)", () => {
    const frames = minimalSession().map((event) =>
      wrappedFrameOf(event as unknown as Record<string, JsonValue>, null),
    );
    const other = "0192d4a8-7c1e-7a00-8000-0000000000ff";
    const result = verifyRunExport(bundle("tacho", frames, { attempt: other }));
    expect(result.ok).toBe(false);
    expect(result.frames.every((f) => f.digest === "broken")).toBe(true);
    expect(result.frames[0]?.reasons).toEqual([
      `the event belongs to session ${String(
        (frames[0] as Record<string, Record<string, JsonValue>>)["event"]?.[
          "session_uuid"
        ],
      )}, not ${other}`,
    ]);
  });
});
