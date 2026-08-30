/**
 * audit-emit-consolidation.test.ts — repo-wide invariant for the SOC2 audit
 * emit path (OXA-N1 / Rec 1 of docs/architecture/security/soc2-simplification.html).
 *
 * Before consolidation, every audit call site hand-rolled the same lazy-singleton
 * boilerplate:
 *
 *   let _auditInsert = null;
 *   function auditInsert() { return (_auditInsert ??= makeSecurityEventInserter()); }
 *   recordSecurityEvent(auditInsert(), { ...event });
 *
 * That pattern was copy-pasted across ~8 files and nothing stopped it drifting.
 * It is now replaced by the single registry helper emitSecurityEvent() exported
 * from @oxagen/database/security. These tests fail closed if:
 *
 *   1. The deprecated `recordSecurityEvent(auditInsert())` boilerplate reappears
 *      anywhere under packages/ or apps/ source (a regression of the dedup), or
 *   2. A known privileged-mutation call site stops routing through the registry.
 *
 * The kernel-emitter wiring in the API/MCP bootstraps is INTENTIONALLY exempt:
 * it constructs makeSecurityEventInserter() once and registers it with the
 * capability kernel, which is a different (per-invocation) path than discrete
 * mutation emits. We assert those bootstraps still wire the inserter.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Recursively collect *.ts / *.tsx source files under a root, skipping noise. */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const SKIP = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // dir may not exist in every checkout
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

const sourceFiles = [
  ...collectSourceFiles(join(repoRoot, "packages")),
  ...collectSourceFiles(join(repoRoot, "apps")),
];

// The deprecated boilerplate: recordSecurityEvent called with the per-file
// auditInsert() singleton. We match the call shape, tolerant of whitespace.
const DEPRECATED_EMIT = /recordSecurityEvent\(\s*auditInsert\(\)/;
const LEGACY_SINGLETON = /function auditInsert\b/;

// The registry helper's own file documents the deprecated pattern in a comment
// (explaining what emitSecurityEvent replaced). Exempt it from the scan.
const EXEMPT = new Set([
  join(repoRoot, "packages", "database", "src", "security.ts"),
]);
const scanFiles = sourceFiles.filter((f) => !EXEMPT.has(f));

describe("audit emit consolidation (OXA-N1)", () => {
  it("collected a non-trivial set of source files to scan", () => {
    // Guard against a path bug silently scanning nothing.
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it("no source file reintroduces the recordSecurityEvent(auditInsert()) boilerplate", () => {
    const offenders = scanFiles.filter((f) =>
      DEPRECATED_EMIT.test(readFileSync(f, "utf8")),
    );
    expect(
      offenders,
      `These files use the deprecated per-file emit boilerplate; route them ` +
        `through emitSecurityEvent() from @oxagen/database/security instead:\n` +
        offenders.map((f) => `  - ${f.replace(repoRoot + "/", "")}`).join("\n"),
    ).toEqual([]);
  });

  it("no source file redefines a local auditInsert() singleton", () => {
    const offenders = scanFiles.filter((f) =>
      LEGACY_SINGLETON.test(readFileSync(f, "utf8")),
    );
    expect(
      offenders,
      `Local auditInsert() singletons should be replaced by the shared ` +
        `emitSecurityEvent() registry helper:\n` +
        offenders.map((f) => `  - ${f.replace(repoRoot + "/", "")}`).join("\n"),
    ).toEqual([]);
  });

  it("the known privileged-mutation handlers route through emitSecurityEvent()", () => {
    const callSites = [
      "packages/handlers/src/org.member.add.ts",
      "packages/handlers/src/org.member.remove.ts",
      // ADR-022 subject rename: member.role → member_role, member.invite → member_invite.
      "packages/handlers/src/org.member_role.change.ts",
      "packages/handlers/src/org.member_invite.accept.ts",
      "packages/billing/src/subscriptions.ts",
    ];
    for (const rel of callSites) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src, `${rel} should emit via emitSecurityEvent()`).toMatch(
        /emitSecurityEvent\(/,
      );
    }
  });

  it("the API and MCP bootstraps still wire the kernel security emitter", () => {
    for (const rel of [
      "apps/api/src/bootstrap.ts",
      "apps/mcp/src/middleware.ts",
    ]) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src, `${rel} should wire the kernel emitter`).toMatch(
        /setSecurityEventEmitter\(/,
      );
      expect(src).toMatch(/makeSecurityEventInserter\(/);
    }
  });
});
