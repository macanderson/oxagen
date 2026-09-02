import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appLabel,
  buildEnvRefIndex,
  deriveUsage,
  listWorkspace,
  pkgLabel,
} from "./secrets-usage";

describe("labels", () => {
  it("namespaces apps and packages so they never collide", () => {
    expect(appLabel("app")).toBe("app:app");
    expect(pkgLabel("ai")).toBe("pkg:ai");
  });
});

describe("deriveUsage", () => {
  it("merges registry services (apps) with grep refs (apps + packages) and the NEXT_PUBLIC twin", () => {
    // DATABASE_URL's registry services are api/app/mcp/admin.
    const refIndex = new Map<string, Set<string>>([
      ["DATABASE_URL", new Set(["pkg:database", "app:api"])],
      ["NEXT_PUBLIC_DATABASE_URL", new Set(["pkg:web"])],
    ]);
    const usage = deriveUsage("DATABASE_URL", refIndex);
    expect(usage).toContain("app:admin"); // from registry
    expect(usage).toContain("pkg:database"); // from grep
    expect(usage).toContain("pkg:web"); // from NEXT_PUBLIC twin
    // sorted + deduped
    expect([...usage]).toEqual([...usage].sort((a, b) => a.localeCompare(b)));
    expect(new Set(usage).size).toBe(usage.length);
  });

  it("returns empty usage when there is no env key", () => {
    expect(deriveUsage(null, new Map())).toEqual([]);
  });

  it("returns only registry services when refIndex has no matching entry", () => {
    // A key that exists in ENV_REGISTRY but has no grep hits
    const usage = deriveUsage("DATABASE_URL", new Map());
    // Only registry services, no grep refs
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.startsWith("app:"))).toBe(true);
  });

  it("handles an envKey not in the registry gracefully (only grep refs)", () => {
    const refIndex = new Map<string, Set<string>>([
      ["MY_CUSTOM_VAR", new Set(["pkg:utils"])],
    ]);
    const usage = deriveUsage("MY_CUSTOM_VAR", refIndex);
    expect(usage).toContain("pkg:utils");
  });
});

describe("listWorkspace + buildEnvRefIndex", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "env-mgr-"));
    mkdirSync(join(root, "apps", "web-app", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(
      join(root, "apps", "web-app", "src", "a.ts"),
      "const u = process.env.MY_SECRET;\n",
    );
    writeFileSync(
      join(root, "packages", "core", "src", "b.ts"),
      'const v = process.env["MY_SECRET"];\nconst w = env.OTHER_KEY;\n',
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("enumerates apps and packages alpha-sorted", () => {
    const ws = listWorkspace(root);
    expect(ws.apps).toEqual(["web-app"]);
    expect(ws.packages).toEqual(["core"]);
  });

  it("attributes env-var references to the owning app/package", () => {
    const index = buildEnvRefIndex(root);
    expect(index.get("MY_SECRET")).toEqual(
      new Set(["app:web-app", "pkg:core"]),
    );
    expect(index.get("OTHER_KEY")).toEqual(new Set(["pkg:core"]));
  });

  it("returns an empty workspace for a directory with no apps/packages", () => {
    const empty = mkdtempSync(join(tmpdir(), "env-mgr-empty-"));
    expect(listWorkspace(empty)).toEqual({ apps: [], packages: [] });
    rmSync(empty, { recursive: true, force: true });
  });
});
