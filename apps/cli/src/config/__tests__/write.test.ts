import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWritableScope,
  setValueAtPath,
  setPath,
  addLanguageItem,
  removeItem,
  setVision,
  setVoice,
  setWorktreeSeed,
  writeConsolidated,
  type ConfigWriteCtx,
} from "../write.js";
import {
  getConfigScopePaths,
  clearWorkspaceConfigCache,
  resolveWorkspaceConfig,
} from "../resolve.js";
import type { WorkspaceConfig } from "../schema.js";

let cwd: string;
let homeDir: string;
let ctx: ConfigWriteCtx;

function readDoc(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-config-write-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "oxagen-config-write-home-"));
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

describe("assertWritableScope", () => {
  it("throws for org, is silent for the other three scopes", () => {
    expect(() => assertWritableScope("org")).toThrow(/managed\.json/i);
    expect(() => assertWritableScope("org")).toThrow(/read-only/i);
    for (const scope of ["user", "workspace", "repo"] as const) {
      expect(() => assertWritableScope(scope)).not.toThrow();
    }
  });
});

describe("setValueAtPath / setPath — round-trip + sibling preservation", () => {
  it("writes a scalar and reads it back via resolveWorkspaceConfig", () => {
    const path = setValueAtPath(
      "workspace",
      "packageManagers.primary",
      "pnpm",
      ctx,
    );
    expect(path).toBe(getConfigScopePaths(cwd, ctx).workspace);
    const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.packageManagers?.primary).toBe("pnpm");
  });

  it("setPath JSON-parses the raw string, falling back to a plain string", () => {
    setPath("workspace", "version", "2", ctx);
    setPath("workspace", "vcs.branch.protected", '["main","release"]', ctx);
    setPath("workspace", "vision.statement", "Ship it.", ctx);
    const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.version).toBe(2); // number, not "2"
    expect(config.vcs?.branch?.protected).toEqual(["main", "release"]);
    expect(config.vision?.statement).toBe("Ship it."); // stays a string (invalid JSON)
  });

  it("creates intermediate objects as needed", () => {
    setValueAtPath(
      "workspace",
      "database.migrations.dir",
      "packages/database/migrations",
      ctx,
    );
    const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.database?.migrations?.dir).toBe(
      "packages/database/migrations",
    );
  });

  it("never clobbers sibling keys already in the file (deep-merge-by-read)", () => {
    const path = getConfigScopePaths(cwd, ctx).workspace;
    mkdirSync(join(cwd, ".oxagen"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        orgSlug: "acme",
        workspaceSlug: "main",
        vision: { statement: "existing" },
      }),
    );
    setValueAtPath("workspace", "packageManagers.primary", "pnpm", ctx);
    const doc = readDoc(path);
    expect(doc["orgSlug"]).toBe("acme");
    expect(doc["workspaceSlug"]).toBe("main");
    expect((doc["vision"] as { statement: string }).statement).toBe("existing");
    expect((doc["packageManagers"] as { primary: string }).primary).toBe(
      "pnpm",
    );
  });

  it("throws a clear error when a path segment is not an object", () => {
    // `customField` isn't a declared schema key, so schema `.passthrough()`
    // accepts the raw string — this isolates setAtPath's own guard from zod's.
    setValueAtPath("workspace", "customField", "not-an-object", ctx);
    expect(() =>
      setValueAtPath("workspace", "customField.nested", "x", ctx),
    ).toThrow(/not an object/i);
  });

  it("refuses to write org scope (managed.json) and never touches the file", () => {
    expect(existsSync(ctx.managedConfigPath!)).toBe(false);
    expect(() =>
      setValueAtPath("org", "vision.statement", "nope", ctx),
    ).toThrow(/read-only/i);
    expect(existsSync(ctx.managedConfigPath!)).toBe(false);
  });
});

describe("scope isolation", () => {
  it("writing to workspace does not touch user, and vice versa", () => {
    setValueAtPath("workspace", "packageManagers.primary", "pnpm", ctx);
    setValueAtPath("user", "packageManagers.primary", "npm", ctx);
    const paths = getConfigScopePaths(cwd, ctx);
    expect(readDoc(paths.workspace)["packageManagers"]).toEqual({
      primary: "pnpm",
    });
    expect(readDoc(paths.user)["packageManagers"]).toEqual({ primary: "npm" });
  });

  it("writing to repo does not create or touch workspace.json", () => {
    setValueAtPath("repo", "packageManagers.primary", "pnpm", ctx);
    const paths = getConfigScopePaths(cwd, ctx);
    expect(existsSync(paths.repo)).toBe(true);
    expect(existsSync(paths.workspace)).toBe(false);
  });
});

