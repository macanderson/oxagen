/**
 * `enrolledHarnesses`: what the daemon's hook-removal detector asks before it
 * checks for Claude Code hooks (#3320). It reads host.json on every call, so a
 * `reassign` that drops a harness is seen without restarting the daemon.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enrolledHarnesses, writeHostFile } from "./host-file";
import { bundleSigner, testHostFile, unsignedBundle } from "./test-support";

const signer = bundleSigner();
const bundle = signer.sign(unsignedBundle());

function scratchPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tacho-harnesses-")), "host.json");
}

describe("enrolledHarnesses", () => {
  it("reads the harnesses host.json names now, not the daemon's startup copy", () => {
    const path = scratchPath();
    const started = testHostFile(signer, bundle, {
      harnesses: ["claude-code"],
    });
    writeHostFile(path, { ...started, harnesses: ["codex"] });
    expect(enrolledHarnesses(path, started)).toEqual(["codex"]);
  });

  it("falls back to the daemon's copy when host.json is gone", () => {
    const started = testHostFile(signer, bundle, { harnesses: ["stella"] });
    expect(enrolledHarnesses(scratchPath(), started)).toEqual(["stella"]);
  });

  it("falls back to the daemon's copy when host.json does not validate", () => {
    const path = scratchPath();
    writeFileSync(path, "{ not json");
    const started = testHostFile(signer, bundle, {
      harnesses: ["claude-code", "codex"],
    });
    expect(enrolledHarnesses(path, started)).toEqual(["claude-code", "codex"]);
  });
});
