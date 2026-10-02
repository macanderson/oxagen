/**
 * Unit tests for lib/env-targets.ts.
 *
 * Guards the invariant that `pnpm dev` and `pnpm env:pull` agree on which
 * directories carry a `.env.local` written from Parameter Store (ADR-240), and
 * that a missing file is named up front rather than surfacing later as
 * `node: .env.local: not found` inside turbo.
 */

import { describe, expect, it } from "vitest";
import { ENV_TARGETS, missingEnvTargets } from "./lib/env-targets";

describe("ENV_TARGETS", () => {
  it("names only directories that exist in this monorepo", () => {
    // apps/website was deleted in v0.3.0 and lingered here as a dead target.
    const dirs = ENV_TARGETS.map((t) => t.dir);
    expect(dirs).toEqual([".", "apps/app", "apps/api", "apps/mcp"]);
    expect(dirs).not.toContain("apps/website");
  });

  it("has exactly one root target, the one env:pull gives operator values", () => {
    expect(ENV_TARGETS.filter((t) => t.dir === ".")).toHaveLength(1);
  });

  it("carries no Vercel project link", () => {
    for (const t of ENV_TARGETS) {
      expect(Object.keys(t).sort()).toEqual(["dir", "name"]);
    }
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
