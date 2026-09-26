/**
 * `oxagen run export`, `export-status`, `download`, `chain` and `turns` output
 * discipline: --json emits the exact contract payload, pretty mode prints
 * what to do next, and an API failure goes to stderr. The shared API client,
 * the configured API origin and `fetch` are mocked; no network is needed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({
  apiPostOrThrow: vi.fn(),
  printTable: vi.fn(),
}));
vi.mock("../../lib/config.js", () => ({
  getApiUrl: () => "https://api.example.test",
}));

import {
  resolveDownloadUrl,
  runChain,
  runDownload,
  runExport,
  runExportStatus,
  runTurns,
} from "../run.js";
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

  it("prints the export id and the command that checks on it in pretty mode", async () => {
    post.mockResolvedValue({ exportId: "rexp_0123", status: "queued" });
    const { writer, out } = memoryWriter();
    await runExport("arun_5f0c", {}, writer);
    expect(out[0]).toBe("Export rexp_0123 queued for arun_5f0c.");
    expect(out[1]).toContain("oxagen run export-status rexp_0123");
    expect(out.join("\n")).not.toMatch(/Audit › exports/);
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

const TURNS = {
  runId: "tse_0a1b2c",
  turns: [
    {
      turn: 1,
      seq: "1",
      at: "2026-09-11T09:00:01.000Z",
      frames: 22,
      modelSteps: 4,
      toolSteps: 4,
      cost: { micros: "121000", currency: "USD", basis: "client_attested" },
      cumulativeCost: {
        micros: "126000",
        currency: "USD",
        basis: "client_attested",
      },
      tokens: { inputUncached: 16, cacheRead: 48 },
    },
    {
      turn: 2,
      seq: "17",
      at: "2026-09-11T09:00:30.000Z",
      frames: 7,
      modelSteps: 2,
      toolSteps: 3,
      cost: null,
      cumulativeCost: {
        micros: "126000",
        currency: "USD",
        basis: "client_attested",
      },
      tokens: { inputUncached: null, cacheRead: null },
    },
  ],
  complete: true,
};

describe("oxagen run turns", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("posts the run id to runs/turns and emits the exact payload as JSON", async () => {
    post.mockResolvedValue(TURNS);
    const { writer, out, err } = memoryWriter();
    await runTurns("tse_0a1b2c", { json: true }, writer);
    expect(post).toHaveBeenCalledWith("runs/turns", { runId: "tse_0a1b2c" });
    expect(JSON.parse(out[0] as string)).toEqual(TURNS);
    expect(err).toEqual([]);
  });

  it("prints one row per turn with its steps, frames, cache hit, cost and cost so far", async () => {
    post.mockResolvedValue(TURNS);
    const { writer, out } = memoryWriter();
    await runTurns("tse_0a1b2c", {}, writer);
    expect(out[0]).toBe("tse_0a1b2c: 2 turn(s), $0.1260 so far");
    const header = out[2] ?? "";
    expect(header).toMatch(
      /^Turn\s+Model\s+Tool\s+Frames\s+Cache hit\s+Cost\s+So far$/,
    );
    expect((out[3] ?? "").split(/\s{2,}/)).toEqual([
      "1",
      "4",
      "4",
      "22",
      "75%",
      "$0.1210",
      "$0.1260",
    ]);
  });

  it("says what was not recorded rather than printing a zero (negative)", async () => {
    post.mockResolvedValue(TURNS);
    const { writer, out } = memoryWriter();
    await runTurns("tse_0a1b2c", {}, writer);
    const second = (out[4] ?? "").split(/\s{2,}/);
    expect(second.slice(4, 6)).toEqual(["not recorded", "not recorded"]);
    expect(out.join("\n")).not.toMatch(/\$0(\s|$)/);
  });

  it("says a run with no turn recorded none, and a cut list is cut", async () => {
    post.mockResolvedValueOnce({
      runId: "arun_5f0c",
      turns: [],
      complete: true,
    });
    const empty = memoryWriter();
    await runTurns("arun_5f0c", {}, empty.writer);
    expect(empty.out).toEqual([
      "arun_5f0c: 0 turn(s), not recorded so far",
      "The run has recorded no turn yet.",
    ]);
    post.mockResolvedValueOnce({ ...TURNS, complete: false });
    const cut = memoryWriter();
    await runTurns("tse_0a1b2c", {}, cut.writer);
    expect(cut.out.at(-1)).toBe(
      "The run is longer than one read carries. These are its first 2 turns.",
    );
  });

  it("routes an API failure to stderr and writes nothing to stdout (negative)", async () => {
    post.mockRejectedValue(new Error("404 not_found: run_not_found"));
    const { writer, out, err } = memoryWriter();
    await runTurns("tse_nope", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/run_not_found/);
  });
});

const BUNDLE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const BUNDLE_DIGEST = `sha256:${createHash("sha256").update(BUNDLE).digest("hex")}`;

const READY = {
  exportId: "rexp_0123",
  runId: "arun_5f0c",
  status: "ready",
  createdAt: "2026-09-22T09:00:00.000Z",
  completedAt: "2026-09-22T09:01:00.000Z",
  bundleDigest: BUNDLE_DIGEST,
  bundleBytes: 4096,
  merkleRoot: `sha256:${"b".repeat(64)}`,
  frameCount: 3,
  error: null,
  download: {
    url: "/v1/run-exports/download?token=tok",
    expiresAt: "2026-09-22T09:16:00.000Z",
  },
};

const FAILED = {
  ...READY,
  status: "failed",
  completedAt: "2026-09-22T09:01:00.000Z",
  bundleDigest: null,
  bundleBytes: null,
  merkleRoot: null,
  frameCount: null,
  error: "run_not_sealed",
  download: null,
};

describe("resolveDownloadUrl", () => {
  it("keeps an absolute URL", () => {
    expect(
      resolveDownloadUrl("https://cdn.example/x?token=t", "https://api.a"),
    ).toBe("https://cdn.example/x?token=t");
  });

  it("joins a path onto the API origin, not the org-scoped base", () => {
    expect(
      resolveDownloadUrl("/v1/run-exports/download?token=t", "https://api.a/"),
    ).toBe("https://api.a/v1/run-exports/download?token=t");
  });
});

describe("oxagen run export-status", () => {
  beforeEach(() => {
    post.mockReset();
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("posts the export id to runs/export-status and emits the payload as JSON", async () => {
    post.mockResolvedValue(READY);
    const { writer, out, err } = memoryWriter();
    await runExportStatus("rexp_0123", { json: true }, writer);
    expect(post).toHaveBeenCalledWith("runs/export-status", {
      exportId: "rexp_0123",
    });
    expect(JSON.parse(out[0] as string)).toEqual(READY);
    expect(err).toEqual([]);
  });

  it("prints size, digest, frames, the resolved link and its expiry when ready", async () => {
    post.mockResolvedValue(READY);
    const { writer, out } = memoryWriter();
    await runExportStatus("rexp_0123", {}, writer);
    const text = out.join("\n");
    expect(text).toContain("Export rexp_0123 for arun_5f0c: ready");
    expect(text).toContain("Size: 4,096 bytes");
    expect(text).toContain(`Digest: ${BUNDLE_DIGEST}`);
    expect(text).toContain("Frames: 3");
    expect(text).toContain(
      "Download: https://api.example.test/v1/run-exports/download?token=tok",
    );
    expect(text).toContain("Link expires: 2026-09-22T09:16:00.000Z");
    expect(text).toContain("oxagen run download rexp_0123");
    expect(text).not.toContain("—");
  });

  it("prints the job's error and no link when the export failed (negative)", async () => {
    post.mockResolvedValue(FAILED);
    const { writer, out } = memoryWriter();
    await runExportStatus("rexp_0123", {}, writer);
    const text = out.join("\n");
    expect(text).toContain("Export rexp_0123 for arun_5f0c: failed");
    expect(text).toContain("Error: run_not_sealed");
    expect(text).not.toContain("Download:");
  });

  it("routes an API failure to stderr (negative)", async () => {
    post.mockRejectedValue(new Error("404 not_found: run_export_not_found"));
    const { writer, out, err } = memoryWriter();
    await runExportStatus("rexp_nope", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/run_export_not_found/);
    expect(process.exitCode).toBe(1);
  });
});

describe("oxagen run download", () => {
  let dir: string;
  const fetchMock = vi.fn();

  function zipResponse(
    bytes: Uint8Array<ArrayBuffer>,
    headerDigest: string | null,
  ) {
    const headers = new Headers({ "content-type": "application/zip" });
    if (headerDigest !== null) headers.set("x-bundle-digest", headerDigest);
    return new Response(bytes, { status: 200, headers });
  }

  beforeEach(() => {
    post.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    dir = mkdtempSync(join(tmpdir(), "oxagen-run-download-"));
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("fetches the resolved link with no auth header, checks the digest, and writes the zip", async () => {
    post.mockResolvedValue(READY);
    fetchMock.mockResolvedValue(zipResponse(BUNDLE, BUNDLE_DIGEST));
    const target = join(dir, "bundle.zip");
    const { writer, out, err } = memoryWriter();
    await runDownload("rexp_0123", { out: target }, writer);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/run-exports/download?token=tok",
    );
    expect(new Uint8Array(readFileSync(target))).toEqual(BUNDLE);
    expect(out.join("\n")).toContain(`oxagen verify ${target}`);
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a bundle whose bytes do not hash to the recorded digest and writes nothing (negative)", async () => {
    post.mockResolvedValue(READY);
    const tampered = new Uint8Array([...BUNDLE, 9]);
    fetchMock.mockResolvedValue(zipResponse(tampered, null));
    const target = join(dir, "bundle.zip");
    const { writer, out, err } = memoryWriter();
    await runDownload("rexp_0123", { out: target }, writer);
    expect(existsSync(target)).toBe(false);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/Nothing was written/);
    expect(process.exitCode).toBe(1);
  });

  it("refuses when the X-Bundle-Digest header disagrees with the bytes (negative)", async () => {
    post.mockResolvedValue(READY);
    fetchMock.mockResolvedValue(
      zipResponse(BUNDLE, `sha256:${"0".repeat(64)}`),
    );
    const target = join(dir, "bundle.zip");
    const { writer, err } = memoryWriter();
    await runDownload("rexp_0123", { out: target }, writer);
    expect(existsSync(target)).toBe(false);
    expect(err.join("\n")).toMatch(/response header/);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a failed export with its status and error before any fetch (negative)", async () => {
    post.mockResolvedValue(FAILED);
    const { writer, err } = memoryWriter();
    await runDownload("rexp_0123", { out: join(dir, "x.zip") }, writer);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/failed: run_not_sealed/);
    expect(process.exitCode).toBe(1);
  });

  it("refuses an export that is still building (negative)", async () => {
    post.mockResolvedValue({
      ...FAILED,
      status: "building",
      error: null,
      completedAt: null,
    });
    const { writer, err } = memoryWriter();
    await runDownload("rexp_0123", { out: join(dir, "x.zip") }, writer);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/is building, not ready/);
    expect(process.exitCode).toBe(1);
  });
});
