#!/usr/bin/env node
/**
 * check-naming.mjs — enforce the ADR-025 verb-first snake_case naming standard.
 *
 * Canonical form: `verb_noun` or `verb_noun_qualifier`. Imperative verb FIRST,
 * then the entity, then an optional disambiguating word. Lowercase [a-z0-9]
 * words joined by `_`. 2-3 words (a 4th ONLY where global uniqueness truly
 * demands it — allowed but flagged as a warning). NO dots — the old dotted
 * `domain.subject.action` form (ADR-022) is superseded and illegal.
 *
 * This shape matches the repo's core engine tools (read_file, write_file,
 * edit_file, run_command, search, list_files, todo_write) — the form an LLM
 * agent parses best. Those engine tools are NOT registered capabilities and are
 * intentionally out of scope for this lint (they live in the agent engine, not
 * packages/oxagen/src/contracts).
 *
 * GLOBAL UNIQUENESS is mandatory: the name is a unique key across the registry,
 * IAM role_grants.capability_id, ClickHouse tool_invocations.capability_name,
 * and the on-disk contract file. Two contracts claiming one name is a hard fail.
 *
 * The lint validates every REAL capability — a contract file under
 * packages/oxagen/src/contracts that calls registerCapability(). Shared schema
 * modules (no registerCapability) are ignored. The GRANDFATHER map is EMPTY:
 * ADR-025 renamed every previously-grandfathered name to a conforming
 * verb-first snake form. A non-conforming name is a bug to fix, never a
 * grandfather entry.
 *
 * Exit codes: 0 clean · 1 violations · 2 script error.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const CAP_DIR = join(ROOT, "packages/oxagen/src/contracts");

// ── Verb vocabulary (ADR-025) ────────────────────────────────────────────────
// The FIRST word of every capability name must be one of these imperative verbs.
// Derived from the ADR-025 rename wave; extend only when a real capability needs
// a verb no existing entry covers (a near-synonym is a smell, not a new entry).
const VERBS = new Set([
  "accept", "acquire", "activate", "add", "aggregate", "analyze", "approve",
  "archive", "attach", "author", "browse", "cancel", "change", "cite", "click",
  "commit", "compose", "configure", "create", "debug", "decline", "delete",
  "deploy", "diff", "disable", "dispatch", "draft", "edit", "enable", "erase",
  "exec", "execute", "export", "fetch", "fill", "fork", "format", "generate",
  "get", "import", "infer", "ingest", "install", "list", "load", "map", "mark",
  "navigate", "open", "parse", "patch", "pause", "pin", "post", "preview",
  "promote", "publish", "purchase", "purge", "push", "put", "query", "read",
  "reauth", "recall", "recommend", "reconcile", "record", "refresh", "register",
  "release", "remember", "remove", "rename", "render", "resolve", "resume",
  "reveal", "revoke", "rotate", "run", "save", "screenshot", "search", "send",
  "set", "setup", "snapshot", "start", "stop", "submit", "suggest", "summarize",
  "sync", "toggle", "trace", "trigger", "uninstall", "unset", "update", "upload",
  "upsert", "validate", "verify", "write",
]);

// ── Grandfather list (emptied by ADR-025) ────────────────────────────────────
// ADR-022 left 14 non-conforming names here. ADR-025 renamed all of them to
// verb-first snake forms. This map is now empty and MUST stay empty — a
// non-conforming name is a bug to fix, never a grandfather entry.
const GRANDFATHER = new Map([]);

// Charset: 2+ lowercase [a-z0-9] words joined by `_`. No dots, no kebab, no
// uppercase, no empty word. (Word-count > 3 is a warning, not a failure.)
const NAME_RE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

function readRealCapabilityNames() {
  if (!existsSync(CAP_DIR)) {
    console.error(`No contracts dir at ${CAP_DIR}`);
    process.exit(2);
  }
  const names = [];
  for (const file of readdirSync(CAP_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "index.ts") continue;
    const src = readFileSync(join(CAP_DIR, file), "utf8");
    if (!/registerCapability\s*\(/.test(src)) continue; // shared modules skipped
    // Capture the capability name from inside the registerCapability(...) block,
    // so an earlier `name:` zod field in an input schema can't be mistaken for it.
    const block = src.split(/registerCapability\s*\(/).slice(1).join("");
    const m = block.match(/name:\s*["'`]([^"'`]+)["'`]/);
    if (m) names.push({ name: m[1], file });
  }
  return names;
}

function validate(name) {
  const problems = [];
  const warnings = [];
  if (name.includes(".")) problems.push("dots are illegal (ADR-025 supersedes the dotted form — use verb_noun snake_case)");
  if (name.includes("-")) problems.push("kebab-case is illegal (use snake_case)");
  if (!NAME_RE.test(name)) {
    problems.push("must be 2+ lowercase [a-z0-9] words joined by '_'");
    return { problems, warnings }; // charset failure — later checks would be noise
  }
  const words = name.split("_");
  if (!VERBS.has(words[0])) {
    problems.push(`first word "${words[0]}" is not an imperative verb (name must be verb-first)`);
  }
  if (words.length > 3) {
    warnings.push(`${words.length} words — keep names to 2-3 words unless uniqueness truly demands a 4th`);
  }
  return { problems, warnings };
}

function main() {
  const caps = readRealCapabilityNames();
  const violations = [];
  const warnings = [];

  for (const { name, file } of caps) {
    if (GRANDFATHER.has(name)) continue;
    const { problems, warnings: w } = validate(name);
    if (problems.length) violations.push({ name, file, problems });
    for (const msg of w) warnings.push({ name, file, msg });
  }

  // GLOBAL UNIQUENESS gate.
  const byName = new Map();
  for (const { name, file } of caps) {
    const arr = byName.get(name) ?? [];
    arr.push(file);
    byName.set(name, arr);
  }
  const dupes = [...byName.entries()].filter(([, files]) => files.length > 1);

  console.log(`check-naming: validated ${caps.length} capabilities against ADR-025 (verb-first snake_case).`);

  if (warnings.length) {
    console.warn(`\nWORD-COUNT WARNINGS (${warnings.length}, non-blocking):`);
    for (const { name, file, msg } of warnings) console.warn(`  ! ${name}  [${file}] — ${msg}`);
  }

  let failed = false;

  if (dupes.length) {
    failed = true;
    console.error(`\nDUPLICATE CAPABILITY NAMES — global uniqueness violated (${dupes.length}):`);
    for (const [name, files] of dupes) console.error(`  ✗ "${name}": ${files.join(", ")}`);
  }

  if (violations.length) {
    failed = true;
    console.error(`\nNAMING VIOLATIONS (${violations.length}):`);
    for (const { name, file, problems } of violations) {
      console.error(`  ✗ ${name}  [${file}]`);
      for (const p of problems) console.error(`      - ${p}`);
    }
    console.error(
      `\nFix the name to verb-first snake_case (see ADR-025). ` +
      `A non-conforming name is a bug, not a grandfather entry.`,
    );
  }

  if (failed) process.exit(1);
  console.log("All capability names conform to ADR-025 and are globally unique.");
}

main();
