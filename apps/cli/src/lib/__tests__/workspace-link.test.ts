/**
 * Unit tests for workspace-link.ts.
 *
 * Uses a real temp directory so we exercise actual fs operations without
 * touching the developer's home directory or any git-tracked path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  workspaceLinkPath,
  readWorkspaceLink,
  writeWorkspaceLink,
  clearWorkspaceLink,
  type WorkspaceLink,
} from "../workspace-link.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "workspace-link-test-"));
}

const SAMPLE: WorkspaceLink = {
  orgSlug: "acme",
  orgId: "org_abc123",
  orgName: "Acme Corp",
  workspaceSlug: "main",
  workspaceId: "ws_xyz789",
  workspaceName: "Main Workspace",
  linkedAt: "2026-01-01T00:00:00.000Z",
};

// ── tests ────────────────────────────────────────────────────────────────────

describe("workspaceLinkPath", () => {
  it("returns .oxagen/workspace.json inside cwd", () => {
    expect(workspaceLinkPath("/some/project")).toBe(
      "/some/project/.oxagen/workspace.json",
    );
  });
});

describe("readWorkspaceLink / writeWorkspaceLink round-trip", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no link file exists", () => {
    expect(readWorkspaceLink(tmp)).toBeNull();
  });

  it("writes then reads back identical data", () => {
    writeWorkspaceLink(tmp, SAMPLE);
    const result = readWorkspaceLink(tmp);
    expect(result).toEqual(SAMPLE);
  });

  it("creates the .oxagen directory when it does not yet exist", () => {
    // fresh tmp dir has no .oxagen subdir
    writeWorkspaceLink(tmp, SAMPLE);
    // reading back proves the dir + file were created
    expect(readWorkspaceLink(tmp)).toEqual(SAMPLE);
  });

  it("preserves optional repos array", () => {
    const withRepos: WorkspaceLink = {
      ...SAMPLE,
      repos: [{ provider: "github", fullName: "acme/api" }],
    };
    writeWorkspaceLink(tmp, withRepos);
    expect(readWorkspaceLink(tmp)).toEqual(withRepos);
  });

  it("overwrites an existing link", () => {
    writeWorkspaceLink(tmp, SAMPLE);
    const updated: WorkspaceLink = { ...SAMPLE, workspaceSlug: "staging" };
    writeWorkspaceLink(tmp, updated);
    expect(readWorkspaceLink(tmp)?.workspaceSlug).toBe("staging");
  });
});

describe("clearWorkspaceLink", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false when no link file exists", () => {
    expect(clearWorkspaceLink(tmp)).toBe(false);
  });

  it("deletes the file and returns true", () => {
    writeWorkspaceLink(tmp, SAMPLE);
    expect(clearWorkspaceLink(tmp)).toBe(true);
    // confirm it is gone
    expect(readWorkspaceLink(tmp)).toBeNull();
  });

  it("does not affect other files in .oxagen", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    writeWorkspaceLink(tmp, SAMPLE);
    const other = joinPath(tmp, ".oxagen", "settings.json");
    writeFileSync(other, '{"ok":true}', "utf8");
    clearWorkspaceLink(tmp);
    const { existsSync } = await import("node:fs");
    expect(existsSync(other)).toBe(true);
  });
});

describe("readWorkspaceLink — corrupt file handling", () => {
  let tmp: string;
  let stderrOutput: string;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    tmp = makeTmpDir();
    stderrOutput = "";
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr so we can assert the warning is emitted.
    process.stderr.write = (chunk: unknown): boolean => {
      stderrOutput += String(chunk);
      return true;
    };
  });
  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null and warns on corrupt JSON", async () => {
    const { mkdirSync: mkdir, writeFileSync: writeFile } = await import("node:fs");
    const { join: j } = await import("node:path");
    mkdir(j(tmp, ".oxagen"), { recursive: true });
    writeFile(j(tmp, ".oxagen", "workspace.json"), "{{not json}}", "utf8");
    expect(readWorkspaceLink(tmp)).toBeNull();
    expect(stderrOutput).toMatch(/Warning: corrupt workspace link/);
  });
});
