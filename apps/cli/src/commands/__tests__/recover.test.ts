/**
 * `oxagen recover` output-discipline tests (ADR-023 §4).
 *
 * --json → one single-line JSON value on stdout (list → array, entry gains
 * commitExists); pretty → the human view on stdout; a missing hash → uniform
 * stderr error line with exit 1. The commit ledger is mocked (no git / fs).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/commit-ledger.js", () => ({
  readLedger: vi.fn(),
  commitExists: vi.fn(),
}));

import { handleRecover } from "../recover.js";
import { readLedger, commitExists } from "../../lib/commit-ledger.js";

const mockRead = readLedger as unknown as Mock;
const mockExists = commitExists as unknown as Mock;

function makeWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: { write: (l) => void out.push(l), writeErr: (l) => void err.push(l) },
    out,
    err,
  };
}

const ENTRY = {
  hash: "abcdef1234567890",
  at: "2026-07-07T00:00:00.000Z",
  branch: "feat/x",
  cwd: "/repo",
  taskId: "OXA-1",
  message: "fix the thing",
  files: ["src/a.ts"],
};

let prevExit: typeof process.exitCode;

beforeEach(() => {
  prevExit = process.exitCode;
  process.exitCode = 0;
  mockRead.mockReset();
  mockExists.mockReset();
});

afterEach(() => {
  process.exitCode = prevExit;
});

describe("handleRecover", () => {
  it("lists entries as a single-line JSON array in --json mode", async () => {
    mockRead.mockReturnValue([ENTRY]);
    const { writer, out, err } = makeWriter();
    await handleRecover(undefined, { json: true }, writer);
    expect(out).toEqual([JSON.stringify([ENTRY])]);
    expect(err).toEqual([]);
  });

  it("renders the human list in pretty mode", async () => {
    mockRead.mockReturnValue([ENTRY]);
    const { writer, out } = makeWriter();
    await handleRecover(undefined, {}, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Recorded agent commits");
    expect(out[0]).toContain("abcdef12");
    expect(out[0]).toContain("fix the thing");
  });

  it("reports the empty case in pretty mode", async () => {
    mockRead.mockReturnValue([]);
    const { writer, out } = makeWriter();
    await handleRecover(undefined, {}, writer);
    expect(out[0]).toContain("No recorded commits for this repo");
  });

  it("shows one entry with commitExists in --json mode", async () => {
    mockRead.mockReturnValue([ENTRY]);
    mockExists.mockReturnValue(true);
    const { writer, out } = makeWriter();
    await handleRecover("abcdef12", { json: true }, writer);
    expect(JSON.parse(out[0] as string)).toEqual({ ...ENTRY, commitExists: true });
  });

  it("renders one entry with restore instructions in pretty mode", async () => {
    mockRead.mockReturnValue([ENTRY]);
    mockExists.mockReturnValue(false);
    const { writer, out } = makeWriter();
    await handleRecover("abcdef12", {}, writer);
    expect(out[0]).toContain("commit abcdef1234567890");
    expect(out[0]).toContain("(⚠ object not found in repo");
    expect(out[0]).toContain("git -C /repo worktree add ../recovered-abcdef12 abcdef1234567890");
  });

  it("errors to stderr with exit 1 for an unknown hash", async () => {
    mockRead.mockReturnValue([ENTRY]);
    const { writer, out, err } = makeWriter();
    await handleRecover("deadbeef", {}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("No ledger entry for commit deadbeef");
    expect(process.exitCode).toBe(1);
  });
});
