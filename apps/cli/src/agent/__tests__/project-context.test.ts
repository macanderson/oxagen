/**
 * `loadProjectContext` — prose rules (pre-existing behavior, unchanged) plus
 * the Oxagen Workspace Config sections appended after them (design.md §9):
 * vision → anchor block, `enforced` language items → hard rules, `commands`
 * → concrete script references.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectContext } from "../project-context.js";
import {
  clearWorkspaceConfigCache,
  type ResolveWorkspaceConfigOptions,
} from "../../config/resolve.js";

let cwd: string;
let homeDir: string;
let configOpts: ResolveWorkspaceConfigOptions;

function write(relPath: string, content: string): void {
  const full = join(cwd, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// Point the workspace-config resolver's org/user scopes at temp files so
// these tests never read the real ~/.oxagen/managed.json or user.json.
function loadContext() {
  return loadProjectContext(cwd, configOpts);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-project-context-"));
  homeDir = mkdtempSync(join(tmpdir(), "oxagen-project-context-home-"));
  configOpts = {
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

describe("loadProjectContext — prose rules only (pre-existing behavior)", () => {
  it("is unaffected when no workspace.json exists", () => {
    write("CLAUDE.md", "# Rules\nDo the thing.");
    const result = loadContext();
    expect(result.text).toContain("### CLAUDE.md");
    expect(result.text).toContain("Do the thing.");
    expect(result.sources).toEqual(["CLAUDE.md"]);
  });

  it("returns empty text/sources when nothing is present at all", () => {
    const result = loadContext();
    expect(result.text).toBe("");
    expect(result.sources).toEqual([]);
  });
});

describe("loadProjectContext — vision anchor block", () => {
  it("renders statement, principles, goals, and non-goals", () => {
    write(
      ".oxagen/workspace.json",
      JSON.stringify({
        vision: {
          statement: "Ship a reliable knowledge-graph context engine.",
          principles: ["Fix root cause"],
          goals: ["Ship v2"],
          nonGoals: ["Replace settings.json"],
        },
      }),
    );
    const result = loadContext();
    expect(result.text).toContain("### Vision");
    expect(result.text).toContain(
      "Ship a reliable knowledge-graph context engine.",
    );
    expect(result.text).toContain("Fix root cause");
    expect(result.text).toContain("Ship v2");
    expect(result.text).toContain("Replace settings.json");
    expect(result.sources).toContain("workspace config: vision");
  });

  it("omits the Vision section entirely when vision is unset", () => {
    write(".oxagen/workspace.json", JSON.stringify({ orgSlug: "acme" }));
    const result = loadContext();
    expect(result.text).not.toContain("### Vision");
  });
});

describe("loadProjectContext — enforced hard rules", () => {
  it("includes only enforced items, tagged with their language", () => {
    write(
      ".oxagen/workspace.json",
      JSON.stringify({
        languages: {
          typescript: {
            items: [
              {
                id: "no-any",
                kind: "rule",
                text: "No `any`.",
                enforced: true,
                origin: "manual",
              },
              {
                id: "prefer-const",
                kind: "preference",
                text: "Prefer const.",
                origin: "manual",
              }, // not enforced
            ],
          },
        },
      }),
    );
    const result = loadContext();
    expect(result.text).toContain("### Hard rules (enforced)");
    expect(result.text).toContain("[typescript] No `any`.");
    expect(result.text).not.toContain("Prefer const.");
    expect(result.sources).toContain("workspace config: enforced rules");
  });

  it("falls back to doc, then id, when an enforced item has no inline text", () => {
    write(
      ".oxagen/workspace.json",
      JSON.stringify({
        languages: {
          typescript: {
            items: [
              {
                id: "ui-import",
                kind: "convention",
                doc: "docs/ui-imports.md",
                enforced: true,
                origin: "scan",
              },
            ],
          },
        },
      }),
    );
    const result = loadContext();
    expect(result.text).toContain("see docs/ui-imports.md");
  });
});

describe("loadProjectContext — commands", () => {
  it("renders named command groups and custom commands as script references", () => {
    write(
      ".oxagen/workspace.json",
      JSON.stringify({
        commands: {
          dev: [
            {
              run: "pnpm dev",
              description: "web app on :3000",
              background: true,
            },
          ],
          test: [{ run: "pnpm test:unit" }],
          custom: { kill: [{ run: "pnpm kill" }] },
        },
      }),
    );
    const result = loadContext();
    expect(result.text).toContain("### Commands");
    expect(result.text).toContain(
      "- dev: `pnpm dev` — web app on :3000 (background)",
    );
    expect(result.text).toContain("- test: `pnpm test:unit`");
    expect(result.text).toContain("- kill: `pnpm kill`");
    expect(result.sources).toContain("workspace config: commands");
  });
});

describe("loadProjectContext — combines prose + workspace config", () => {
  it("appends workspace config sections after prose rules, sharing one budget", () => {
    write("CLAUDE.md", "# Prose rules");
    write(
      ".oxagen/workspace.json",
      JSON.stringify({ vision: { statement: "Anchor." } }),
    );
    const result = loadContext();
    const proseIdx = result.text.indexOf("### CLAUDE.md");
    const visionIdx = result.text.indexOf("### Vision");
    expect(proseIdx).toBeGreaterThanOrEqual(0);
    expect(visionIdx).toBeGreaterThan(proseIdx);
    expect(result.sources).toEqual(["CLAUDE.md", "workspace config: vision"]);
  });
});

describe("loadProjectContext — resilience", () => {
  it("never throws on a malformed workspace.json; prose rules still load", () => {
    write("CLAUDE.md", "# Prose rules survive a bad config file");
    write(".oxagen/workspace.json", "{ not valid json");
    expect(() => loadContext()).not.toThrow();
    const result = loadContext();
    expect(result.text).toContain("Prose rules survive a bad config file");
  });
});
