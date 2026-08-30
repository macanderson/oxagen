import { describe, it, expect } from "vitest";
import {
  mergeWorkspaceConfigs,
  type ResolvedWorkspaceConfig,
  type WorkspaceConfigScopeFile,
} from "../resolve.js";
import type { WorkspaceConfig, ConfigScope } from "../schema.js";
import {
  buildConfigRows,
  formatRowValue,
  getValueAtPath,
  SUGGESTED_PATHS,
} from "../panel-model.js";

function resolved(
  files: Partial<Record<ConfigScope, WorkspaceConfig>>,
): ResolvedWorkspaceConfig {
  const scopeFiles: WorkspaceConfigScopeFile[] = (
    ["org", "user", "workspace", "repo"] as const
  ).map((scope) => ({ scope, path: `/${scope}.json`, config: files[scope] }));
  return { ...mergeWorkspaceConfigs(scopeFiles), scopes: scopeFiles };
}

describe("getValueAtPath / formatRowValue", () => {
  it("reads nested dotted paths and formats values compactly", () => {
    const config = { vcs: { commit: { convention: "cc" } } } as WorkspaceConfig;
    expect(getValueAtPath(config, "vcs.commit.convention")).toBe("cc");
    expect(getValueAtPath(config, "vcs.missing.leaf")).toBeUndefined();
    expect(formatRowValue("plain")).toBe("plain");
    expect(formatRowValue(["a"])).toBe('["a"]');
    expect(formatRowValue(undefined)).toBe("(not set)");
  });
});

describe("buildConfigRows", () => {
  it("emits a leaf row per resolved path with scope + lock provenance", () => {
    const rows = buildConfigRows(
      resolved({
        org: { packageManagers: { primary: "pnpm" } },
        repo: { vcs: { commit: { convention: "cc" } } },
      }),
    );
    const pm = rows.find((r) => r.path === "packageManagers.primary");
    expect(pm?.scope).toBe("org");
    expect(pm?.locked).toBe(true);
    expect(pm?.display).toBe("pnpm");
    const vcs = rows.find((r) => r.path === "vcs.commit.convention");
    expect(vcs?.scope).toBe("repo");
    expect(vcs?.locked).toBe(false);
  });

  it("special-cases language items with a lookup key instead of a dotted value path", () => {
    const rows = buildConfigRows(
      resolved({
        workspace: {
          languages: {
            typescript: {
              items: [
                {
                  id: "no-any",
                  kind: "rule",
                  text: "no any",
                  origin: "manual",
                },
              ],
            },
          },
        },
      }),
    );
    const item = rows.find(
      (r) => r.path === "languages.typescript.items.no-any",
    );
    expect(item?.kind).toBe("item");
    expect(item?.item).toEqual({ lang: "typescript", id: "no-any" });
    expect(item?.display).toContain("no any");
  });

  it("hides generated/meta paths (consolidated, version, locked)", () => {
    const rows = buildConfigRows(
      resolved({
        workspace: {
          version: 1,
          locked: ["vision"],
          vision: { statement: "ship" },
          consolidated: {
            skills: [{ name: "s", scope: "workspace", path: "p" }],
          },
        },
      }),
    );
    expect(rows.some((r) => r.path.startsWith("consolidated"))).toBe(false);
    expect(rows.some((r) => r.path === "version" || r.path === "locked")).toBe(
      false,
    );
    expect(rows.some((r) => r.path === "vision.statement")).toBe(true);
  });

  it("appends unset suggested paths as editable placeholders", () => {
    const rows = buildConfigRows(resolved({}));
    expect(rows.length).toBe(SUGGESTED_PATHS.length);
    expect(rows.every((r) => r.scope === null && r.value === undefined)).toBe(
      true,
    );
    expect(rows[0]!.display).toContain("not set");
  });

  it("does not suggest a path that is already set", () => {
    const rows = buildConfigRows(
      resolved({ user: { vision: { statement: "ship" } } }),
    );
    const visionRows = rows.filter((r) => r.path === "vision.statement");
    expect(visionRows).toHaveLength(1);
    expect(visionRows[0]!.scope).toBe("user");
  });
});
