/**
 * Session id + fleet path tests (ADR-023).
 *
 * ids.ts: the `s-<base36 time>-<4 rand>` format, its time-sortability (equal
 * -length base36 timestamps sort lexicographically == numerically), the short
 * display tail, and reference resolution (exact / tail / unique prefix, null on
 * ambiguous or unknown).
 *
 * paths.ts: project identity is the nearest ancestor with a `.git` (a directory
 * in a normal checkout, a FILE in a linked worktree; cwd itself outside any
 * repo), the stable 12-hex project hash, and the `OXAGEN_FLEET_DIR` override.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSessionId, newSessionId, resolveSidRef, shortSid } from "../ids.js";
import { fleetRoot, projectHash, projectRoot } from "../paths.js";

describe("session ids", () => {
  it("newSessionId matches the s-<base36>-<4rand> shape", () => {
    const id = newSessionId();
    expect(id).toMatch(/^s-[0-9a-z]+-[0-9a-z]{4}$/);
    expect(isSessionId(id)).toBe(true);
  });

  it("isSessionId accepts real ids and rejects everything else", () => {
    expect(isSessionId("s-abcd-1111")).toBe(true);
    expect(isSessionId("nope")).toBe(false);
    expect(isSessionId("s-abcd")).toBe(false); // no random tail
    expect(isSessionId("s-abcd-111")).toBe(false); // tail too short
    expect(isSessionId("s-abcd-11111")).toBe(false); // tail too long
    expect(isSessionId("s-ABCD-1111")).toBe(false); // uppercase not allowed
    expect(isSessionId("x-abcd-1111")).toBe(false); // wrong prefix
    expect(isSessionId("")).toBe(false);
  });

  it("ids minted with increasing timestamps sort lexicographically", () => {
    // All three timestamps fall in [36^7, 36^8), so their base36 forms are the
    // same length (8 digits) and lexicographic order == numeric order; the
    // random tail cannot change the ordering because the time segment differs.
    const times = [1_000_000_000_000, 1_500_000_000_000, 2_000_000_000_000];
    const ids = times.map((t) => newSessionId(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it("shortSid returns the random tail, or the whole id when there is none", () => {
    expect(shortSid("s-mcqk3x9a-7f2q")).toBe("7f2q");
    expect(shortSid("s-abcd-1111")).toBe("1111");
    expect(shortSid("noseparators")).toBe("noseparators"); // no third segment → whole id
    expect(shortSid("s-abcd-")).toBe("s-abcd-"); // empty tail → whole id
  });

  it("resolveSidRef resolves exact, tail, and unique prefixes; null otherwise", () => {
    const k1 = "s-abcd-1111";
    const k2 = "s-abcd-2222";
    const k3 = "s-wxyz-3333";
    const known = [k1, k2, k3];

    expect(resolveSidRef(k1, known)).toBe(k1); // exact full id
    expect(resolveSidRef("3333", known)).toBe(k3); // exact tail
    expect(resolveSidRef("111", known)).toBe(k1); // unique tail prefix
    expect(resolveSidRef("s-wxyz", known)).toBe(k3); // unique id prefix
    expect(resolveSidRef("s-abcd", known)).toBeNull(); // ambiguous (k1, k2)
    expect(resolveSidRef("zzzz", known)).toBeNull(); // unknown tail
    expect(resolveSidRef("nope", known)).toBeNull(); // unknown
    expect(resolveSidRef("s-abcd-1111", [])).toBeNull(); // nothing known
  });
});

describe("project roots and fleet paths", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "oxa-paths-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("projectRoot climbs to the nearest ancestor with a .git directory", async () => {
    const top = join(tmp, "repo");
    const inner = join(top, "a", "b");
    await mkdir(join(top, ".git"), { recursive: true }); // .git as a DIRECTORY
    await mkdir(inner, { recursive: true });
    expect(projectRoot(inner)).toBe(resolve(top));
  });

  it("projectRoot treats a .git FILE (linked worktree) as the root too", async () => {
    const top = join(tmp, "wt");
    const inner = join(top, "nested", "deep");
    await mkdir(inner, { recursive: true });
    await writeFile(
      join(top, ".git"),
      "gitdir: /elsewhere/.git/worktrees/wt\n",
    ); // .git as a FILE
    expect(projectRoot(inner)).toBe(resolve(top));
  });

  it("projectRoot falls back to cwd when no .git exists up the tree", async () => {
    const inner = join(tmp, "no", "git", "here");
    await mkdir(inner, { recursive: true });
    expect(projectRoot(inner)).toBe(resolve(inner));
  });

  it("projectHash is a stable 12-hex digest, distinct per root", async () => {
    const a = projectHash(tmp);
    expect(a).toBe(projectHash(tmp)); // stable: same input → same hash
    expect(a).toMatch(/^[0-9a-f]{12}$/);

    const other = await mkdtemp(join(tmpdir(), "oxa-paths2-"));
    try {
      expect(projectHash(other)).not.toBe(a);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("fleetRoot uses OXAGEN_FLEET_DIR when set, under the project hash", async () => {
    const prev = process.env["OXAGEN_FLEET_DIR"];
    const custom = await mkdtemp(join(tmpdir(), "oxa-fleetdir-"));
    process.env["OXAGEN_FLEET_DIR"] = custom;
    try {
      const cwd = join(tmp, "repo2");
      await mkdir(join(cwd, ".git"), { recursive: true });
      const rootPath = fleetRoot(cwd);
      expect(rootPath).toBe(join(custom, projectHash(projectRoot(cwd))));
      expect(rootPath.startsWith(custom)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["OXAGEN_FLEET_DIR"];
      else process.env["OXAGEN_FLEET_DIR"] = prev;
      await rm(custom, { recursive: true, force: true });
    }
  });

  it("fleetRoot falls back to ~/.oxagen/fleet without the override", () => {
    const prev = process.env["OXAGEN_FLEET_DIR"];
    delete process.env["OXAGEN_FLEET_DIR"];
    try {
      const rootPath = fleetRoot(tmp);
      const base = join(homedir(), ".oxagen", "fleet");
      expect(rootPath.startsWith(base)).toBe(true);
      expect(rootPath).toBe(join(base, projectHash(projectRoot(tmp))));
    } finally {
      if (prev !== undefined) process.env["OXAGEN_FLEET_DIR"] = prev;
    }
  });
});
