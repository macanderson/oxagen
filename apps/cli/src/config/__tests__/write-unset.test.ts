import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPath, unsetPath } from "../write.js";
import { getConfigScopePaths, clearWorkspaceConfigCache } from "../resolve.js";
import type { ConfigWriteCtx } from "../write.js";

let cwd: string;
let homeDir: string;
let ctx: ConfigWriteCtx;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-unset-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "oxagen-unset-home-"));
  ctx = {
    cwd,
    managedConfigPath: join(homeDir, "managed.json"),
    userConfigPath: join(homeDir, "user.json"),
  };
  clearWorkspaceConfigCache();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  clearWorkspaceConfigCache();
});

function readDoc(
  scope: "workspace" | "repo" | "user",
): Record<string, unknown> {
  const path = getConfigScopePaths(cwd, ctx)[scope];
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("unsetPath", () => {
  it("removes a nested leaf and prunes parents the removal leaves empty", () => {
    setPath("workspace", "vcs.commit.convention", "cc", ctx);
    setPath("workspace", "vision.statement", "ship", ctx);
    const result = unsetPath("workspace", "vcs.commit.convention", ctx);
    expect(result.removed).toBe(true);
    const doc = readDoc("workspace");
    expect(doc["vcs"]).toBeUndefined(); // pruned — no `{"vcs":{"commit":{}}}` husk
    expect(doc["vision"]).toEqual({ statement: "ship" });
  });

  it("keeps a parent that still has sibling keys", () => {
    setPath("workspace", "vcs.commit.convention", "cc", ctx);
    setPath("workspace", "vcs.pullRequest.base", "main", ctx);
    unsetPath("workspace", "vcs.commit.convention", ctx);
    expect(readDoc("workspace")["vcs"]).toEqual({
      pullRequest: { base: "main" },
    });
  });

  it("returns removed:false when the path is not present in that scope", () => {
    setPath("workspace", "vision.statement", "ship", ctx);
    expect(unsetPath("workspace", "vcs.commit.convention", ctx).removed).toBe(
      false,
    );
    expect(unsetPath("repo", "vision.statement", ctx).removed).toBe(false);
    // A miss on an absent file must not create the file as a side effect.
    expect(existsSync(getConfigScopePaths(cwd, ctx).repo)).toBe(false);
  });

  it("refuses the org scope — managed.json is read-only to the CLI", () => {
    expect(() => unsetPath("org", "vision.statement", ctx)).toThrow(
      /read-only/,
    );
  });

  it("rejects malformed dotted paths", () => {
    expect(() => unsetPath("workspace", "a..b", ctx)).toThrow(
      /invalid dotted path/,
    );
  });
});
