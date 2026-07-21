/**
 * `oxagen run evidence …` command tests. Mocks the api layer and a memory
 * writer; asserts submit POSTs the parsed manifest file, list GETs with
 * filters, dedupe/pretty/json output routing, and error handling.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({
  apiGetOrThrow: vi.fn(),
  apiPostOrThrow: vi.fn(),
  printTable: vi.fn(
    (
      headers: string[],
      rows: string[][],
      writer: { write(l: string): void },
    ) => {
      writer.write(headers.join(" | "));
      for (const row of rows) writer.write(row.join(" | "));
    },
  ),
}));

import {
  handleRunEvidenceSubmit,
  handleRunEvidenceList,
} from "../run.evidence.js";
import { apiGetOrThrow, apiPostOrThrow } from "../../lib/api.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => out.push(line),
      writeErr: (line) => err.push(line),
    },
    out,
    err,
  };
}

let tmp: string;
const savedExit = process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  tmp = mkdtempSync(join(tmpdir(), "oxagen-run-evidence-"));
});
afterEach(() => {
  process.exitCode = savedExit;
  rmSync(tmp, { recursive: true, force: true });
});

const MANIFEST = {
  runId: "run_1",
  principals: { initiatingPrincipalId: "prn_init" },
  localCheckoutSnapshot: { baseCommitSha: "a".repeat(40) },
};

function writeManifest(value: unknown): string {
  const p = join(tmp, "manifest.json");
  writeFileSync(p, JSON.stringify(value));
  return p;
}

describe("run evidence submit", () => {
  it("POSTs the parsed manifest and emits one JSON line", async () => {
    (apiPostOrThrow as Mock).mockResolvedValue({
      manifestId: "rem_1",
      manifestDigest: "f".repeat(64),
      deduplicated: false,
    });
    const { writer, out, err } = memoryWriter();

    await handleRunEvidenceSubmit(
      { file: writeManifest(MANIFEST), json: true },
      writer,
    );

    expect(apiPostOrThrow).toHaveBeenCalledWith("run/evidence", MANIFEST);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({
      manifestId: "rem_1",
      deduplicated: false,
    });
    expect(err).toEqual([]);
  });

  it("reports a deduplicated resubmission", async () => {
    (apiPostOrThrow as Mock).mockResolvedValue({
      manifestId: "rem_1",
      manifestDigest: "f".repeat(64),
      deduplicated: true,
    });
    const { writer, out } = memoryWriter();

    await handleRunEvidenceSubmit(
      { file: writeManifest(MANIFEST), json: true },
      writer,
    );

    expect(JSON.parse(out[0]!)).toMatchObject({ deduplicated: true });
  });

  it("errors (no POST) when the file is not a JSON object", async () => {
    const { writer, out, err } = memoryWriter();

    await handleRunEvidenceSubmit(
      { file: writeManifest([1, 2, 3]), json: true },
      writer,
    );

    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("must contain a JSON manifest object");
    expect(process.exitCode).toBe(1);
  });

  it("errors when the file does not exist", async () => {
    const { writer, err } = memoryWriter();
    await handleRunEvidenceSubmit(
      { file: join(tmp, "missing.json"), json: true },
      writer,
    );
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(err.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });
});

describe("run evidence list", () => {
  const PAGE = {
    manifests: [
      {
        id: "rem_1",
        runId: "run_1",
        attemptId: null,
        evidenceAuthority: "client_attested",
        manifestDigest: "f".repeat(64),
        createdAt: "2026-07-20T00:00:00.000Z",
        changeCount: 3,
        frameCount: 2,
      },
    ],
    nextCursor: null,
  };

  it("GETs with run-id + limit filters and emits one JSON line", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue(PAGE);
    const { writer, out } = memoryWriter();

    await handleRunEvidenceList(
      { runId: "run_1", limit: "10", json: true },
      writer,
    );

    expect(apiGetOrThrow).toHaveBeenCalledWith("run/evidence", {
      runId: "run_1",
      repositoryId: undefined,
      limit: 10,
      cursor: undefined,
    });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).manifests).toHaveLength(1);
  });

  it("prints a table on a TTY (non-json)", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue(PAGE);
    const { writer, out } = memoryWriter();
    const savedTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await handleRunEvidenceList({ runId: "run_1" }, writer);
    } finally {
      process.stdout.isTTY = savedTTY;
    }

    expect(out.join("\n")).toContain("MANIFEST");
    expect(out.join("\n")).toContain("rem_1");
  });

  it("surfaces an API error to stderr and sets a nonzero exit code", async () => {
    (apiGetOrThrow as Mock).mockRejectedValue(new Error("boom"));
    const { writer, err } = memoryWriter();

    await handleRunEvidenceList({ json: true }, writer);

    expect(err.join("\n")).toContain("boom");
    expect(process.exitCode).toBe(1);
  });
});
