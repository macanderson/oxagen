/**
 * Every atomic write in the host goes through `writeFileAtomic`, and a write
 * that fails part way must not leave its temp file beside the target. The
 * target is often a directory the user owns (`~/.claude`, `~/.codex`), so a
 * leftover there is a file nothing ever removes, and an uninstall that must
 * leave the directory byte-identical cannot (#3301).
 *
 * A full disk at `write` or an I/O error at `fsync` cannot be produced on
 * demand, so `node:fs` is wrapped. `openSync` records which path each file
 * descriptor names, and a step fails only for the temp file of the target
 * the test names. The receipts and backups `HarnessFiles` writes first go
 * through untouched, so the failure lands on the harness file itself.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  /** The step that fails, or undefined for none. */
  step: undefined as "writeSync" | "fsyncSync" | "renameSync" | undefined,
  /** The target file name whose temp file fails, `settings.json` for example. */
  target: "",
  /** Which path each open file descriptor names. */
  fds: new Map<number, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const hits = (path: string | undefined, step: string) =>
    fault.step === step &&
    path !== undefined &&
    basename(path).startsWith(`.${fault.target}.`) &&
    path.endsWith(".tmp");
  const injected = (step: string) =>
    Object.assign(new Error(`${step}: injected`), {
      code: step === "writeSync" ? "ENOSPC" : "EIO",
    });
  return {
    ...real,
    openSync: ((path: string, ...rest: unknown[]) => {
      const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest);
      fault.fds.set(fd, String(path));
      return fd;
    }) as typeof real.openSync,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      if (hits(fault.fds.get(fd), "writeSync")) throw injected("writeSync");
      return (real.writeSync as (...a: unknown[]) => number)(fd, ...rest);
    }) as typeof real.writeSync,
    fsyncSync: (fd: number) => {
      if (hits(fault.fds.get(fd), "fsyncSync")) throw injected("fsyncSync");
      real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      if (hits(from, "renameSync")) throw injected("renameSync");
      real.renameSync(from, to);
    },
  };
});

const { writeFileAtomic } = await import("./fs");
const { HarnessFiles } = await import("./harness-file");
const { applyModelBaseUrls } = await import("./model-base-url");
const { applyModelCredentials, helperCommandFor } = await import(
  "./model-credential"
);

const scratches: string[] = [];
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tacho-atomic-")));
  scratches.push(dir);
  return dir;
}

afterEach(() => {
  fault.step = undefined;
  fault.target = "";
  fault.fds.clear();
  for (const dir of scratches.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const STEPS = ["writeSync", "fsyncSync", "renameSync"] as const;

describe("writeFileAtomic", () => {
  it("writes the exact mode it is given", () => {
    const dir = scratch();
    const path = join(dir, "unit.plist");
    writeFileAtomic(path, "<plist/>\n", { mode: 0o640 });
    expect(readFileSync(path, "utf8")).toBe("<plist/>\n");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["unit.plist"]);
  });

  it.each(STEPS)(
    "leaves the old file and no temp file when %s fails",
    (step) => {
      const dir = scratch();
      const path = join(dir, "settings.json");
      writeFileSync(path, '{ "model": "opus" }\n');
      fault.step = step;
      fault.target = "settings.json";
      expect(() =>
        writeFileAtomic(path, '{ "model": "sonnet" }\n', { mode: 0o600 }),
      ).toThrow("injected");
      expect(readdirSync(dir)).toEqual(["settings.json"]);
      expect(readFileSync(path, "utf8")).toBe('{ "model": "opus" }\n');
    },
  );
});

describe("a harness file write that fails part way", () => {
  it.each(STEPS)(
    "leaves no temp file in the harness's own directory when %s fails",
    (step) => {
      const home = scratch();
      const claude = join(home, ".claude");
      mkdirSync(claude);
      const settings = join(claude, "settings.json");
      writeFileSync(settings, '{ "model": "opus" }\n');
      const files = new HarnessFiles(join(home, "tacho"));
      fault.step = step;
      fault.target = "settings.json";
      expect(() =>
        files.write(settings, '{ "model": "opus", "hooks": {} }\n'),
      ).toThrow("injected");
      expect(readdirSync(claude)).toEqual(["settings.json"]);
      expect(readFileSync(settings, "utf8")).toBe('{ "model": "opus" }\n');
    },
  );
});

describe("a model base URL write that fails part way", () => {
  it.each(STEPS)(
    "leaves no temp file in ~/.claude when %s fails",
    async (step) => {
      const home = scratch();
      const claude = join(home, ".claude");
      mkdirSync(claude);
      writeFileSync(join(claude, "settings.json"), '{ "model": "opus" }\n');
      fault.step = step;
      fault.target = "settings.json";
      await expect(
        applyModelBaseUrls(
          { home, port: 4319, harnesses: ["claude-code"] },
          { managedSettingsFile: join(home, "no-managed-settings.json") },
        ),
      ).rejects.toThrow("injected");
      expect(
        readdirSync(claude).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(
        '{ "model": "opus" }\n',
      );
    },
  );
});

describe("a model credential write that fails part way", () => {
  it.each(STEPS)(
    "leaves no temp file in ~/.claude when %s fails",
    async (step) => {
      const home = scratch();
      const claude = join(home, ".claude");
      mkdirSync(claude);
      const original =
        '{ "env": { "ANTHROPIC_API_KEY": "sk-ant-api03-FAKE" } }\n';
      writeFileSync(join(claude, "settings.json"), original);
      fault.step = step;
      fault.target = "settings.json";
      await expect(
        applyModelCredentials(
          {
            home,
            harnesses: ["claude-code"],
            helperCommand: helperCommandFor('"/opt/oxagen/bin/tacho"'),
          },
          { managedSettingsFile: join(home, "no-managed-settings.json") },
        ),
      ).rejects.toThrow("injected");
      expect(
        readdirSync(claude).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(
        original,
      );
    },
  );
});
