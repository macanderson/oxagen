import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigPanel } from "../config-panel.js";
import {
  getConfigScopePaths,
  clearWorkspaceConfigCache,
  type ResolveWorkspaceConfigOptions,
} from "../../config/resolve.js";
import type { WorkspaceConfig, ConfigScope } from "../../config/schema.js";
import {
  getScopePaths as getSettingsScopePaths,
  clearSettingsCache,
} from "../../settings/resolve.js";

const ESC = String.fromCharCode(27);
const ARROW_UP = `${ESC}[A`;
const ARROW_DOWN = `${ESC}[B`;
const ENTER = "\r";

/** Poll until `cond` holds — Ink delivers stdin/state asynchronously (never fixed sleeps). */
async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

let cwd: string;
let homeDir: string;
let resolveOpts: ResolveWorkspaceConfigOptions;
let settingsResolveOpts: { userSettingsPath: string };

function write(scope: ConfigScope, body: WorkspaceConfig): void {
  const paths = getConfigScopePaths(cwd, resolveOpts);
  mkdirSync(join(paths[scope], ".."), { recursive: true });
  writeFileSync(paths[scope], JSON.stringify(body), "utf8");
}

function readDoc(scope: ConfigScope): Record<string, unknown> {
  return JSON.parse(
    readFileSync(getConfigScopePaths(cwd, resolveOpts)[scope], "utf8"),
  ) as Record<string, unknown>;
}

/** Reads `.oxagen/settings.json` (project scope) — a different file from workspace.json. */
function readSettingsDoc(
  scope: "user" | "project" | "local" = "project",
): Record<string, unknown> {
  const path = getSettingsScopePaths({ cwd, ...settingsResolveOpts })[scope];
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-panel-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "oxagen-panel-home-"));
  resolveOpts = {
    managedConfigPath: join(homeDir, "managed.json"),
    userConfigPath: join(homeDir, "user.json"),
  };
  settingsResolveOpts = {
    userSettingsPath: join(homeDir, "settings-user.json"),
  };
  clearWorkspaceConfigCache();
  clearSettingsCache();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  clearWorkspaceConfigCache();
  clearSettingsCache();
});

describe("ConfigPanel — rendering", () => {
  it("shows resolved rows with their winning scope, the tier chain header, and suggestions", async () => {
    write("org", { packageManagers: { primary: "pnpm" } });
    write("repo", { vcs: { commit: { convention: "cc" } } });
    const { lastFrame } = render(
      <ConfigPanel cwd={cwd} onClose={() => {}} resolveOpts={resolveOpts} />,
    );
    await until(() => (lastFrame() ?? "").includes("packageManagers.primary"));
    const frame = lastFrame()!;
    expect(frame).toContain("repo ▸ workspace ▸ user ▸ org");
    expect(frame).toContain("[org]");
    expect(frame).toContain("vcs.commit.convention");
    expect(frame).toContain("[repo]");
    expect(frame).toContain("vision.statement"); // unset suggestion
    expect(frame).toContain("[unset]");
  });
});

describe("ConfigPanel — navigation and keys", () => {
  it("moves the highlight with the arrow keys", async () => {
    write("repo", {
      vision: { statement: "ship" },
      packageManagers: { primary: "pnpm" },
    });
    const { lastFrame, stdin } = render(
      <ConfigPanel cwd={cwd} onClose={() => {}} resolveOpts={resolveOpts} />,
    );
    await until(() => (lastFrame() ?? "").includes("❯ "));
    // Rows sort by path: packageManagers.primary first, vision.statement second.
    expect(lastFrame()).toMatch(/❯.*packageManagers\.primary/);
    stdin.write(ARROW_DOWN);
    await until(() => /❯.*vision\.statement/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP);
    await until(() => /❯.*packageManagers\.primary/.test(lastFrame() ?? ""));
  });

  it("x unsets the highlighted value from the scope file that set it", async () => {
    write("repo", {
      vision: { statement: "ship" },
      packageManagers: { primary: "pnpm" },
    });
    const { lastFrame, stdin } = render(
      <ConfigPanel cwd={cwd} onClose={() => {}} resolveOpts={resolveOpts} />,
    );
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write("x"); // highlighted: packageManagers.primary
    await until(() =>
      (lastFrame() ?? "").includes("✓ unset packageManagers.primary"),
    );
    expect(readDoc("repo")["packageManagers"]).toBeUndefined();
    expect(readDoc("repo")["vision"]).toEqual({ statement: "ship" });
  });

  it("x on an org-managed row refuses with a lock notice and leaves the file untouched", async () => {
    write("org", { packageManagers: { primary: "pnpm" } });
    const { lastFrame, stdin } = render(
      <ConfigPanel cwd={cwd} onClose={() => {}} resolveOpts={resolveOpts} />,
    );
    await until(() => (lastFrame() ?? "").includes("packageManagers.primary"));
    stdin.write("x");
    await until(() => (lastFrame() ?? "").includes("locked by managed.json"));
    expect(readDoc("org")).toEqual({ packageManagers: { primary: "pnpm" } });
  });

  it("e opens the inline editor prefilled and Enter writes back to the winning scope", async () => {
    write("repo", { packageManagers: { primary: "npm" } });
    const { lastFrame, stdin } = render(
      <ConfigPanel cwd={cwd} onClose={() => {}} resolveOpts={resolveOpts} />,
    );
    await until(() => (lastFrame() ?? "").includes("packageManagers.primary"));
    stdin.write("e");
    await until(() => (lastFrame() ?? "").includes("✎"));
    expect(lastFrame()).toContain("= npm");
    // Clear the prefill ("npm" = 3 backspaces), type the new value, save.
    stdin.write("\u007F\u007F\u007F");
    await until(() => !(lastFrame() ?? "").includes("= npm"));
    stdin.write("pnpm");
    await until(() => (lastFrame() ?? "").includes("pnpm"));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("saved to repo scope"));
    expect(readDoc("repo")["packageManagers"]).toEqual({ primary: "pnpm" });
  });

  it("editing an unset suggestion writes to workspace scope by default", async () => {
    const { lastFrame, stdin } = render(
      <ConfigPanel cwd={cwd} onClose={() => {}} resolveOpts={resolveOpts} />,
    );
    await until(() => (lastFrame() ?? "").includes("vision.statement"));
    stdin.write("e"); // first suggestion row: vision.statement
    await until(() => (lastFrame() ?? "").includes("✎"));
    stdin.write("ship fast");
    await until(() => (lastFrame() ?? "").includes("ship fast"));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("saved to workspace scope"));
    expect(readDoc("workspace")["vision"]).toEqual({ statement: "ship fast" });
  });

  it("Esc cancels an edit without writing; Esc from the list closes the panel", async () => {
    write("repo", { packageManagers: { primary: "npm" } });
    const onClose = vi.fn();
    const { lastFrame, stdin } = render(
      <ConfigPanel cwd={cwd} onClose={onClose} resolveOpts={resolveOpts} />,
    );
    await until(() => (lastFrame() ?? "").includes("packageManagers.primary"));
    stdin.write("e");
    await until(() => (lastFrame() ?? "").includes("✎"));
    stdin.write(ESC);
    await until(() => (lastFrame() ?? "").includes("edit cancelled"));
    expect(onClose).not.toHaveBeenCalled();
    expect(readDoc("repo")["packageManagers"]).toEqual({ primary: "npm" });
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length === 1);
  });
});

