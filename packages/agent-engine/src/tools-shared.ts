// tools-shared.ts
//
// Pure, near-dependency-free helpers shared between the generic workspace tools
// (tools.ts) and the deterministic structured tools (tools-structured/). Kept in
// its own module so tools-structured can reuse them without importing tools.ts
// (which imports tools-structured — a cycle we avoid by putting the shared leaf
// here). tools.ts re-exports `isTestPath` so its existing public surface is
// unchanged.
//
// Three concerns live here, each a leaf the tools compose:
//   1. isTestPath — the test-file predicate (below).
//   2. The tool-NAMING standard (ADR-022 pending): canonical `domain.subject.
//      action` names + the canonical↔model-facing mapping, so every new
//      structured tool gets its model-facing name mechanically.
//   3. The shared ARG fragments (scopeSchema / verbositySchema / limitSchema)
//      every new structured tool composes, so their inputs stay uniform.

import { z } from "zod";

/**
 * Directory-name path segments that mark everything beneath them as test code.
 * "testing" is included because pytest's own suite lives in `testing/` — on
 * SWE-bench a candidate edited `testing/python/integration.py` (a graded
 * FAIL_TO_PASS file) right past the guard. Some repos (e.g. matplotlib's
 * `lib/matplotlib/testing/`) keep test *utilities* there, so a rare
 * legitimate source fix can be denied — acceptable for this bench/CI-only
 * gate: a false block redirects the agent to the real source, while a false
 * allow lets it self-certify against tests it rewrote.
 */
const TEST_DIR_NAMES = new Set(["tests", "test", "__tests__", "testing"]);

/** Basename patterns, matched against the lowercased filename only. */
const TEST_BASENAME_PATTERNS: RegExp[] = [
  /^test_.*\.py$/, // test_*.py
  /_test\.py$/, // *_test.py
  /^conftest\.py$/, // conftest.py
  /\.test\.(ts|tsx|js|jsx)$/, // *.test.ts(x) / *.test.js(x)
  /\.spec\.(ts|tsx|js|jsx)$/, // *.spec.ts(x) / *.spec.js(x)
  /_spec\.rb$/, // *_spec.rb
  /test\.java$/, // *Test.java
  /_test\.go$/, // *_test.go
];

/**
 * True when `relPath` looks like a test file, by directory convention
 * (`tests/`, `test/`, `__tests__/` anywhere in the path) or by filename
 * convention (`test_*.py`, `*.test.ts`, `*_spec.rb`, …). Case-insensitive;
 * matches anywhere in the path, whether absolute or repo-relative. Pure.
 */
export function isTestPath(relPath: string): boolean {
  const segments = relPath
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const basename = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((seg) => TEST_DIR_NAMES.has(seg))) return true;
  return TEST_BASENAME_PATTERNS.some((re) => re.test(basename));
}

// ── Tool naming standard (ADR-022 pending) ───────────────────────────────────
//
// Canonical tool names are `domain.subject.action` — exactly three dot-separated
// segments, singular nouns, snake_case for a compound word WITHIN one segment.
// The model-facing name is the canonical name with every out-of-charset char
// (the provider tool-name grammar is ^[A-Za-z0-9_-]) replaced by `_`, so a
// structured tool and any capability twin present the SAME name to the model.
// This registry + the two mapping helpers are the single mechanism every future
// structured tool reuses, so naming is decided once, not per tool.
//
// The core file/exec tools (read_file, write_file, edit_file, list_dir,
// search, bash) deliberately KEEP their plain, short model-facing names
// (training-prior protection) and are intentionally absent from this registry
// — they are not `domain.subject.action` and must not be renamed.

/** The deterministic structured tools this engine advertises, canonical form. */
export const CANONICAL_TOOL_NAMES = [
  "test.unit.run",
  "test.trace.run",
  "build.package.run",
  "git.diff.summarize",
  "workspace.health.check",
] as const;

export type CanonicalToolName = (typeof CANONICAL_TOOL_NAMES)[number];

