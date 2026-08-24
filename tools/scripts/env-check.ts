#!/usr/bin/env tsx
/**
 * env-check.ts — static environment-variable health checker.
 *
 * Scans apps/ and packages/ for env-var references (no network, no secrets)
 * and reconciles them against the canonical ENV_REGISTRY, then verifies
 * .env.example is up-to-date with `renderEnvExample()`.
 *
 * Modes:
 *   (default)   reconcile + example-check; exit 1 on any FAIL
 *   --write     regenerate .env.example from the registry and exit 0
 *   --json      emit the report as JSON to stdout (exit code unchanged)
 *
 * Run via `pnpm env:check` (or `tsx tools/scripts/env-check.ts`).
 * Wired into `pnpm gate` so it runs on every PR.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import { ENV_REGISTRY, registryKeys, renderEnvExample } from "@oxagen/config";
import { baseEnvSchema } from "@oxagen/config/env";

// ── Platform / test-injected vars ────────────────────────────────────────────
// These are set by Vercel, Next.js, Turborepo, or the CI harness — never by
// operators. References to them are intentional and require no registry entry.
export const PLATFORM_ALLOWLIST = new Set<string>([
  // Vercel runtime: injected at deploy time, not configurable by the project
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL",
  // Next.js runtime flags: set by the framework, not the operator
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  // Standard CI signal
  "CI",
  // Process-placement knobs for the self-hosted API (apps/api/src/index.ts):
  // supplied by whatever runs the process — Caddy/systemd on the shared
  // instance — never configured through env-manager. HOSTNAME doubles as the
  // POSIX machine name the OS sets, which is why it can never be a registry
  // entry with a schema.
  "PORT",
  "HOST",
  "HOSTNAME",
  // no-color.org standard — set by the terminal/shell, not by operators
  "NO_COLOR",
  // Oxagen internal platform version tag
  "PLATFORM_VERSION",
  // Turborepo remote-cache credentials (set via GitHub Actions Secrets, not app env)
  "TURBO_TOKEN",
  "TURBO_TEAM",
  // Test / E2E harness only — never present in deployed environments
  "E2E_TEST",
  "PLAYWRIGHT_BASE_URL",
  // Set automatically by the Vitest runner; used to keep CLI turn assembly
  // (workspace MCP fetch) hermetic in unit tests. Never a deployed var.
  "VITEST",
  // Legacy E2E aliases for canonical schema names (e2e fixtures only)
  "NEO4J_URL", // alias for NEO4J_URI
  "NEO4J_USER", // alias for NEO4J_USERNAME
]);

// ── Schema-exempt keys ────────────────────────────────────────────────────────
// These are intentionally in ENV_REGISTRY (documented + deployed by env-manager)
// but deliberately NOT promoted to baseEnvSchema. They are CLI-only, dev-tooling,
// or operator-local vars that never run through loadEnv() validation. Listing
// them here silences the "promote to schema" warning without polluting the
// runtime Zod schema with vars that deployed services never validate.
export const SCHEMA_EXEMPT = new Set<string>([
  // CLI-only — read via process.env in apps/cli; services: []
  "OXAGEN_NO_TUI",
  "OXAGEN_API_TOKEN",
  "OXAGEN_ORG_ID",
  "OXAGEN_WORKSPACE_ID",
  "OXAGEN_API_URL",
  "OXAGEN_APP_URL",
  "OXAGEN_MODEL",
  "OXAGEN_EFFORT",
  "OXAGEN_COORDINATOR",
  "OXAGEN_ONDEVICE_MODEL",
  "OXAGEN_MODELS_CACHE_DIR",
  "OXAGEN_LLM_EVALUATOR",
  "OXAGEN_LLM_ADVISOR",
  "OXAGEN_LLM_SELECTOR",
  "OXAGEN_DEBUG",
  "OXAGEN_MID_JUDGE_STEPS",
  "OXAGEN_MAX_REVISE_ROUNDS",
  "OXAGEN_JUDGE_FAST_COMPLEXITY_MAX",
  "OXAGEN_CLI_MOUSE",
  // CLI / agent-engine local pipeline knobs — read via process.env in the CLI
  // turn pipeline and local tooling; never validated by deployed services
  "OXAGEN_ALLOW_NO_SESSION",
  "OXAGEN_ALLOW_STDIO_MCP",
  "OXAGEN_BEST_OF_N_MODE",
  "OXAGEN_BEST_OF_N_PIPELINE",
  "OXAGEN_BEST_OF_N_VERIFY",
  "OXAGEN_CLI_FUN",
  "OXAGEN_CLI_MOTION",
  "OXAGEN_FLEET_DIR",
  "OXAGEN_FLEET_RECORD",
  "OXAGEN_COMMIT_LEDGER",
  "OXAGEN_DISABLE_MEMORY",
  "OXAGEN_EMBED_MODEL",
  "OXAGEN_EMBED_PROVIDER",
  "OXAGEN_ENHANCE_TIMEOUT_MS",
  "OXAGEN_GRAPH_DISABLED",
  "OXAGEN_JUDGE_PANEL",
  "OXAGEN_LOCAL",
  "OXAGEN_LOCALIZE",
  "OXAGEN_MUTATION_SCORE",
  "OXAGEN_MUTATION_TIMEOUT_MS",
  "OXAGEN_MUTATION_VERIFY",
  "OXAGEN_PLAN_TIMEOUT_MS",
  "OXAGEN_PROMPT_PROFILE",
  "OXAGEN_RECALL_FILTER",
  "OXAGEN_REPO_PRIORS",
  "OXAGEN_REVISE_MIN_CONFIDENCE",
  "OXAGEN_TELEMETRY",
  // Local-embeddings provider endpoint (CLI code-graph embeddings)
  "OLLAMA_HOST",
  // Console Do Not Track standard — CLI telemetry opt-out, never a service var
  "DO_NOT_TRACK",
  // CLI-only BYOK fallback key (see ENV_REGISTRY) — never validated by services
  "ANTHROPIC_API_KEY",
  // Dev-tooling signal — set by tools/scripts/dev.ts; services: []
  "OXAGEN_LOCAL_DEV",
]);

// ── File walker ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set<string>([
  "node_modules",
  ".next",
  "dist",
  ".xmcp",
  "coverage",
  "e2e",
  "__tests__",
  ".turbo",
  "out",
  "build",
  ".vercel",
]);

function walkSourceFiles(dir: string, results: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      walkSourceFiles(full, results);
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      results.push(full);
    }
  }
  return results;
}

// ── Scanner ───────────────────────────────────────────────────────────────────

const RE_KEY = /^[A-Z][A-Z0-9_]+$/;

export interface ScanResult {
  /** varName → list of "file:line" locations */
  referenced: Map<string, string[]>;
  /** True if any scanned file calls loadEnv() — implies all required schema keys are consumed. */
  loadEnvFound: boolean;
}

