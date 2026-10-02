// These tests read the live tree: every file a curated flow cites, the whole
// repository the atlas build scans, and the root .gitignore. vitest.config.ts
// leaves *.tree.test.ts files out of turbo's cached tasks, so
// `pnpm check:tree-guards` runs them uncached in the checks job (#4664 item 2).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, build, readOrNull } from "./gen-architecture-docs";
import { flows, verifyRefs } from "./lib/archdocs/flows";

describe("curated flows", () => {
  it("every flow cites at least one source and every ref resolves in this tree", () => {
    for (const f of flows) expect(f.refs.length, f.id).toBeGreaterThan(0);
    expect(verifyRefs(ROOT, readOrNull)).toEqual([]);
  });
});

describe("build", () => {
  it("builds the atlas from the real tree deterministically", {
    timeout: 120_000,
  }, async () => {
    const first = await build(ROOT);
    const second = await build(ROOT);
    expect(first.html).toBe(second.html);
    expect(first.json).toBe(second.json);
    expect(first.html.startsWith("<!doctype html>")).toBe(true);
    expect(first.html).toContain("<title>Oxagen Architecture Atlas</title>");
    expect(first.html).not.toMatch(/\b20\d\d-\d\d-\d\dT/); // no build timestamps
    for (const f of flows) expect(first.html).toContain(`id="${f.id}"`);
    expect(first.model.capabilities.length).toBeGreaterThan(100);
    // The inventory section renders, and every CI_REGISTRY entry it lists has
    // a reader in this tree (pnpm env:check fails the run otherwise).
    expect(first.html).toContain('<section id="secrets">');
    expect(first.model.ci.length).toBeGreaterThan(0);
    for (const c of first.model.ci) expect(c.workflows, c.name).not.toEqual([]);
    expect(
      first.model.apiRoutes.filter((r) => r.capability).length /
        first.model.apiRoutes.length,
    ).toBeGreaterThan(0.85);
  });

  it("the generated output is not tracked, so a moving main can never make it stale", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(ignore).toContain("apps/docs/public/architecture/");
    const docsPkg = JSON.parse(
      readFileSync(join(ROOT, "apps/docs/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(docsPkg.scripts.prebuild).toContain("docs:architecture");
  });
});
