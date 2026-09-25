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

  it.skipIf(process.getuid?.() === 0)(
    "keeps the old credential and leaves no temp file when the write fails",
    () => {
      const home = scratchHome();
      const dir = dirUnder(home);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "github.json");
      writeFileSync(file, '{ "accessToken": "old" }', { mode: 0o600 });
      chmodSync(dir, 0o500);
      try {
        expect(() =>
          writeCredential("github", { accessToken: "new" }),
        ).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(readFileSync(file, "utf8")).toBe('{ "accessToken": "old" }');
      expect(readdirSync(dir)).toEqual(["github.json"]);
    },
  );
});
