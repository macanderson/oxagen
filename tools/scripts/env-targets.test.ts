/**
 * Unit tests for lib/env-targets.ts.
 *
 * Guards the invariant that `pnpm dev` and `pnpm env:pull` agree on which
 * directories carry a Vercel-hydrated `.env.local`, and that a missing file
 * is reported with the exact `vercel link` command that fixes it rather than
 * surfacing later as `node: .env.local: not found` inside turbo.
 */

import { describe, expect, it } from "vitest";
import {
  ENV_TARGETS,
  linkHint,
  missingEnvTargets,
  VERCEL_SCOPE,
} from "./lib/env-targets";

describe("ENV_TARGETS", () => {
  it("names only directories that exist in this monorepo", () => {
    // apps/website was deleted in v0.3.0 and lingered here as a dead target.
    const dirs = ENV_TARGETS.map((t) => t.dir);
    expect(dirs).toEqual([".", "apps/app", "apps/api", "apps/mcp"]);
    expect(dirs).not.toContain("apps/website");
  });

  it("maps every target to a Vercel project in the oxagen scope", () => {
    for (const t of ENV_TARGETS) {
      expect(t.project).toMatch(/^oxagen-v2-(app|api|mcp)$/);
    }
    expect(VERCEL_SCOPE).toBe("oxagen");
  });
});

describe("missingEnvTargets", () => {
  it("returns nothing when every .env.local exists", () => {
    expect(missingEnvTargets("/repo", () => true)).toEqual([]);
  });

  it("returns exactly the targets whose file is absent", () => {
    const present = new Set(["/repo/.env.local", "/repo/apps/app/.env.local"]);
    const missing = missingEnvTargets("/repo", (p) => present.has(p));
    expect(missing.map((t) => t.dir)).toEqual(["apps/api", "apps/mcp"]);
  });

  it("resolves the root target to <root>/.env.local, not <root>/./.env.local", () => {
    const seen: string[] = [];
    missingEnvTargets("/repo", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0]).toBe("/repo/.env.local");
  });
});

describe("linkHint", () => {
  it("emits one subshell vercel link line per target", () => {
    const hint = linkHint(
      missingEnvTargets("/repo", (p) => p === "/repo/.env.local"),
    );
    expect(hint.split("\n")).toEqual([
      "  (cd apps/app && vercel link --yes --project oxagen-v2-app --scope oxagen)",
      "  (cd apps/api && vercel link --yes --project oxagen-v2-api --scope oxagen)",
      "  (cd apps/mcp && vercel link --yes --project oxagen-v2-mcp --scope oxagen)",
    ]);
  });

  it("is empty for no targets", () => {
    expect(linkHint([])).toBe("");
  });
});
