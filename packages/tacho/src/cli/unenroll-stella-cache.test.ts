/**
 * `tacho unenroll` finishes when it cannot remove the Stella identity cache.
 * The removal ran unguarded after unenroll shredded the credential store and
 * deleted the keys. An EACCES (entries a Stella under sudo left behind) or an
 * ENOTEMPTY (a Stella hook writing during the removal) threw out of the
 * unenroll before it dealt with host.json, and left the host half unenrolled.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ rmTarget: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: (path: string, options?: import("node:fs").RmOptions) => {
      if (path === faults.rmTarget)
        throw Object.assign(new Error(`EACCES: permission denied, ${path}`), {
          code: "EACCES",
        });
      return fs.rmSync(path, options);
    },
  };
});

import { writeSensitiveFileAtomic } from "../host/fs";
import { enroll } from "./enroll";
import { buildRig, seedHome } from "./install-rig";
import { unenroll } from "./unenroll";

const homes: string[] = [];
afterEach(() => {
  faults.rmTarget = "";
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("unenroll and the Stella identity cache", () => {
  it("warns and carries on when the cache cannot be removed", async () => {
    const seed = seedHome();
    homes.push(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    const cache = rig.deps.paths.stellaIdentity;
    writeSensitiveFileAtomic(join(cache, "4242.json"), "{}");
    faults.rmTarget = cache;

    const result = await unenroll({ purge: true }, rig.deps);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("could not remove the Stella identity cache"),
      ]),
    );
    // The steps after the cache still ran.
    expect(existsSync(rig.deps.paths.hostFile)).toBe(false);
    expect(existsSync(rig.deps.paths.wal)).toBe(false);
  });
});