/**
 * Walk the given directory roots and extract every statically-resolvable
 * env-var reference. Returns a ScanResult for the reconciler.
 * Pure I/O: no classification logic here.
 */
export function scanSourceReferences(roots: string[]): ScanResult {
  const referenced = new Map<string, string[]>();
  let loadEnvFound = false;
  const cwd = process.cwd();

  function record(key: string, location: string): void {
    if (!referenced.has(key)) referenced.set(key, []);
    referenced.get(key)!.push(location);
  }

  for (const root of roots) {
    for (const file of walkSourceFiles(root)) {
      const rel = relative(cwd, file);
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }

      if (/\bloadEnv\s*\(/.test(content)) loadEnvFound = true;

      // Line-by-line for dot-access and bracket-access (gives accurate line numbers)
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const loc = `${rel}:${i + 1}`;

        // process.env.KEY
        for (const m of line.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)\b/g)) {
          if (RE_KEY.test(m[1]!)) record(m[1]!, loc);
        }
        // process.env["KEY"] or process.env['KEY']
        for (const m of line.matchAll(
          /\bprocess\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
        )) {
          if (RE_KEY.test(m[1]!)) record(m[1]!, loc);
        }
      }

      // requireEnv([...]) — may span lines; match on full file content
      for (const m of content.matchAll(/\brequireEnv\s*\(\s*\[([^\]]+)\]/g)) {
        const arrayStr = m[1]!;
        const matchLine = content.slice(0, m.index).split("\n").length;
        const loc = `${rel}:${matchLine}`;
        for (const km of arrayStr.matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)) {
          if (RE_KEY.test(km[1]!)) record(km[1]!, loc);
        }
      }
    }
  }

  return { referenced, loadEnvFound };
}

// ── Reconciler ────────────────────────────────────────────────────────────────

export interface Finding {
  key: string;
  locations?: string[];
  reason: string;
}

export interface EnvCheckReport {
  /** Referenced in code and validated by baseEnvSchema — all good. */
  ok: Finding[];
  /** Referenced in code, documented in registry, but NOT in baseEnvSchema. */
  warnUnvalidated: Finding[];
  /** In registry with services listed, but never referenced in source. */
  warnDead: Finding[];
  /** Referenced in code but completely absent from ENV_REGISTRY (and not allowlisted). */
  fail: Finding[];
}

export interface ReconcileInput {
  referenced: Map<string, string[]>;
  registryKeySet: Set<string>;
  schemaKeySet: Set<string>;
  /** key → service list (for dead-detection; pass from ENV_REGISTRY). */
  registryServiceMap: Map<string, string[]>;
  loadEnvFound: boolean;
}

/**
 * Pure reconciler — no filesystem I/O. Classifies every referenced key and
 * detects dead declarations in the registry. Testable with fixtures.
 */
