#!/usr/bin/env tsx
/**
 * env-check.ts — static environment-variable health checker.
 *
 * Scans apps/, packages/, tools/ and infra/ for env-var references (no network,
 * no secrets) and reconciles them against the canonical ENV_REGISTRY, then
 * verifies .env.example is up-to-date with `renderEnvExample()`.
 *
 * A registry key nothing reads fails the check, and that is new (#2823). Two
 * blind spots had made the dead half unreachable:
 *
 *   - Any file calling `loadEnv()` used to mark every schema key implicitly
 *     consumed. `apps/api/src/bootstrap.ts` calls it to validate the whole
 *     schema at boot and reads nothing off the result, so the entire registry
 *     read as consumed and no key could ever be reported dead.
 *   - The walker read `.tsx?` under apps/ and packages/ only, so operator
 *     scripts, `next.config.mjs` and shell were invisible in both directions:
 *     a var they read went unregistered, and a var only they read read as dead.
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
  // Vercel build-time: the project's production domain, read by
  // apps/app/next.config.mjs to build the server-actions origin list
  "VERCEL_PROJECT_PRODUCTION_URL",
  // The shell and the OS set these. A `.sh` file cannot tell an environment
  // read from a local (both are `$NAME`), so the scanner only records a name
  // the script never assigns — which leaves the inherited ones, and these are
  // the inherited ones that belong to the machine rather than to this project.
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "SHELL",
  "BASH_SOURCE",
  // awk's own field-count and record-number builtins, which appear inside a
  // shell script as `$NF` and `$NR` — three characters indistinguishable from
  // an environment read once they are outside awk's quotes. Neither is a name
  // anything would ever give a variable, so allowlisting them costs no cover.
  "NF",
  "NR",
  // libpq's own variables: psql and atlas read them directly, so a value here
  // configures those tools rather than any Oxagen service.
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  // GitHub Actions and the gh CLI inject these into a workflow step. GH_TOKEN
  // is gh's spelling of the same credential GITHUB_TOKEN carries.
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_SERVER_URL",
  "GITHUB_EVENT_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  // AWS SDK / CLI convention, read by boto3 and the aws CLI themselves
  "AWS_REGION",
  // Set by nightly.yml on the step that files the failure ticket, so the marker
  // names the job that actually failed rather than always saying "e2e"
  // (tools/scripts/ensure-e2e-failure-ticket.ts). A workflow input, never an
  // operator's.
  "NIGHTLY_FAILED_JOB",
  // @oxagen/tacho's own placement knobs, all three local to a machine running
  // the collector rather than to any deployed service. TACHO_BUNDLED is set by
  // esbuild's `define` at bundle time and never read from a real environment;
  // TACHO_BIN_DIR and TACHO_HOME relocate the binary and the state directory,
  // and both default to a path under the user's home. tacho is a leaf package
  // with no @oxagen/* runtime dependency, so it deliberately does not read the
  // config registry these would otherwise live in.
  "TACHO_BUNDLED",
  "TACHO_BIN_DIR",
  "TACHO_HOME",
  // Claude Code sets these in the session and hook processes it spawns; the
  // tacho collector and the session-summary script read what it left. They are
  // that tool's contract, not anything an operator configures here.
  "CLAUDE_PID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_SESSION",
  // Read and written by `tacho enroll` (packages/tacho/src/cli/enroll.ts,
  // host/paths.ts, host/settings-writer.ts). Both belong to Claude Code's own
  // configuration surface — where it keeps its settings, and whether it emits
  // telemetry — so a value here configures that tool, not an Oxagen service.
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_EFFORT",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_SESSION_ID",
  "CLAUDE_SESSION_SUMMARY",
  "CLAUDE_CODE_MODEL",
  "ANTHROPIC_MODEL",
  // Terminal emulators set this; tacho reads it to name the host program
  "TERM_PROGRAM",
]);

// ── Schema-exempt keys ────────────────────────────────────────────────────────
// These are intentionally in ENV_REGISTRY (documented + deployed by env-manager)
// but deliberately NOT promoted to baseEnvSchema. They are CLI-only, dev-tooling,
// or operator-local vars that never run through loadEnv() validation. Listing
// them here silences the "promote to schema" warning without polluting the
// runtime Zod schema with vars that deployed services never validate.
export const SCHEMA_EXEMPT = new Set<string>([
  // CLI-only — read via process.env in apps/cli; services: []
  "OXAGEN_API_TOKEN",
  "OXAGEN_ORG_ID",
  "OXAGEN_WORKSPACE_ID",
  "OXAGEN_API_URL",
  "OXAGEN_APP_URL",
  "OXAGEN_DEBUG",
  // CLI local pipeline knobs — read via process.env in the CLI turn pipeline
  // and local tooling; never validated by deployed services
  "OXAGEN_ALLOW_STDIO_MCP",
  "OXAGEN_TELEMETRY",
  // Console Do Not Track standard — CLI telemetry opt-out, never a service var
  "DO_NOT_TRACK",
  // CLI-only BYOK fallback key (see ENV_REGISTRY) — never validated by services
  "ANTHROPIC_API_KEY",
  // Dev-tooling signal — set by tools/scripts/dev.ts; services: []
  "OXAGEN_LOCAL_DEV",
  // Operator scripts and build flags (#2823). Registered so `.env.example` and
  // the env-manager document them, but read straight off process.env by a
  // script or a Next config — never through loadEnv(), so a schema entry would
  // validate them for services that never see them.
  "STANDALONE",
  "WRITE_MANIFEST_IMAGE",
  "NPM_TOKEN",
  "OXAGEN_INSTALL_BASE",
  "OXAGEN_INSTALL_DIR",
  "ADMIN_DATABASE_URL",
  "PRODUCTION_DATABASE_URL",
  "DB_MIGRATE_STORES",
  "PGSUPERUSER",
  "PGSUPERPASS",
  "PRODUCTION_ANALYTICS_URL",
  "PRODUCTION_ANALYTICS_USER",
  "PRODUCTION_ANALYTICS_PASSWORD",
  "USER_EMAIL",
  "INNGEST_DEV",
  "GCP_PROJECT",
  "CONTEXT_GRAPH_PROTOCOL_DIR",
  "MAIN_VERIFIED_WINDOW",
  "SCR_OWNER",
  "OXAGEN_HOUSE_BRAND",
  "VISION_GATE_MODEL",
  "VISION_GATE_BASE",
  "VISION_GATE_STRICT",
  "NODE_NAME",
  "DATA_NODE_NAME",
  "AURORA_ENDPOINT",
  "AURORA_PORT",
  "EVENT_BUS_NAME",
]);

// ── File walker ───────────────────────────────────────────────────────────────

/**
 * Every directory that can hold code reading an env var. tools/ and infra/ are
 * new (#2823): the operator and deploy scripts read a long tail of vars the
 * registry had never heard of, and are the only reader of several it lists.
 */
