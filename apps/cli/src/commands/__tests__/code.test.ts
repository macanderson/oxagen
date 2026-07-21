/**
 * `oxagen code {diff,format,patch,map}` output-discipline tests (ADR-023 §4).
 *
 * The four handlers are straightforward request/response utilities (no streaming
 * or interactive session), so all four are converted fully. Each test asserts
 * the discipline: `--json` emits exactly one single-line JSON value on stdout
 * (shape preserved); pretty mode puts the answer (diff / formatted source /
 * changed-file list / code-map) on stdout; progress + summaries (+/- counts,
 * "no changes", apply/dry-run notes, write confirmations, "no files matched")
 * go to stderr; failures are uniform stderr error lines (`✗ …` / json error
 * object) with the right exit code (2 usage / 1 runtime) and nothing on stdout.
 *
 * A fake CommandWriter captures write/writeErr into arrays, and node:fs is
 * mocked so the file reads/writes are controllable and observable.
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
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({
  apiPostOrThrow: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { handleCodeDiff, handleCodeFormat, handleCodePatch } from "../code.js";
import { apiPostOrThrow, ApiError } from "../../lib/api.js";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";

const mockPost = apiPostOrThrow as unknown as Mock;
const mockReadFile = readFileSync as unknown as Mock;
const mockWriteFile = writeFileSync as unknown as Mock;
const mockExists = existsSync as unknown as Mock;
const mockMkdir = mkdirSync as unknown as Mock;
const mockRm = rmSync as unknown as Mock;

function makeWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (l) => void out.push(l),
      writeErr: (l) => void err.push(l),
    },
    out,
    err,
  };
}

const DIFF_RESULT = {
  diff: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
  changed: true,
  additions: 1,
  deletions: 1,
};
const DIFF_UNCHANGED = { diff: "", changed: false, additions: 0, deletions: 0 };

const FORMAT_RESULT = {
  formatted: '{\n  "a": 1\n}\n',
  changed: true,
  language: "json",
};

const PATCH_RESULT = {
  applied: false,
  files: [
    { path: "a.ts", status: "modified", content: "new a\n" },
    { path: "b.ts", status: "added", content: "new b\n" },
    { path: "c.ts", status: "deleted", content: "" },
  ],
  changedCount: 3,
};

let prevExit: typeof process.exitCode;

beforeEach(() => {
  prevExit = process.exitCode;
  process.exitCode = 0;
  mockPost.mockReset();
  mockReadFile.mockReset().mockReturnValue("");
  mockWriteFile.mockReset();
  mockExists.mockReset().mockReturnValue(false);
  mockMkdir.mockReset();
  mockRm.mockReset();
});

afterEach(() => {
  process.exitCode = prevExit;
});

// ── code diff ───────────────────────────────────────────────────────────────

describe("handleCodeDiff", () => {
  it("emits one single-line JSON value on stdout in --json mode (shape preserved)", async () => {
    mockPost.mockResolvedValueOnce(DIFF_RESULT);
    const { writer, out, err } = makeWriter();
    await handleCodeDiff(
      "before.ts",
      "after.ts",
      { json: true, path: "x.ts", context: "5" },
      writer,
    );
    expect(mockPost).toHaveBeenCalledWith("code/diff", {
      before: "",
      after: "",
      path: "x.ts",
      contextLines: 5,
    });
    expect(out).toEqual([JSON.stringify(DIFF_RESULT)]);
    expect(JSON.parse(out[0] as string)).toEqual(DIFF_RESULT);
    expect(err).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it("puts the diff on stdout and the +/- summary on stderr in pretty mode", async () => {
    mockPost.mockResolvedValueOnce(DIFF_RESULT);
    const { writer, out, err } = makeWriter();
    await handleCodeDiff("before.ts", "after.ts", {}, writer);
    expect(out).toEqual([DIFF_RESULT.diff]);
    expect(err).toEqual(["+1 -1"]);
  });

  it("reports (no changes) on stderr with a clean stdout", async () => {
    mockPost.mockResolvedValueOnce(DIFF_UNCHANGED);
    const { writer, out, err } = makeWriter();
    await handleCodeDiff("before.ts", "after.ts", {}, writer);
    expect(out).toEqual([]);
    expect(err).toEqual(["(no changes)"]);
  });

  it("routes an API failure to a uniform stderr error (exit 1, clean stdout)", async () => {
    mockPost.mockRejectedValueOnce(
      new ApiError("Error 500 from code/diff: boom", 500),
    );
    const { writer, out, err } = makeWriter();
    await handleCodeDiff("before.ts", "after.ts", {}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Error 500 from code/diff");
    expect(process.exitCode).toBe(1);
  });
});

// ── code format ───────────────────────────────────────────────────────────────

describe("handleCodeFormat", () => {
  it("emits one single-line JSON value on stdout in --json mode", async () => {
    mockPost.mockResolvedValueOnce(FORMAT_RESULT);
    const { writer, out, err } = makeWriter();
    await handleCodeFormat("config.json", { json: true }, writer);
    expect(out).toEqual([JSON.stringify(FORMAT_RESULT)]);
    expect(JSON.parse(out[0] as string)).toEqual(FORMAT_RESULT);
    expect(err).toEqual([]);
  });

  it("prints the formatted source on stdout in pretty mode (no --write)", async () => {
    mockPost.mockResolvedValueOnce(FORMAT_RESULT);
    const { writer, out, err } = makeWriter();
    await handleCodeFormat("config.json", {}, writer);
    expect(out).toEqual([FORMAT_RESULT.formatted]);
    expect(err).toEqual([]);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("writes the file and reports the confirmation on stderr with --write (clean stdout)", async () => {
    mockPost.mockResolvedValueOnce(FORMAT_RESULT);
    const { writer, out, err } = makeWriter();
    await handleCodeFormat("config.json", { write: true }, writer);
    expect(mockWriteFile).toHaveBeenCalledWith(
      "config.json",
      FORMAT_RESULT.formatted,
    );
    expect(out).toEqual([]);
    expect(err[0]).toContain("✓ formatted config.json");
  });

  it("still emits the JSON envelope on stdout with --write --json", async () => {
    mockPost.mockResolvedValueOnce(FORMAT_RESULT);
    const { writer, out, err } = makeWriter();
    await handleCodeFormat("config.json", { write: true, json: true }, writer);
    expect(mockWriteFile).toHaveBeenCalledWith(
      "config.json",
      FORMAT_RESULT.formatted,
    );
    expect(out).toEqual([JSON.stringify(FORMAT_RESULT)]);
    expect(err).toEqual([]);
  });

  it("rejects an un-inferrable language as a usage error (exit 2, no API call)", async () => {
    const { writer, out, err } = makeWriter();
    await handleCodeFormat("notes.txt", {}, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Could not infer language for notes.txt");
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("routes an API failure to a uniform stderr error (exit 1, clean stdout)", async () => {
    mockPost.mockRejectedValueOnce(new ApiError("nope", 403));
    const { writer, out, err } = makeWriter();
    await handleCodeFormat("config.json", {}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toBe("✗ nope");
    expect(process.exitCode).toBe(1);
  });
});

// ── code patch ───────────────────────────────────────────────────────────────

describe("handleCodePatch", () => {
  it("emits one single-line JSON value on stdout in --json mode without applying (no --write)", async () => {
    mockPost.mockResolvedValueOnce(PATCH_RESULT);
    const { writer, out, err } = makeWriter();
    await handleCodePatch("patch.diff", { json: true }, writer);
    expect(out).toEqual([JSON.stringify(PATCH_RESULT)]);
    expect(JSON.parse(out[0] as string)).toEqual(PATCH_RESULT);
    expect(err).toEqual([]);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("lists changed files on stdout and the dry-run note on stderr (no --write)", async () => {
    mockPost.mockResolvedValueOnce(PATCH_RESULT);
    const { writer, out, err } = makeWriter();
    await handleCodePatch("patch.diff", {}, writer);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("modified");
    expect(out[0]).toContain("a.ts");
    expect(out[2]).toContain("deleted");
    expect(err.join("\n")).toContain("dry run");
    expect(err.join("\n")).toContain("3 change(s)");
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("applies the patch to disk and reports the count on stderr with --write", async () => {
    mockPost.mockResolvedValueOnce(PATCH_RESULT);
    mockExists.mockReturnValue(true); // the deleted file exists → rmSync runs
    const { writer, out, err } = makeWriter();
    await handleCodePatch("patch.diff", { write: true }, writer);
    expect(out).toHaveLength(3);
    expect(mockWriteFile).toHaveBeenCalledWith("a.ts", "new a\n");
    expect(mockWriteFile).toHaveBeenCalledWith("b.ts", "new b\n");
    expect(mockWriteFile).toHaveBeenCalledTimes(2); // deleted file is not written
    expect(mockRm).toHaveBeenCalledWith("c.ts");
    expect(mockMkdir).toHaveBeenCalledTimes(2);
    expect(err.join("\n")).toContain("✓ applied 3 file(s) to .");
  });

  it("routes an API failure to a uniform stderr error (exit 1, clean stdout)", async () => {
    mockPost.mockRejectedValueOnce(new ApiError("patch boom", 500));
    const { writer, out, err } = makeWriter();
    await handleCodePatch("patch.diff", {}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toBe("✗ patch boom");
    expect(process.exitCode).toBe(1);
  });
});