/**
 * Canonical dotted name → model-facing name: replace every character outside the
 * provider tool-name charset (`^[A-Za-z0-9_-]`) with `_`. Kept byte-identical to
 * the kernel's `toModelToolName` (packages/agent/src/runtime/materialize-tools.ts)
 * so a structured tool named `x.y.z` and a materialized capability `x.y.z`
 * resolve to the same `x_y_z`. Pure.
 */
export function modelToolName(canonical: string): string {
  return canonical.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Reverse map, built once. `modelToolName` is lossy in general (a snake_case
// compound segment also contributes `_`), so recovering the canonical name is a
// registry lookup — never a naive `_`→`.` replace, which would corrupt compounds.
const MODEL_TO_CANONICAL: ReadonlyMap<string, CanonicalToolName> = new Map(
  CANONICAL_TOOL_NAMES.map((name) => [modelToolName(name), name] as const),
);

/**
 * Model-facing name (e.g. `test_unit_run`) → canonical dotted name (e.g.
 * `test.unit.run`). A name already containing a dot is returned unchanged (it is
 * already canonical); an unknown name is returned unchanged too — callers needing
 * strictness check membership in {@link CANONICAL_TOOL_NAMES}. Pure.
 */
export function canonicalToolName(name: string): string {
  if (name.includes(".")) return name;
  return MODEL_TO_CANONICAL.get(name) ?? name;
}

// ── Shared ARG fragments (ARG STANDARD) ──────────────────────────────────────

/**
 * Scope fragment: a structured tool targets exactly ONE of a workspace package,
 * an explicit file list, or `all`. The exactly-one refinement makes both "no
 * scope" and "two scopes" a validation error at the tool boundary, so a tool
 * never guesses what the caller meant. `all` is the deliberate opt-in to the
 * widest run a tool permits — and a tool that forbids a whole-repo run (e.g.
 * test.unit.run) rejects `all` in its own handler, not here.
 */
export const scopeSchema = z
  .object({
    package: z
      .string()
      .min(1)
      .optional()
      .describe("Workspace package name to scope to (e.g. '@oxagen/billing')."),
    files: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Explicit file paths to scope to (relative to cwd)."),
    all: z
      .boolean()
      .optional()
      .describe(
        "Operate on the widest scope the tool allows (not the whole repo where forbidden).",
      ),
  })
  .refine(
    (s) =>
      [s.package !== undefined, s.files !== undefined, s.all === true].filter(
        Boolean,
      ).length === 1,
    { message: "Provide exactly one of: package, files, or all." },
  );

export type ToolScope = z.output<typeof scopeSchema>;

/**
 * Output verbosity: `minimal` (default) returns the compressor's tightest useful
 * payload (ADR-021 §3); `standard`/`verbose` raise the per-list caps toward a
 * hard ceiling but NEVER switch a tool to raw output. See {@link resolveLimit}.
 */
export const verbositySchema = z
  .enum(["minimal", "standard", "verbose"])
  .default("minimal")
  .describe("Detail level: minimal (default, tightest), standard, or verbose.");

export type Verbosity = z.output<typeof verbositySchema>;

/**
 * A bounded result-list cap fragment. Each tool passes its own `hardMax` (the
 * verbose ceiling). Optional — omitting it lets {@link resolveLimit} pick the cap
 * from the verbosity level instead.
 */
export function limitSchema(hardMax: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(hardMax)
    .optional()
    .describe(
      `Max items to return (1–${hardMax}). Omit to let verbosity choose the cap.`,
    );
}

/**
 * Resolve the effective result cap. An explicit `limit` wins but is clamped to
 * the verbose ceiling so no caller can exceed the tool's hard max; otherwise the
 * cap is the ceiling for the chosen `verbosity`. Pure.
 */
export function resolveLimit(
  verbosity: Verbosity,
  caps: { minimal: number; standard: number; verbose: number },
  limit?: number,
): number {
  if (limit !== undefined) return Math.max(1, Math.min(limit, caps.verbose));
  return caps[verbosity];
}
