/**
 * Tacho collector P2: `writeSensitiveFileAtomic` left its sibling temp file
 * on disk whenever the write, fsync, or rename failed — a growing pile of
 * stray files holding whatever sensitive payload the failed write was
 * carrying, on a path (`cursor.json`, `state.json`, host credentials) this
 * function is called against repeatedly.
 */
import {
  fsyncSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSensitiveFileAtomic } from "./fs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: vi.fn(actual.writeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const dirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tacho-fs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.mocked(writeSync).mockRestore();
  vi.mocked(fsyncSync).mockRestore();
  vi.mocked(renameSync).mockRestore();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("writeSensitiveFileAtomic", () => {
  it("removes the sibling temp file when the write fails", () => {
    const dir = scratchDir();
    const path = join(dir, "secret.json");
    vi.mocked(writeSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    expect(() => writeSensitiveFileAtomic(path, "{}")).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the sibling temp file when fsync fails", () => {
    const dir = scratchDir();
    const path = join(dir, "secret.json");
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    expect(() => writeSensitiveFileAtomic(path, "{}")).toThrow(/EIO/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the sibling temp file when the rename fails", () => {
    const dir = scratchDir();
    const path = join(dir, "secret.json");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(() => writeSensitiveFileAtomic(path, "{}")).toThrow(/EACCES/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("still writes the file normally when nothing fails", () => {
    const dir = scratchDir();
    const path = join(dir, "secret.json");
    writeSensitiveFileAtomic(path, '{"ok":true}');
    expect(readdirSync(dir)).toEqual(["secret.json"]);
  });
});