export function reconcile({
  referenced,
  registryKeySet,
  schemaKeySet,
  registryServiceMap,
  loadEnvFound,
}: ReconcileInput): EnvCheckReport {
  const report: EnvCheckReport = {
    ok: [],
    warnUnvalidated: [],
    warnDead: [],
    fail: [],
  };

  // If loadEnv() is found, it validates all schema keys at boot — mark all of
  // them as implicitly consumed (prevents false "dead" warnings for required vars
  // that are only consumed through the full-schema boot check).
  const implicitlyConsumed = new Set<string>();
  if (loadEnvFound) {
    for (const k of schemaKeySet) implicitlyConsumed.add(k);
  }

  // Classify each key referenced in source code
  for (const [key, locations] of referenced) {
    if (PLATFORM_ALLOWLIST.has(key)) continue;
    if (schemaKeySet.has(key)) {
      report.ok.push({ key, locations, reason: "schema-validated" });
    } else if (SCHEMA_EXEMPT.has(key)) {
      report.ok.push({
        key,
        locations,
        reason: "schema-exempt (intentionally unvalidated)",
      });
    } else if (registryKeySet.has(key)) {
      report.warnUnvalidated.push({
        key,
        locations,
        reason:
          "in ENV_REGISTRY but not in baseEnvSchema — promote to schema (tracked)",
      });
    } else {
      report.fail.push({
        key,
        locations,
        reason:
          "referenced in source but absent from ENV_REGISTRY — add it or allowlist it",
      });
    }
  }

  // Detect dead declarations: registry entries that have services but no source reference
  for (const [key, services] of registryServiceMap) {
    if (services.length === 0) continue; // tooling-only vars; expected to be unreferenced
    if (referenced.has(key)) continue;
    if (implicitlyConsumed.has(key)) continue;
    report.warnDead.push({
      key,
      reason: `services [${services.join(", ")}] listed but no source reference found`,
    });
  }

  return report;
}

// ── Reporter ──────────────────────────────────────────────────────────────────

function printReport(report: EnvCheckReport, exampleDrift: boolean): void {
  const failCount = report.fail.length + (exampleDrift ? 1 : 0);
  const warnCount = report.warnUnvalidated.length + report.warnDead.length;

  // One-line summary for CI log scanners
  console.log(
    `env-check: ${report.ok.length} ok · ${warnCount} warn · ${failCount} fail`,
  );

  if (report.fail.length > 0) {
    console.log(kleur.red().bold("\n✗ FAIL — undeclared references"));
    for (const f of report.fail) {
      console.log(kleur.red(`  ${f.key}`) + ` — ${f.reason}`);
      for (const loc of f.locations ?? []) console.log(kleur.dim(`    ${loc}`));
    }
  }

  if (report.warnUnvalidated.length > 0) {
    console.log(
      kleur.yellow("\n⚠ WARN — in registry, not yet in baseEnvSchema"),
    );
    for (const f of report.warnUnvalidated) {
      console.log(kleur.yellow(`  ${f.key}`) + ` — ${f.reason}`);
      for (const loc of (f.locations ?? []).slice(0, 3))
        console.log(kleur.dim(`    ${loc}`));
    }
  }

  if (report.warnDead.length > 0) {
    console.log(
      kleur.yellow(
        "\n⚠ WARN — possibly dead (in registry, no source reference)",
      ),
    );
    for (const f of report.warnDead) {
      console.log(kleur.yellow(`  ${f.key}`) + ` — ${f.reason}`);
    }
  }

  if (exampleDrift) {
    console.log(
      kleur.red("\n✗ FAIL — .env.example is out of date") +
        "\n  Run `pnpm env:check --write` to regenerate.",
    );
  }

  if (failCount === 0) {
    console.log(kleur.green("\n✓ env-check passed"));
  }
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

const MONOREPO_ROOT = resolve(import.meta.dirname, "../..");
const ENV_EXAMPLE_PATH = join(MONOREPO_ROOT, ".env.example");

function main(): void {
  const args = argv.slice(2);
  const writeMode = args.includes("--write");
  const jsonMode = args.includes("--json");

  if (writeMode) {
    writeFileSync(ENV_EXAMPLE_PATH, renderEnvExample(), "utf8");
    console.log(kleur.green(".env.example regenerated from ENV_REGISTRY."));
    exit(0);
  }

  const roots = [join(MONOREPO_ROOT, "apps"), join(MONOREPO_ROOT, "packages")];
  const { referenced, loadEnvFound } = scanSourceReferences(roots);

  const registryKeySet = new Set(registryKeys());
  const schemaKeySet = new Set(Object.keys(baseEnvSchema.shape));
  const registryServiceMap = new Map(
    Object.entries(ENV_REGISTRY).map(([k, m]) => [k, [...m.services]]),
  );

  const report = reconcile({
    referenced,
    registryKeySet,
    schemaKeySet,
    registryServiceMap,
    loadEnvFound,
  });

  // Check .env.example drift
  let exampleDrift = false;
  try {
    const committed = readFileSync(ENV_EXAMPLE_PATH, "utf8");
    exampleDrift = committed !== renderEnvExample();
  } catch {
    exampleDrift = true;
  }

  if (jsonMode) {
    console.log(JSON.stringify({ ...report, exampleDrift }, null, 2));
    exit(report.fail.length + (exampleDrift ? 1 : 0) > 0 ? 1 : 0);
  }

  printReport(report, exampleDrift);
  exit(report.fail.length + (exampleDrift ? 1 : 0) > 0 ? 1 : 0);
}

// Only run when this file is the entrypoint (tsx env-check.ts), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
