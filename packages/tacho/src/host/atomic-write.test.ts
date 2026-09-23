/**
 * Every atomic write in the host goes through `writeFileAtomic`, and a write
 * that fails part-way must not leave its temp file beside the target. The
 * target is often a directory the user owns (`~/.claude`, `~/.codex`), so a
 * leftover there is a file nothing ever removes and an uninstall that is
 * meant to leave the directory byte-identical does not (#3301).
 *
 * `write` and `fsync` failures (a full disk, an I/O error) cannot be produced
 * on demand from a test, so `node:fs` is wrapped and told when to fail.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const failing = vi.hoisted(() => ({ at: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const fault = (name: string) => {
    const error = new Error(`${name}: injected`) as NodeJS.ErrnoException;
    error.code = name === "writeSync" ? "ENOSPC" : "EIO";
    return error;
  };
  return {
    ...real,
    writeSync: ((...args: Parameters<typeof real.writeSync>) => {
      if (failing.at === "writeSync") throw fault("writeSync");
      return (real.writeSync as (...a: unknown[]) => number)(...args);
    }) as typeof real.writeSync,
    fsyncSync: (fd: number) => {
      if (failing.at === "fsyncSync") throw fault("fsyncSync");
      real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      if (failing.at === "renameSync") throw fault("renameSync");
      real.renameSync(from, to);
    },
  };
});

const { writeFileAtomic, writeSensitiveFileAtomic } = await import("./fs");
const { HarnessFiles } = await import("./harness-file");

const scratch = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "tacho-atomic-")));

afterEach(() => {
  failing.at = undefined;
});

describe("writeFileAtomic", () => {
  it("writes the exact mode, whatever the umask", () => {
    const dir = scratch();
    const path = join(dir, "unit.plist");
    writeFileAtomic(path, "<plist/>\n", { mode: 0o644 });
    expect(readFileSync(path, "utf8")).toBe("<plist/>\n");
    expect(lstatSync(path).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir)).toEqual(["unit.plist"]);
  });

  it.each(["writeSync", "fsyncSync", "renameSync"])(
    "leaves the old file and no temp file when %s fails",
    (step) => {
      const dir = scratch();
      const path = join(dir, "settings.json");
      writeFileSync(path, '{ "model": "opus" }\n');
      failing.at = step;
      expect(() =>
        writeFileAtomic(path, '{ "model": "sonnet" }\n', { mode: 0o600 }),
      ).toThrow("injected");
      expect(readdirSync(dir)).toEqual(["settings.json"]);
      expect(readFileSync(path, "utf8")).toBe('{ "model": "opus" }\n');
    },
  );

  it("cleans up through writeSensitiveFileAtomic too", () => {
    const dir = scratch();
    failing.at = "fsyncSync";
    expect(() =>
      writeSensitiveFileAtomic(join(dir, "host.json"), "{}\n"),
    ).toThrow("injected");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("a harness file write that fails part-way", () => {
  it("leaves no temp file in the harness's own directory", () => {
    const home = scratch();
    const claude = join(home, ".claude");
    mkdirSync(claude);
    const settings = join(claude, "settings.json");
    writeFileSync(settings, '{ "model": "opus" }\n');
    const files = new HarnessFiles(join(home, "tacho"));
    failing.at = "writeSync";
    expect(() => files.write(settings, '{ "hooks": {} }\n')).toThrow();
    expect(readdirSync(claude)).toEqual(["settings.json"]);
    expect(readFileSync(settings, "utf8")).toBe('{ "model": "opus" }\n');
  });
});
