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
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonStateFile, writeSensitiveFileAtomic } from "./fs";

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

describe("a write the disk takes only part of", () => {
  // W-05: `writeSync` can take fewer bytes than it was given, and only its
  // return value says so. The rest was never written, and the truncated temp
  // file was fsynced and renamed into place.
  it("writes the rest, so the file holds every byte", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const dir = scratchDir();
    const path = join(dir, "cursor.json");
    const data = JSON.stringify({ shipped: { a: 41 }, pad: "x".repeat(8192) });
    vi.mocked(writeSync).mockImplementationOnce(((
      fd: number,
      buffer: Buffer,
      offset?: number,
      length?: number,
    ) =>
      actual.writeSync(
        fd,
        buffer,
        offset ?? 0,
        Math.floor((length ?? buffer.length) / 2),
      )) as typeof writeSync);
    writeSensitiveFileAtomic(path, data);
    expect(readFileSync(path, "utf8")).toBe(data);
  });

  it("fails and leaves no temp file when the disk takes nothing more", () => {
    const dir = scratchDir();
    const path = join(dir, "cursor.json");
    vi.mocked(writeSync).mockImplementation(() => 0);
    expect(() => writeSensitiveFileAtomic(path, "{}")).toThrow(
      /took 0 of 2 bytes/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("readJsonStateFile", () => {
  it("sets a file that does not parse aside and reads it as absent", () => {
    const dir = scratchDir();
    const path = join(dir, "daemon.json");
    writeFileSync(path, '{"sessions":[{"harnessSess');
    const moved: Array<string | undefined> = [];
    expect(readJsonStateFile(path, (to) => moved.push(to), 1234)).toBe(
      undefined,
    );
    expect(moved).toEqual([`${path}.corrupt-1234`]);
    expect(readdirSync(dir)).toEqual(["daemon.json.corrupt-1234"]);
    expect(readFileSync(`${path}.corrupt-1234`, "utf8")).toBe(
      '{"sessions":[{"harnessSess',
    );
  });

  it("reads a whole file, and a missing one as absent, without moving anything", () => {
    const dir = scratchDir();
    const path = join(dir, "daemon.json");
    const moved = vi.fn();
    expect(readJsonStateFile(path, moved)).toBe(undefined);
    writeFileSync(path, '{"ok":true}');
    expect(readJsonStateFile(path, moved)).toEqual({ ok: true });
    expect(moved).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(["daemon.json"]);
  });
});