export const SOURCE_ROOTS = ["apps", "packages", "tools", "infra"] as const;

const SKIP_DIRS = new Set<string>([
  "node_modules",
  ".venv",
  "__pycache__",
  ".terraform",
  "cdk.out",
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

/**
 * Every file kind that can read an env var here. `.mjs` is Next's config
 * format, `.sh` is the deploy and packaging scripts, `.py` the analysis ones —
 * all three used to be unreadable to this check in both directions.
 */
const SOURCE_FILE = /\.(?:tsx?|mjs|cjs|jsx?|sh|py)$/;
const TEST_FILE = /\.(?:test|spec)\.[a-z]+$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

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
    } else if (
      SOURCE_FILE.test(name) &&
      !TEST_FILE.test(name) &&
      !DECLARATION_FILE.test(name)
    ) {
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
}

/**
 * An env-bearing object, read by property or by subscript. `process.env.KEY` is
 * the common case; the rest matter because a validated env object is the thing
 * most code actually reads. `loadEnv().BETTER_AUTH_URL` in packages/auth and
 * `env["SLACK_DATA_CLIENT_ID"]` in the OAuth refresh strategies are both live
 * reads of a key that used to look dead to this scanner.
 *
 * Anchored on an identifier ending in `env`/`Env` rather than on any object, so
 * an unrelated `Foo.SOME_CONSTANT` is not mistaken for a var read — a false
 * "consumed" is what makes a dead key invisible.
 */
const RE_ENV_MEMBER =
  /(?:^|[^\w$])[\w$]*[Ee]nv(?:\([^()]*\))?\.([A-Z][A-Z0-9_]+)\b/g;
const RE_ENV_SUBSCRIPT =
  /(?:^|[^\w$])[\w$]*[Ee]nv(?:\([^()]*\))?\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g;

/** os.environ["KEY"], os.environ.get("KEY"), os.getenv("KEY"). */
const RE_PYTHON_ENV =
  /os\.(?:environ(?:\.get)?\(?\[?|getenv\()\s*['"]([A-Z][A-Z0-9_]+)['"]/g;

/** $NAME and ${NAME}, ${NAME:-default}, ${NAME%suffix} — every expansion form. */
const RE_SHELL_EXPANSION = /\$\{?([A-Z][A-Z0-9_]+)\b/g;

/**
 * Names the script gives itself: `NAME=`, `export NAME=`, `local NAME=`,
 * `declare -r NAME=`, `for NAME in`.
 *
 * `$NAME` is the same expression whether NAME came from the environment or from
 * two lines up, so whether the file assigns it is the only thing that separates
 * them. Without this, `MIGRATE_URL` and `SIM_DB` and every other script-local
 * constant would be reported as an env var missing from the registry.
 */
const RE_SHELL_ASSIGNMENT =
  /^\s*(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)*)?([A-Z][A-Z0-9_]+)=|^\s*for\s+([A-Z][A-Z0-9_]+)\s+in\b/gm;

/** `read -r -d '' NAME <<EOF` — the option arguments make a positional match unreliable. */
const RE_SHELL_READ = /^\s*read\b.*$/gm;

function shellAssignedNames(content: string): Set<string> {
  const assigned = new Set<string>();
  for (const m of content.matchAll(RE_SHELL_ASSIGNMENT)) {
    const name = m[1] ?? m[2];
    if (name) assigned.add(name);
  }
  for (const line of content.match(RE_SHELL_READ) ?? []) {
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g))
      assigned.add(m[1]!);
  }
  return assigned;
}

/**
 * A line that is nothing but a comment.
 *
 * A doc comment naming `process.env.FOO` as an example is not a reference, and
 * counting it as one cuts both ways: an undeclared name in prose fails the
 * check, and a registry key mentioned only in a comment reads as alive. Only
 * whole-line comments are dropped — a trailing `// why` after a real read is
 * still on a line the scanner must read.
 */
const RE_COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\/?|#)/;

/**
 * Walk the given directory roots and extract every statically-resolvable
 * env-var reference. Returns a ScanResult for the reconciler.
 * Pure I/O: no classification logic here.
 */
export function scanSourceReferences(roots: string[]): ScanResult {
  const referenced = new Map<string, string[]>();
  const cwd = process.cwd();

  function record(key: string, location: string): void {
    if (!RE_KEY.test(key)) return;
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

      const isShell = file.endsWith(".sh");
      const isPython = file.endsWith(".py");
      const assigned = isShell
        ? shellAssignedNames(content)
        : new Set<string>();

      // Line-by-line so a finding carries the line it was found on.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const loc = `${rel}:${i + 1}`;

        if (RE_COMMENT_LINE.test(line)) continue;

        if (isShell) {
          for (const m of line.matchAll(RE_SHELL_EXPANSION)) {
            if (!assigned.has(m[1]!)) record(m[1]!, loc);
          }
          continue;
        }
        if (isPython) {
          for (const m of line.matchAll(RE_PYTHON_ENV)) record(m[1]!, loc);
          continue;
        }
        for (const m of line.matchAll(RE_ENV_MEMBER)) record(m[1]!, loc);
        for (const m of line.matchAll(RE_ENV_SUBSCRIPT)) record(m[1]!, loc);
      }

      if (isShell || isPython) continue;

      // requireEnv([...]) — may span lines; match on full file content
      for (const m of content.matchAll(/\brequireEnv\s*\(\s*\[([^\]]+)\]/g)) {
        const arrayStr = m[1]!;
        const matchLine = content.slice(0, m.index).split("\n").length;
        const loc = `${rel}:${matchLine}`;
        for (const km of arrayStr.matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)) {
          record(km[1]!, loc);
        }
      }
    }
  }

  return { referenced };
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
  dead: Finding[];
  /** Referenced in code but completely absent from ENV_REGISTRY (and not allowlisted). */
  fail: Finding[];
}

