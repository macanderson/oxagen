/**
 * The install lock's stale takeover and release, where two installers race.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireInstallLock } from "./install-lock";

const scratch = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "tacho-install-lock-")));

describe("the install lock under a race", () => {
  it("leaves a live lock another installer took over in between", () => {
    const root = scratch();
    const path = join(root, "install.lock");
    writeFileSync(path, JSON.stringify({ pid: 999_991, at: Date.now() }));
    const rival = JSON.stringify({
      pid: 999_992,
      at: Date.now(),
      token: "rival",
    });
    const lock = acquireInstallLock(root, Date.now, (pid) => {
      if (pid === 999_991) {
        // While this process judges the dead holder, the rival takes the
        // lock over and writes its own.
        writeFileSync(path, rival);
        return false;
      }
      return pid === 999_992;
    });
    expect(lock).toEqual({ heldBy: 999_992 });
    expect(readFileSync(path, "utf8")).toBe(rival);
    expect(readdirSync(root)).toEqual(["install.lock"]);
  });

  it("releases only the lock it still holds", () => {
    const root = scratch();
    const path = join(root, "install.lock");
    const first = acquireInstallLock(root);
    if (!("release" in first)) throw new Error("expected the lock");
    // This run outlived the stale limit and another took the lock over.
    const rival = JSON.stringify({
      pid: process.pid,
      at: Date.now(),
      token: "rival",
    });
    writeFileSync(path, rival);
    first.release();
    expect(readFileSync(path, "utf8")).toBe(rival);
  });

  it("still takes over a stale lock and releases its own", () => {
    const root = scratch();
    const path = join(root, "install.lock");
    writeFileSync(path, JSON.stringify({ pid: 999_993, at: Date.now() }));
    const lock = acquireInstallLock(root, Date.now, () => false);
    if (!("release" in lock)) throw new Error("expected the lock");
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    expect(readdirSync(root)).toEqual(["install.lock"]);
    lock.release();
    expect(readdirSync(root)).toEqual([]);
  });
});