describe("ConfigPanel — confirmScope (settings.json row)", () => {
  it("shows the confirmScope row, defaulting to false, tagged [settings] rather than a config tier", async () => {
    const { lastFrame } = render(
      <ConfigPanel
        cwd={cwd}
        onClose={() => {}}
        resolveOpts={resolveOpts}
        settingsResolveOpts={settingsResolveOpts}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("confirmScope"));
    const frame = lastFrame()!;
    expect(frame).toMatch(/confirmScope.*false/);
    expect(frame).toContain("[settings]");
  });

  it("e edits confirmScope and Enter persists a real JSON boolean to project .oxagen/settings.json", async () => {
    const { lastFrame, stdin } = render(
      <ConfigPanel
        cwd={cwd}
        onClose={() => {}}
        resolveOpts={resolveOpts}
        settingsResolveOpts={settingsResolveOpts}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("confirmScope"));
    // confirmScope is always the last row (appended after every Workspace Config
    // row) — arrow-up from the initial selection (index 0) wraps to it.
    stdin.write(ARROW_UP);
    await until(() => /❯.*confirmScope/.test(lastFrame() ?? ""));
    stdin.write("e");
    await until(() => (lastFrame() ?? "").includes("✎"));
    expect(lastFrame()).toContain("= false");
    // Clear the prefilled "false" (5 backspaces), type "true", save.
    stdin.write("\u007F\u007F\u007F\u007F\u007F");
    await until(() => !(lastFrame() ?? "").includes("= false"));
    stdin.write("true");
    await until(() => (lastFrame() ?? "").includes("= true"));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("confirmScope = true"));
    const doc = readSettingsDoc();
    expect(doc["confirmScope"]).toBe(true);
    expect(typeof doc["confirmScope"]).toBe("boolean");
  });

  it("x resets confirmScope back to false in project scope", async () => {
    // Pre-seed confirmScope: true directly in the project settings file.
    mkdirSync(join(cwd, ".oxagen"), { recursive: true });
    writeFileSync(
      join(cwd, ".oxagen", "settings.json"),
      JSON.stringify({ confirmScope: true }),
      "utf8",
    );

    const { lastFrame, stdin } = render(
      <ConfigPanel
        cwd={cwd}
        onClose={() => {}}
        resolveOpts={resolveOpts}
        settingsResolveOpts={settingsResolveOpts}
      />,
    );
    await until(() => /confirmScope.*true/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP);
    await until(() => /❯.*confirmScope/.test(lastFrame() ?? ""));
    stdin.write("x");
    await until(() => (lastFrame() ?? "").includes("reset to false"));
    const doc = readSettingsDoc();
    expect(doc["confirmScope"]).toBe(false);
  });

  it("rejects a non-boolean edit without writing the file", async () => {
    const { lastFrame, stdin } = render(
      <ConfigPanel
        cwd={cwd}
        onClose={() => {}}
        resolveOpts={resolveOpts}
        settingsResolveOpts={settingsResolveOpts}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("confirmScope"));
    stdin.write(ARROW_UP);
    await until(() => /❯.*confirmScope/.test(lastFrame() ?? ""));
    stdin.write("e");
    await until(() => (lastFrame() ?? "").includes("✎"));
    stdin.write("\u007F\u007F\u007F\u007F\u007F"); // clear prefilled "false"
    await until(() => !(lastFrame() ?? "").includes("= false"));
    stdin.write("maybe");
    await until(() => (lastFrame() ?? "").includes("= maybe"));
    stdin.write(ENTER);
    await until(() =>
      (lastFrame() ?? "").includes('confirmScope must be "true" or "false"'),
    );
    expect(existsSync(join(cwd, ".oxagen", "settings.json"))).toBe(false);
  });
});