export interface ReconcileInput {
  referenced: Map<string, string[]>;
  registryKeySet: Set<string>;
  schemaKeySet: Set<string>;
  /** key → service list (for dead-detection; pass from ENV_REGISTRY). */
  registryServiceMap: Map<string, string[]>;
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
}: ReconcileInput): EnvCheckReport {
  const report: EnvCheckReport = {
    ok: [],
    warnUnvalidated: [],
    dead: [],
    fail: [],
  };

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
    if (PLATFORM_ALLOWLIST.has(key)) continue;
    if (referenced.has(key)) continue;
    report.dead.push({
      key,
      reason: `services [${services.join(", ")}] listed but no source reference found`,
    });
  }

  return report;
}

// ── Reporter ──────────────────────────────────────────────────────────────────

/** Everything that makes this run exit non-zero. */
export function failureCount(
  report: EnvCheckReport,
  exampleDrift: boolean,
): number {
  return report.fail.length + report.dead.length + (exampleDrift ? 1 : 0);
}

function printReport(report: EnvCheckReport, exampleDrift: boolean): void {
  const failCount = failureCount(report, exampleDrift);
  const warnCount = report.warnUnvalidated.length;

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

  if (report.dead.length > 0) {
    console.log(
      kleur.red().bold("\n✗ FAIL — dead registry keys (nothing reads them)"),
    );
    for (const f of report.dead) {
      console.log(kleur.red(`  ${f.key}`) + ` — ${f.reason}`);
    }
    console.log(
      kleur.dim(
        "  Delete the entry, or clear its `services` list if it is tooling-only.",
      ),
    );
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

  const roots = SOURCE_ROOTS.map((d) => join(MONOREPO_ROOT, d));
  const { referenced } = scanSourceReferences(roots);

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
    exit(failureCount(report, exampleDrift) > 0 ? 1 : 0);
  }

  printReport(report, exampleDrift);
  exit(failureCount(report, exampleDrift) > 0 ? 1 : 0);
}

// Only run when this file is the entrypoint (tsx env-check.ts), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
