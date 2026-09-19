/**
 * `enrolledHarnesses` and `currentEnrollment`: what the daemon's
 * hook-removal detector asks before it checks for Claude Code hooks
 * (#3320). Both read host.json on every call, so a `reassign` that drops a
 * harness, or that swaps the enrollment id along with it, is seen without
 * restarting the daemon (#3398).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentEnrollment,
  enrolledHarnesses,
  writeHostFile,
} from "./host-file";
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

describe("currentEnrollment", () => {
  it("reads a live reassign's harness list and enrollment id together, not the daemon's startup pair", () => {
    // The regression this guards: the harness list used to be re-read on
    // every call while the enrollment id it was checked against stayed
    // fixed at the daemon's startup value, so a `reassign` that changed
    // both left the two disagreeing until the daemon restarted (#3398).
    const path = scratchPath();
    const started = testHostFile(signer, bundle, {
      harnesses: ["claude-code"],
      host_enrollment_id: "tch_started0000000000000",
    });
    writeHostFile(path, {
      ...started,
      harnesses: ["claude-code", "codex"],
      host_enrollment_id: "tch_reassigned000000000",
    });
    expect(currentEnrollment(path, started)).toEqual({
      harnesses: ["claude-code", "codex"],
      enrollmentId: "tch_reassigned000000000",
      verified: true,
    });
  });

  it("falls back to the daemon's copy, harnesses and enrollment id together, when host.json is gone, and reports it unverified", () => {
    const started = testHostFile(signer, bundle, {
      harnesses: ["stella"],
      host_enrollment_id: "tch_started0000000000000",
    });
    expect(currentEnrollment(scratchPath(), started)).toEqual({
      harnesses: ["stella"],
      enrollmentId: "tch_started0000000000000",
      verified: false,
    });
  });

  it("falls back to the daemon's copy, harnesses and enrollment id together, when host.json does not validate, and reports it unverified", () => {
    const path = scratchPath();
    writeFileSync(path, "{ not json");
    const started = testHostFile(signer, bundle, {
      harnesses: ["claude-code", "codex"],
      host_enrollment_id: "tch_started0000000000000",
    });
    expect(currentEnrollment(path, started)).toEqual({
      harnesses: ["claude-code", "codex"],
      enrollmentId: "tch_started0000000000000",
      verified: false,
    });
  });

  it("underlies enrolledHarnesses, so both read the same on-disk pair", () => {
    const path = scratchPath();
    const started = testHostFile(signer, bundle, {
      harnesses: ["claude-code"],
      host_enrollment_id: "tch_started0000000000000",
    });
    writeHostFile(path, {
      ...started,
      harnesses: ["codex"],
      host_enrollment_id: "tch_reassigned000000000",
    });
    expect(enrolledHarnesses(path, started)).toEqual(
      currentEnrollment(path, started).harnesses,
    );
  });
});
