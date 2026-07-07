#!/usr/bin/env node
/**
 * check-naming.mjs — enforce the ADR-022 capability naming standard.
 *
 * Canonical form: `domain.subject.action` (exactly 3 segments); a compound
 * concept is snake_case INSIDE one segment (agent.file_lock.acquire); segments
 * are lowercase [a-z0-9] words joined by `_`. The SUBJECT-ELISION rule permits
 * a 2-segment `domain.action` when the implied subject is the domain's root
 * entity (connection.list = "list connections"). The final segment (the action)
 * must come from the closed verb vocabulary below.
 *
 * The lint validates every REAL capability — a contract file under
 * packages/oxagen/src/contracts that calls registerCapability(). Shared schema
 * modules (no registerCapability) are ignored. Names that predate the standard
 * and were deliberately NOT renamed in the ADR-022 wave are listed in
 * GRANDFATHER with a reason, so the remaining debt is explicit and visible.
 *
 * Exit codes: 0 clean · 1 violations · 2 script error.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const CAP_DIR = join(ROOT, "packages/oxagen/src/contracts");

// ── Closed action vocabulary (ADR-022 §4) ────────────────────────────────────
// A genuine, verb-only set: the final segment of every 3-segment canonical name
// MUST be one of these. Derived by auditing every terminal verb actually in use.
// snake_case compounds (set_enabled, import_env) are single actions. Keep this
// MINIMAL — add a verb only when a real capability needs one no existing verb
// covers. (2-segment names are exempt from this check — see validate(): a
// `domain.X` is either verb-elision or a subject read with an implied `get`.)
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
  // snake_case compound actions
  "set_enabled", "set_default", "set_secret", "set_auth_alerts",
  "import_env", "install_bulk", "from_traces",
]);

// ── Grandfather list (ADR-022 §7) ─────────────────────────────────────────────
// Pre-standard names deliberately NOT renamed in this wave. Each entry is a
// visible unit of naming debt. Removing an entry is a ratchet — do it when the
// name is fixed, never to silence the lint.
// Every entry is a pre-standard 3-segment name whose final segment is a noun,
// not a verb. The ADR-022 wave's sanctioned renames were the 4-segment collapse
// and the domain dedupe; these noun-terminal reads are a separate class of debt
// deferred to a follow-up wave (renaming each still touches 6+ files per name).
// Each reason names the conforming form so the fix is unambiguous.
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
// by `.`; 2 or 3 segments total. No kebab, no uppercase, no empty segment.
const WORD = "[a-z0-9]+(?:_[a-z0-9]+)*";
const NAME_RE = new RegExp(`^${WORD}(?:\\.${WORD}){1,2}$`);

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
    problems.push("must be 2–3 lowercase [a-z0-9_] segments joined by '.'");
    return problems; // charset failure — later checks would be noise
  }
  const segs = name.split(".");
  if (segs.length > 3) problems.push("more than 3 segments (fold compounds with snake_case)");
  // The action-vocabulary check applies only to 3-segment names. A 2-segment
  // `domain.X` is legal either as verb-elision (connection.list) OR as a subject
  // read with an implied `get` (workflow.status) — both are blessed by the
  // subject-elision rule (ADR-022 §2), so its final segment is unconstrained.
  if (segs.length === 3) {
    const action = segs[segs.length - 1];
    if (!ACTIONS.has(action)) {
      problems.push(`final segment "${action}" is not in the closed action vocabulary`);
    }
  }
  return problems;
}

function main() {
  const caps = readRealCapabilityNames();
  const violations = [];
  for (const { name, file } of caps) {
    if (GRANDFATHER.has(name)) continue;
    const problems = validate(name);
    if (problems.length) violations.push({ name, file, problems });
  }

  console.log(`check-naming: validated ${caps.length} capabilities against ADR-022` +
    ` (${GRANDFATHER.size} grandfathered).`);

  if (violations.length) {
    console.error(`\nNAMING VIOLATIONS (${violations.length}):`);
    for (const { name, file, problems } of violations) {
      console.error(`  ✗ ${name}  [${file}]`);
      for (const p of problems) console.error(`      - ${p}`);
    }
    console.error(
      `\nFix the name (add aliases:[<old>] so nothing breaks — see ADR-022), or, ` +
      `if it must ship non-conforming, add it to GRANDFATHER in this script with a reason.`,
    );
    process.exit(1);
  }
  console.log("All capability names conform to ADR-022.");
}

main();
