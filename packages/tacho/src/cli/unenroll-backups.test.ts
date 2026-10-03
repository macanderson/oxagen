/**
 * `oxagen agent unenroll --purge` takes every copy of a harness file with it.
 * Settling deletes the copy each receipt names, so a copy whose receipt was
 * lost stayed in the agent's `backups/` after a purge, and such a copy can
 * hold a key the file carried before custody took it.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_BACKUPS } from "../host/harness-file";
import { enroll } from "./enroll";
import { buildRig, seedHome } from "./install-rig";
import { unenroll } from "./unenroll";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("unenroll --purge and the copies of harness files", () => {
  it("removes a copy that no receipt names", async () => {
    const seed = seedHome();
    homes.push(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    const backups = join(rig.deps.paths.dir, HARNESS_BACKUPS);
    mkdirSync(backups, { recursive: true });
    writeFileSync(
      join(backups, "lost.orig"),
      '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-FAKE-LOST-COPY-0001"}}\n',
    );

    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(existsSync(backups)).toBe(false);
  });
});
