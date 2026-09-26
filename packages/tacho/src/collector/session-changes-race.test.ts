/**
 * A write that lands while the first read of a worktree is recording it.
 *
 * `readPreexistingPaths` stats every dirty file, then hashes and copies each
 * one. The session can write a file between the two. The write lands here
 * through the directory listing that sits between them, so the test does
 * not depend on timing. This file mocks `node:fs/promises`, so it stays apart
 * from the tests that boot a daemon.
 */
import { readdirSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeRigs, rig } from "./git-rig.test-support";
import { readPreexistingPaths, readSessionChanges } from "./session-changes";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

afterEach(removeRigs);

it("does not record a file the session wrote while the first read was hashing it", async () => {
  const r = rig();
  // A person's uncommitted edit, from before the session.
  writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const baseline = r.git(r.work, ["rev-parse", "HEAD"]).trim();
  const copies = join(r.root, "tacho", "pre-session", "session");

  // The session writes the file after the stat and before the hash.
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(fsp.readdir).mockImplementationOnce((async (dir: string) => {
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\nsession\n");
    return actual.readdir(dir);
  }) as typeof fsp.readdir);
  const preexisting = await readPreexistingPaths(r.exec, r.work, startedAt, {
    dir: copies,
    capBytes: 1024,
  });
  expect(vi.mocked(fsp.readdir)).toHaveBeenCalled();

  // Not recorded, and no copy of the session's content kept.
  expect(preexisting?.paths).toEqual({});
  expect(readdirSync(copies)).toEqual([]);
  // So the session's line is reported, with the person's beside it.
  const read = await readSessionChanges(
    r.exec,
    r.work,
    { baseline, firstReadAt: startedAt, preexisting },
    copies,
  );
  expect(read?.changes).toMatchObject([
    { repo_relative_path: "a.txt", lines_added: 2, lines_removed: 0 },
  ]);
});
