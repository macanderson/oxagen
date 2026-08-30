/**
 * Unit coverage for atomic-write.ts (item 9, fix/cli-config-truth): both
 * config/write.ts and settings/write.ts now route their scope-file writes
 * through `atomicWriteFileSync` instead of a plain `writeFileSync`, so a
 * process kill (or a second parallel CLI session writing the same file — this
 * repo's tree is worked by several parallel agent sessions at once) can never
 * strand a truncated/partial JSON file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-atomic-write-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("atomicWriteFileSync", () => {
  it("writes the file and leaves no temp file behind on success", () => {
    const target = join(dir, "doc.json");
    atomicWriteFileSync(target, JSON.stringify({ a: 1 }));
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ a: 1 }));
    const entries = readdirSync(dir);
    expect(entries).toEqual(["doc.json"]);
  });

  it("overwrites an existing file atomically (rename replaces it in one step)", () => {
    const target = join(dir, "doc.json");
    writeFileSync(target, "old", "utf8");
    atomicWriteFileSync(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["doc.json"]);
  });

  it("on a real rename failure (target is a directory, not a file), the target is untouched and the temp file is cleaned up", () => {
    // renameSync(tmpFile, targetDir) fails at the OS level (EISDIR/ENOTEMPTY on
    // Linux, EEXIST on some platforms) when the destination already exists as
    // a directory — a deterministic, mock-free way to force the failure path.
    const target = join(dir, "doc.json");
    mkdirSync(target); // `target` exists, but as a directory, not a file
    writeFileSync(join(target, "sentinel"), "keep-me", "utf8"); // proves the dir survives untouched

    expect(() => atomicWriteFileSync(target, "corrupted-attempt")).toThrow();

    // The directory (our stand-in "original file") is untouched.
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep-me");
    // The temp file was cleaned up — no stray .tmp litter next to it.
    const entries = readdirSync(dir);
    expect(entries).toEqual(["doc.json"]);
  });
});
