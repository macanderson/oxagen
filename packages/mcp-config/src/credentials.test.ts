/**
 * The credential file lives under the home directory the process has at the
 * time of the call. A test points `HOME` at a scratch directory and every
 * read, write and delete lands there, never in the developer's own
 * `~/.config/oxagen/credentials` (#3330).
 */
import {
  chmodSync,
  existsSync,
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
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * A failed step inside `writeCredential`, injected through `node:fs`. A full
 * disk at `write` or an I/O error at `fsync` cannot be produced on demand.
 * `openSync` records which path each file descriptor names, so a step fails
 * only for the temp file and never for the test's own setup.
 */
const fault = vi.hoisted(() => ({
  step: undefined as "writeSync" | "fsyncSync" | "renameSync" | undefined,
  fds: new Map<number, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const isTemp = (path: string | undefined) =>
    path !== undefined && path.endsWith(".tmp");
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
      if (fault.step === "writeSync" && isTemp(fault.fds.get(fd)))
        throw injected("writeSync");
      return (real.writeSync as (...a: unknown[]) => number)(fd, ...rest);
    }) as typeof real.writeSync,
    fsyncSync: (fd: number) => {
      if (fault.step === "fsyncSync" && isTemp(fault.fds.get(fd)))
        throw injected("fsyncSync");
      real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      if (fault.step === "renameSync" && isTemp(String(from)))
        throw injected("renameSync");
      real.renameSync(from, to);
    },
  };
});

// `HOME` points at a scratch directory before the module under test is
// imported. A regression back to an import-time binding then fails the first
// test below and still writes nowhere near the real home directory.
const importHome = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mcp-credentials-import-")),
  );
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return { dir, saved };
});

const {
  deleteCredential,
  getCredentialFilePath,
  readCredential,
  writeCredential,
} = await import("./credentials.ts");

const scratches: string[] = [];

/** A scratch home, set as `HOME` (and `USERPROFILE`, which Windows reads). */
function scratchHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mcp-credentials-")));
  scratches.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return home;
}

const dirUnder = (home: string) =>
  join(home, ".config", "oxagen", "credentials");

afterEach(() => {
  fault.step = undefined;
  vi.unstubAllEnvs();
  for (const dir of scratches.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(importHome.saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(importHome.dir, { recursive: true, force: true });
});

describe("the credentials directory", () => {
  it("follows HOME at call time, not at import time", () => {
    const first = scratchHome();
    expect(getCredentialFilePath("github")).toBe(
      join(dirUnder(first), "github.json"),
    );
    const second = scratchHome();
    expect(getCredentialFilePath("github")).toBe(
      join(dirUnder(second), "github.json"),
    );
  });

  it("writes, reads and deletes under the scratch home", () => {
    const home = scratchHome();
    writeCredential("github", { accessToken: "tok_scratch" });
    const file = join(dirUnder(home), "github.json");
    expect(existsSync(file)).toBe(true);
    expect(readCredential("github")?.accessToken).toBe("tok_scratch");
    deleteCredential("github");
    expect(existsSync(file)).toBe(false);
    expect(readCredential("github")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("writeCredential", () => {
  it("replaces a world-readable file with a 0600 one", () => {
    const home = scratchHome();
    const dir = dirUnder(home);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "github.json");
    writeFileSync(file, '{ "accessToken": "old" }');
    chmodSync(file, 0o644);
    writeCredential("github", { accessToken: "new" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readCredential("github")?.accessToken).toBe("new");
    expect(readdirSync(dir)).toEqual(["github.json"]);
  });
});

describe("writeCredential when a step fails", () => {
  // The old credential is what the caller still has. A failed write must
  // leave it byte for byte, and leave nothing else in the directory.
  for (const step of ["writeSync", "fsyncSync", "renameSync"] as const) {
    it(`keeps the old credential and leaves no temp file when ${step} fails`, () => {
      const home = scratchHome();
      const dir = dirUnder(home);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "github.json");
      writeFileSync(file, '{ "accessToken": "old" }', { mode: 0o600 });
      fault.step = step;
      expect(() => writeCredential("github", { accessToken: "new" })).toThrow(
        `${step}: injected`,
      );
      expect(readFileSync(file, "utf8")).toBe('{ "accessToken": "old" }');
      expect(readdirSync(dir)).toEqual(["github.json"]);
    });
  }
});