describe("addLanguageItem / removeItem", () => {
  it("adds a new item, then upserts (replaces) by id rather than duplicating", () => {
    addLanguageItem(
      "workspace",
      "typescript",
      { id: "no-any", kind: "rule", text: "No any.", origin: "manual" },
      ctx,
    );
    let { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.languages?.typescript?.items).toHaveLength(1);

    addLanguageItem(
      "workspace",
      "typescript",
      {
        id: "no-any",
        kind: "rule",
        text: "No any. Ever.",
        origin: "manual",
        enforced: true,
      },
      ctx,
    );
    ({ config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true }));
    expect(config.languages?.typescript?.items).toHaveLength(1);
    expect(config.languages?.typescript?.items?.[0]).toMatchObject({
      text: "No any. Ever.",
      enforced: true,
    });
  });

  it("validates the item shape before writing (rejects an invalid kind)", () => {
    expect(() =>
      addLanguageItem(
        "workspace",
        "typescript",
        // @ts-expect-error — intentionally invalid `kind` for the runtime check
        { id: "x", kind: "not-a-real-kind", origin: "manual" },
        ctx,
      ),
    ).toThrow();
  });

  it("removes an item by id, searching every language in the scope", () => {
    addLanguageItem(
      "workspace",
      "typescript",
      { id: "no-any", kind: "rule", origin: "manual" },
      ctx,
    );
    addLanguageItem(
      "workspace",
      "english",
      { id: "oxford", kind: "convention", origin: "manual" },
      ctx,
    );

    const result = removeItem("workspace", "oxford", ctx);
    expect(result.removed).toBe(true);
    expect(result.languages).toEqual(["english"]);

    const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.languages?.english?.items ?? []).toHaveLength(0);
    expect(config.languages?.typescript?.items).toHaveLength(1); // untouched
  });

  it("returns removed:false and does not write when the id is not found", () => {
    addLanguageItem(
      "workspace",
      "typescript",
      { id: "no-any", kind: "rule", origin: "manual" },
      ctx,
    );
    const path = getConfigScopePaths(cwd, ctx).workspace;
    const before = readFileSync(path, "utf8");

    const result = removeItem("workspace", "does-not-exist", ctx);
    expect(result.removed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before); // untouched, no rewrite
  });

  it("only removes from the targeted scope, leaving the same id in another scope alone", () => {
    addLanguageItem(
      "workspace",
      "typescript",
      { id: "no-any", kind: "rule", origin: "manual" },
      ctx,
    );
    addLanguageItem(
      "user",
      "typescript",
      { id: "no-any", kind: "rule", origin: "manual" },
      ctx,
    );
    removeItem("workspace", "no-any", ctx);
    const paths = getConfigScopePaths(cwd, ctx);
    const workspaceDoc = readDoc(paths.workspace) as {
      languages?: { typescript?: { items?: unknown[] } };
    };
    const userDoc = readDoc(paths.user) as {
      languages?: { typescript?: { items?: unknown[] } };
    };
    expect(workspaceDoc.languages?.typescript?.items ?? []).toHaveLength(0);
    expect(userDoc.languages?.typescript?.items).toHaveLength(1);
  });
});

describe("setVision / setVoice / setWorktreeSeed — shallow merge", () => {
  it("setVision merges provided fields, keeps the rest", () => {
    setVision("workspace", { statement: "v1", goals: ["a"] }, ctx);
    setVision("workspace", { goals: ["a", "b"] }, ctx);
    const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.vision?.statement).toBe("v1"); // kept from the first call
    expect(config.vision?.goals).toEqual(["a", "b"]); // replaced (array leaf), not concatenated
  });

  it("setVoice merges into languages[lang].voice without disturbing that language's items", () => {
    addLanguageItem(
      "workspace",
      "english",
      { id: "oxford", kind: "convention", origin: "manual" },
      ctx,
    );
    setVoice(
      "workspace",
      "english",
      { tone: "confident", audience: "engineers" },
      ctx,
    );
    setVoice("workspace", "english", { audience: "senior engineers" }, ctx);
    const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.languages?.english?.voice).toEqual({
      tone: "confident",
      audience: "senior engineers",
    });
    expect(config.languages?.english?.items).toHaveLength(1);
  });

  it("setWorktreeSeed merges into worktrees.seed, keeping other worktrees fields", () => {
    setValueAtPath("workspace", "worktrees.namePattern", "oxagen-{slug}", ctx);
    setWorktreeSeed("workspace", { include: [".env"] }, ctx);
    setWorktreeSeed("workspace", { exclude: ["**/node_modules/**"] }, ctx);
    const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.worktrees?.namePattern).toBe("oxagen-{slug}");
    expect(config.worktrees?.seed?.include).toEqual([".env"]);
    expect(config.worktrees?.seed?.exclude).toEqual(["**/node_modules/**"]);
  });

  it("every shallow-merge writer refuses org scope", () => {
    expect(() => setVision("org", { statement: "x" }, ctx)).toThrow(
      /read-only/i,
    );
    expect(() => setVoice("org", "english", { tone: "x" }, ctx)).toThrow(
      /read-only/i,
    );
    expect(() => setWorktreeSeed("org", { include: ["x"] }, ctx)).toThrow(
      /read-only/i,
    );
    expect(existsSync(ctx.managedConfigPath!)).toBe(false);
  });
});

describe("dead-key guard — defense in depth (item 5)", () => {
  it("setValueAtPath rejects a runtime dead key even bypassing the command-layer redirect", () => {
    expect(() => setValueAtPath("workspace", "model", "vendor/x", ctx)).toThrow(
      /oxagen config model/i,
    );
  });

  it("never writes the dead key to disk when the schema rejects it", () => {
    expect(() =>
      setValueAtPath("workspace", "apiUrl", "https://evil.example", ctx),
    ).toThrow();
    const path = getConfigScopePaths(cwd, ctx).workspace;
    expect(existsSync(path)).toBe(false);
  });
});

describe("writeConsolidated", () => {
  it("always targets workspace scope, preserving other workspace.json sections", () => {
    setValueAtPath("workspace", "vision.statement", "keep me", ctx);
    const consolidated: NonNullable<WorkspaceConfig["consolidated"]> = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      skills: [
        { name: "coss-ui", scope: "workspace", path: ".agents/skills/coss-ui" },
      ],
    };
    const path = writeConsolidated(consolidated, ctx);
    expect(path).toBe(getConfigScopePaths(cwd, ctx).workspace);
    const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
    expect(config.vision?.statement).toBe("keep me");
    expect(config.consolidated?.skills).toHaveLength(1);
  });
});
