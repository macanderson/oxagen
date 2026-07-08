#!/usr/bin/env node
/**
 * check-naming.mjs — enforce the ADR-024 capability naming standard.
 *
 * PROPOSED REVISION (ADR-024, Status: Proposed) — NOT YET THE LIVE LINT.
 * This file tightens ADR-022's `domain.subject.action` rule: names are now
 * EXACTLY 3 segments, always. The old 2-segment subject-elision rule
 * (ADR-022 §2) is removed. Do not wire this into `pnpm check:contracts` /
 * `pnpm check:naming` until the renames enumerated in
 * docs/specs/adr024-naming-mapping.md are actually executed — flipping the
 * `NAME_RE` to require exactly 3 segments before then would fail CI on every
 * one of the ~160 capabilities that still use the old shape.
 *
 * Canonical form: `domain.subject.verb` (exactly 3 segments); a compound
 * concept is snake_case INSIDE one segment (agent.file_lock.acquire); segments
 * are lowercase [a-z0-9] words joined by `_`. The verb (final segment) must
 * come from the closed action vocabulary below and MAY be a snake_case
 * compound (get_status, list_neighbors, dispatch_agent, stop_agent, …).
 *
 * Subject plurality (ADR-024 §3) — PLURAL subject for collection/list ops,
 * SINGULAR for single-instance ops — cannot be fully mechanized (the tool
 * can't know a capability's return cardinality from its name alone), so it is
 * enforced only as a WARNING heuristic: a `.list`/`.search` verb whose
 * subject doesn't already look plural (doesn't end in `s`, and isn't in the
 * small KNOWN_MASS_NOUNS allowlist of collective/mass-noun subjects that are
 * legitimately singular even for a list op, e.g. "registry") is flagged for
 * human review, not failed.
 *
 * The lint validates every REAL capability — a contract file under
 * packages/oxagen/src/contracts that calls registerCapability(). Shared schema
 * modules (no registerCapability) are ignored. The GRANDFATHER map is
 * UNCHANGED from ADR-022 pending execution of the ADR-024 rename wave — ADR-024
 * will empty this map once every entry below gets a conforming name (tracked
 * in docs/specs/adr024-naming-mapping.md); do not add new entries to silence
 * this lint, and do not remove entries until the underlying contract is
 * actually renamed.
 *
 * Exit codes: 0 clean · 1 violations · 2 script error.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const CAP_DIR = join(ROOT, "packages/oxagen/src/contracts");

// ── Closed action vocabulary (ADR-022 §4, carried forward by ADR-024 §4) ─────
// A genuine, verb-only set: the final segment of every 3-segment canonical name
// MUST be one of these. Derived by auditing every terminal verb actually in use.
// snake_case compounds (set_enabled, import_env, get_status, list_neighbors) are
// single actions. Keep this MINIMAL — add a verb only when a real capability
// needs one no existing verb covers. Under ADR-024 there are no 2-segment
// exemptions: EVERY name's final segment is checked against this vocabulary.
const ACTIONS = new Set([
  // read / list
  "list", "get", "read", "query", "search", "preview", "browse", "fetch",
  "summarize", "recommend", "recall", "trace",
  // create / write
  "create", "update", "write", "upsert", "add", "put", "record", "author",
  "compose", "generate", "render", "remember", "cite", "attach", "import",
  "ingest", "commit", "publish", "snapshot", "fork", "rename", "edit", "export",
  // delete / lifecycle
  "delete", "remove", "purge", "erase", "archive", "cancel", "stop", "start",
  "run", "execute", "exec", "deploy", "resume", "pause", "trigger", "dispatch",
  "aggregate", "promote", "acquire", "release", "push",
  // config / toggles / auth
  "set", "unset", "enable", "disable", "toggle", "configure", "setup",
  "activate", "install", "uninstall", "register", "reauth", "rotate", "revoke",
  "reveal", "pin", "purchase", "load", "map", "diff", "patch", "sync",
  "reconcile", "approve", "decline", "accept", "resolve", "suggest", "infer",
  "check", "verify", "validate", "analyze", "chat", "change", "mark", "send",
  "open", "format", "parse", "upload", "refresh", "screenshot", "submit",
  "fill", "click", "navigate",
  // snake_case compound actions (ADR-024 leans on this harder than ADR-022 did
  // — every former noun-terminal grandfather entry resolves to one of these)
  "set_enabled", "set_default", "set_secret", "set_auth_alerts",
  "import_env", "install_bulk", "from_traces",
  "get_status", "get_lineage", "get_logs", "get_metrics", "get_execution",
  "list_siblings", "list_neighbors", "post_message", "create_bulk",
]);

// ── Mass/collective-noun allowlist for the plurality WARNING (ADR-024 §3) ────
// Subjects that legitimately stay singular even under a list/search verb
// because they denote one collective thing being listed/browsed, not many
// discrete instances (e.g. "list the registry" reads fine singular). This is
// intentionally small — prefer fixing the name over adding to this list.
const KNOWN_MASS_NOUNS = new Set(["usage", "metrics", "data", "registry"]);

// ── Grandfather list (ADR-022 §7; UNCHANGED pending the ADR-024 rename wave) ──
// Pre-standard names deliberately NOT renamed yet. Each entry is a visible unit
// of naming debt. ADR-024 clears this map to empty once every entry below is
// actually renamed per docs/specs/adr024-naming-mapping.md — do NOT add new
// entries to silence this lint, and do NOT remove an entry until its contract
// is renamed.
const GRANDFATHER = new Map([
  ["agent.execution.lineage", "noun-terminal read → agent.execution.get_lineage or agent.execution_lineage.get"],
  ["agent.subagent.logs", "noun-terminal read → agent.subagent.get_logs or agent.subagent_log.list"],
  ["agent.subagent.siblings", "noun-terminal read → agent.subagent.list_siblings or agent.subagent_sibling.list"],
  ["billing.usage.breakdown", "noun-terminal read → billing.usage.summarize or billing.usage_breakdown.get"],
  ["chat.message.execution", "noun-terminal read → chat.message.get_execution or chat.message_execution.get"],
  ["eval.run.status", "noun-terminal read (X.Y.status convention) → eval.run.get or eval.run_status.get"],
  ["repo.ci.status", "noun-terminal read (X.Y.status convention) → repo.ci.get or repo.ci_status.get"],
  ["research.swarm.status", "noun-terminal read (X.Y.status convention) → research.swarm.get or research.swarm_status.get"],
  ["schema.reconcile.status", "noun-terminal read (X.Y.status convention) → schema.reconcile.get or schema.reconcile_status.get"],
  ["schema.registry.config", "noun-terminal read → schema.registry.get or schema.registry_config.get"],
  ["schema.validate.node", "action-in-middle (validate.node) → schema.node.validate"],
  ["schema.validate.relationship", "action-in-middle (validate.relationship) → schema.relationship.validate"],
  ["system.install.instructions", "noun-terminal read → system.install_instructions.get"],
  ["telemetry.error.cluster", "noun-terminal read (cluster used as a noun) → telemetry.error_cluster.list or telemetry.error.summarize"],
]);

// Charset: lowercase alnum words joined by `_` inside a segment; segments joined
// by `.`; EXACTLY 3 segments under ADR-024 (the ADR-022 2-segment allowance is
// removed). No kebab, no uppercase, no empty segment.
const WORD = "[a-z0-9]+(?:_[a-z0-9]+)*";
const NAME_RE = new RegExp(`^${WORD}\\.${WORD}\\.${WORD}$`);

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
    const m = src.match(/name:\s*["'`]([^"'`]+)["'`]/);
    if (m) names.push({ name: m[1], file });
  }
  return names;
}

function validate(name) {
  const problems = [];
  if (name.includes("-")) problems.push("kebab-case is illegal (use snake_case inside a segment)");
  if (!NAME_RE.test(name)) {
    problems.push("must be exactly 3 lowercase [a-z0-9_] segments joined by '.' (ADR-024 removes the 2-segment form)");
    return problems; // charset/segment-count failure — later checks would be noise
  }
  const segs = name.split(".");
  const verb = segs[2];
  if (!ACTIONS.has(verb)) {
    problems.push(`final segment "${verb}" is not in the closed action vocabulary`);
  }
  return problems;
}

// Best-effort, non-blocking heuristic (ADR-024 §3): a list/search verb whose
// subject doesn't look plural is worth a human glance, but plurality can't be
// fully mechanized (a subject could be an irregular plural, a mass noun not in
// our small allowlist, or a compound where only the head noun pluralizes) —
// so this returns warnings, never failures.
function pluralityWarning(name) {
  const segs = name.split(".");
  if (segs.length !== 3) return null;
  const [, subject, verb] = segs;
  if (verb !== "list" && verb !== "search") return null;
  if (KNOWN_MASS_NOUNS.has(subject)) return null;
  if (subject.endsWith("s")) return null; // naive but cheap; false negatives (irregular plurals) are fine for a warning
  return `subject "${subject}" looks singular for a "${verb}" (collection) verb — consider pluralizing, or add to KNOWN_MASS_NOUNS if it's a genuine mass noun`;
}

function main() {
  const caps = readRealCapabilityNames();
  const violations = [];
  const warnings = [];
  for (const { name, file } of caps) {
    if (GRANDFATHER.has(name)) continue;
    const problems = validate(name);
    if (problems.length) violations.push({ name, file, problems });
    const warn = pluralityWarning(name);
    if (warn) warnings.push({ name, file, warn });
  }

  console.log(`check-naming: validated ${caps.length} capabilities against ADR-024` +
    ` (${GRANDFATHER.size} grandfathered).`);

  if (warnings.length) {
    console.warn(`\nPLURALITY WARNINGS (${warnings.length}, non-blocking):`);
    for (const { name, file, warn } of warnings) {
      console.warn(`  ! ${name}  [${file}] — ${warn}`);
    }
  }

  if (violations.length) {
    console.error(`\nNAMING VIOLATIONS (${violations.length}):`);
    for (const { name, file, problems } of violations) {
      console.error(`  ✗ ${name}  [${file}]`);
      for (const p of problems) console.error(`      - ${p}`);
    }
    console.error(
      `\nFix the name (add aliases:[<old>] so nothing breaks — see ADR-022 §6 / ADR-024 §6), or, ` +
      `if it must ship non-conforming, add it to GRANDFATHER in this script with a reason.`,
    );
    process.exit(1);
  }
  console.log("All capability names conform to ADR-024.");
}

main();
