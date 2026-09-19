/**
 * `oxagen run export` and `oxagen run chain` output discipline: --json emits the exact contract
 * payload, pretty mode prints the export id, and an API failure goes to
 * stderr. The shared API client is mocked; no network is needed.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({ apiPostOrThrow: vi.fn() }));

import { runChain, runExport } from "../run.js";
import { apiPostOrThrow } from "../../lib/api.js";

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

const post = apiPostOrThrow as Mock;

describe("oxagen run export", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("posts the run id to runs/export and emits the queued export as JSON", async () => {
    post.mockResolvedValue({ exportId: "rexp_0123", status: "queued" });
    const { writer, out, err } = memoryWriter();
    await runExport("tse_0a1b2c", { json: true }, writer);
    expect(post).toHaveBeenCalledWith("runs/export", { runId: "tse_0a1b2c" });
    expect(out).toEqual(['{"exportId":"rexp_0123","status":"queued"}']);
    expect(err).toEqual([]);
  });

  it("prints the export id and where the bundle will be listed in pretty mode", async () => {
    post.mockResolvedValue({ exportId: "rexp_0123", status: "queued" });
    const { writer, out } = memoryWriter();
    await runExport("arun_5f0c", {}, writer);
    expect(out[0]).toBe("Export rexp_0123 queued for arun_5f0c.");
    expect(out[1]).toMatch(/Audit › exports/);
  });

  it("routes an API failure to stderr and writes nothing to stdout (negative)", async () => {
    post.mockRejectedValue(new Error("409 conflict: run_not_sealed"));
    const { writer, out, err } = memoryWriter();
    await runExport("tse_live", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/run_not_sealed/);
  });
});

const CHAIN = {
  runId: "tse_0a1b2c",
  hashRule: "tacho.sha256_prev_hash_v1",
  frameCount: 207,
  firstSeq: "0",
  lastSeq: "206",
  merkleRoot: `sha256:${"a".repeat(64)}`,
  checkpoints: [
    {
      seq: "200",
      chainHead: `sha256:${"a".repeat(64)}`,
      signedAt: "2026-09-11T09:02:00.000Z",
    },
  ],
  gaps: {
    missingSequences: [{ from: "12", to: "14" }],
    missingFrameCount: 3,
    missingBodies: 1,
    recorded: ["chain_break"],
  },
  seals: [
    { sealedAt: "2026-09-11T09:05:00.000Z", terminalStatus: "completed" },
  ],
  enforcementTier: "observe",
  recordedGrade: "inspect",
  ladder: [
    { grade: "inspect", met: true, reason: "frames_recorded" },
    { grade: "view", met: false, reason: "chain_break" },
    { grade: "fork", met: false, reason: "chain_break" },
    { grade: "retry", met: false, reason: "chain_break" },
  ],
  complete: true,
};

describe("oxagen run chain", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("posts the run id to runs/chain and emits the exact payload as JSON", async () => {
    post.mockResolvedValue(CHAIN);
    const { writer, out, err } = memoryWriter();
    await runChain("tse_0a1b2c", { json: true }, writer);
    expect(post).toHaveBeenCalledWith("runs/chain", { runId: "tse_0a1b2c" });
    expect(JSON.parse(out[0] as string)).toEqual(CHAIN);
    expect(err).toEqual([]);
  });

  it("prints the rule, the root, the ladder with a reason per rung, and the gaps", async () => {
    post.mockResolvedValue(CHAIN);
    const { writer, out } = memoryWriter();
    await runChain("tse_0a1b2c", {}, writer);
    const text = out.join("\n");
    expect(text).toContain("tacho.sha256_prev_hash_v1");
    expect(text).toContain(`Merkle root: sha256:${"a".repeat(64)}`);
    expect(text).toContain("recorded grade: inspect");
    expect(text).toContain("✓ inspect: frames_recorded");
    expect(text).toContain("· view: chain_break");
    expect(text).toContain("3 missing frames, 1 missing bodies");
    expect(text).toContain("sequences 12 to 14");
    expect(text).toContain("1 signed checkpoint(s).");
  });

  it("never emits an em dash or en dash separator (clear-prose, negative)", async () => {
    post.mockResolvedValue(CHAIN);
    const { writer, out } = memoryWriter();
    await runChain("tse_0a1b2c", {}, writer);
    const text = out.join("\n");
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });

  it("says what was not recorded rather than printing a zero (negative)", async () => {
    post.mockResolvedValue({
      ...CHAIN,
      merkleRoot: null,
      recordedGrade: null,
      gaps: {
        missingSequences: [],
        missingFrameCount: 0,
        missingBodies: 0,
        recorded: [],
      },
      checkpoints: [],
      complete: false,
    });
    const { writer, out } = memoryWriter();
    await runChain("arun_5f0c", {}, writer);
    const text = out.join("\n");
    expect(text).toContain("Merkle root: not recorded");
    expect(text).toContain("recorded grade: not recorded");
    expect(text).toContain("No gaps found in what was read.");
    expect(text).toContain("these are the gaps of a prefix");
  });

  it("routes an API failure to stderr and writes nothing to stdout (negative)", async () => {
    post.mockRejectedValue(new Error("404 not_found: run_not_found"));
    const { writer, out, err } = memoryWriter();
    await runChain("tse_nope", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/run_not_found/);
  });
});
