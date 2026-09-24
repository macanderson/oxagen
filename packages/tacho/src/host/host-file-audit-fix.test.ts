/**
 * The harness files host.json records at enroll, so an unenroll run from
 * another environment strips the files enroll wrote.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  harnessFilesRecord,
  readHostFile,
  readHostFileLenient,
  withRecordedHarnessFiles,
  writeHostFile,
} from "./host-file";
import { tachoPaths } from "./paths";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "./test-support";

const signer = bundleSigner();
const bundle = signer.sign(unsignedBundle());

describe("harness_files", () => {
  // The terminal that enrolled had the variables; the desktop app that
  // unenrolls does not.
  const home = "/Users/dev";
  const enrolled = tachoPaths(
    {
      CLAUDE_CONFIG_DIR: "/Users/dev/claude-work",
      CODEX_HOME: "/Users/dev/codex-work",
      CURSOR_CONFIG_DIR: "/Users/dev/cursor-work",
      STELLA_HOME: "/Users/dev/stella-work",
    },
    home,
    "darwin",
  );
  const unenrolling = tachoPaths({}, home, "darwin");

  it("round-trips through host.json and moves the paths back to the enrolled ones", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tacho-host-")), "host.json");
    writeHostFile(path, {
      ...testHostFile(signer, bundle),
      harness_files: harnessFilesRecord(enrolled),
    });
    const host = readHostFile(path);
    const paths = withRecordedHarnessFiles(unenrolling, host);
    expect(paths.claudeSettings).toBe(enrolled.claudeSettings);
    expect(paths.claudeProjects).toBe(enrolled.claudeProjects);
    expect(paths.codexHooks).toBe(enrolled.codexHooks);
    expect(paths.cursorHooks).toEqual(enrolled.cursorHooks);
    expect(paths.stellaToml).toBe(enrolled.stellaToml);
    expect(paths.stellaSettingsJson).toBe(enrolled.stellaSettingsJson);
    expect(paths.claudeDesktopConfig).toBe(enrolled.claudeDesktopConfig);
    // Tacho's own state stays where this process resolved it.
    expect(paths.root).toBe(unenrolling.root);
    expect(paths.hostFile).toBe(unenrolling.hostFile);
  });

  it("leaves the paths alone for a host enrolled before the record existed", () => {
    expect(
      withRecordedHarnessFiles(unenrolling, testHostFile(signer, bundle)),
    ).toEqual(unenrolling);
    expect(withRecordedHarnessFiles(unenrolling, undefined)).toEqual(
      unenrolling,
    );
  });

  it("records a platform with no Claude Desktop build as null and reads it back", () => {
    const linux = tachoPaths({}, "/home/dev", "linux");
    const record = harnessFilesRecord(linux);
    expect(record.claude_desktop_config).toBeNull();
    const darwin = tachoPaths({}, "/home/dev", "darwin");
    expect(
      withRecordedHarnessFiles(darwin, { harness_files: record })
        .claudeDesktopConfig,
    ).toBeUndefined();
  });

  it("carries a member a newer binary added, and survives in a salvaged read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tacho-host-")), "host.json");
    const record = { ...harnessFilesRecord(enrolled), future_file: "/x" };
    writeHostFile(path, {
      ...testHostFile(signer, bundle),
      harness_files: record,
    });
    expect(readHostFile(path)?.harness_files).toEqual(record);
    writeFileSync(
      path,
      JSON.stringify({
        host_enrollment_id: TEST_ENROLLMENT,
        port: "not a number",
        harness_files: record,
      }),
    );
    const read = readHostFileLenient(path);
    expect(read.host).toBeUndefined();
    expect(read.salvaged?.harness_files).toEqual(record);
    expect(
      withRecordedHarnessFiles(unenrolling, read.salvaged).claudeSettings,
    ).toBe(enrolled.claudeSettings);
  });
});
