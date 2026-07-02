/**
 * rules command — manage and test workspace rules.
 *
 *   oxagen rules list                    List rules and which are hard-enforced
 *   oxagen rules show <name>             Show a rule's text + guard
 *   oxagen rules new <name>              Scaffold .oxagen/rules/<name>.md
 *   oxagen rules check <tool> <subject>  Dry-run a tool call against the guards
 *   oxagen rules candidates              Mine recurring lessons into promotion candidates
 *   oxagen rules promote <id> [--yes]    Promote a candidate to an enforced rule file
 *
 * Rules are injected into the agent's system prompt every turn and their guards
 * are hard-enforced at the tool gate.
 *
 * `candidates`/`promote` are distinct from `oxagen memory promote` — that
 * command raises a *platform* memory's epistemic class (OBSERVATION→RULE/FACT)
 * in the Neo4j-backed AgentMemory graph; this one mines the CLI's *local*
 * thinking logs + fleet memory and writes a `.oxagen/rules/*.md` file the loader
 * below reads back. Same spirit ("promote a proven lesson"), different store.
 */
import { join } from "node:path";
import {
  loadRules,
  guardsToDeny,
  scaffoldRule,
  mineCandidates,
  promoteCandidate,
  type LoadRulesOptions,
  type RuleCandidate,
} from "../rules/index.js";
import { evaluateLocalPermission } from "../settings/permissions-gate.js";
import { openTraceStore } from "../agent/trace-store.js";
import { readVerboseLog } from "../agent/verbose-log.js";
import { openFleetMemory } from "../agent/fleet/memory.js";
import type { TurnTrace } from "../agent/trace.js";
import type { MemoryRecord } from "../agent/fleet/memory.js";

export type RulesCmdCtx = Pick<LoadRulesOptions, "cwd" | "userRulesDir">;

/** Map the friendly `check` tool arg to a CLI tool id + the input field. */
const TOOL_ALIAS: Record<string, { tool: string; field: "path" | "command" }> = {
  bash: { tool: "bash", field: "command" },
  edit: { tool: "edit_file", field: "path" },
  write: { tool: "write_file", field: "path" },
  read: { tool: "read_file", field: "path" },
};

export function rulesList(ctx: RulesCmdCtx = {}): void {
  const rules = loadRules(ctx).sort((a, b) => a.id.localeCompare(b.id));
  if (rules.length === 0) {
    console.log("No rules defined. Create one with `oxagen rules new <name>`.");
    return;
  }
  console.log("Workspace rules:\n");
  for (const r of rules) {
    console.log(`  ${r.id}${r.guard ? "  [enforced]" : ""}`);
    if (r.description) console.log(`    ${r.description}`);
  }
}

export function rulesShow(name: string, ctx: RulesCmdCtx = {}): void {
  const rule = loadRules(ctx).find((r) => r.id === name);
  if (!rule) {
    console.error(`Unknown rule "${name}". Run \`oxagen rules list\`.`);
    process.exitCode = 1;
    return;
  }
  console.log(`# ${rule.id}`);
  if (rule.description) console.log(rule.description);
  console.log(`\nsource: ${rule.source}`);
  if (rule.guard) {
    const g = rule.guard;
    const parts = [
      g.tool ? `tool=${g.tool}` : "",
      g.denyPathGlob ? `denyPath=${g.denyPathGlob}` : "",
      g.denyCommandGlob ? `denyCommand=${g.denyCommandGlob}` : "",
    ].filter(Boolean);
    console.log(`guard:  ${parts.join("  ")}  (hard-enforced)`);
  } else {
    console.log("guard:  (none — prompt-only)");
  }
  console.log("\n--- rule ---\n");
  console.log(rule.text);
}

export function rulesNew(name: string, ctx: RulesCmdCtx = {}): void {
  if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
    console.error(`Invalid rule name "${name}". Use letters, digits, dashes, underscores.`);
    process.exitCode = 1;
    return;
  }
  const { path, created } = scaffoldRule({ name, cwd: ctx.cwd });
  if (created) {
    console.log(`✓ Created rule ${path}`);
    console.log("  Add a guard (guard-tool / guard-deny-path / guard-deny-command) to hard-enforce it.");
  } else {
    console.log(`${path} already exists — left untouched.`);
  }
}

/** Dry-run a proposed tool call against the rule guards (no model, no side effect). */
export function rulesCheck(tool: string, subject: string, ctx: RulesCmdCtx = {}): void {
  const alias = TOOL_ALIAS[tool.toLowerCase()];
  if (!alias) {
    console.error(`Unknown tool "${tool}". Use one of: ${Object.keys(TOOL_ALIAS).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const { deny, reasons } = guardsToDeny(loadRules(ctx));
  const input = { [alias.field]: subject };
  const result = evaluateLocalPermission(alias.tool, input, { deny });
  if (result.decision === "deny") {
    const why = result.rule ? reasons[result.rule] ?? result.reason : result.reason;
    console.log(`⛔ BLOCKED: ${tool} ${subject}`);
    console.log(`   ${why}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ allowed: ${tool} ${subject} (no guard matched)`);
  }
}

export interface RulesCandidatesCtx extends RulesCmdCtx {
  /** @internal test seam: override the mined turns (replaces the trace store + verbose log). */
  _traces?: TurnTrace[];
  /** @internal test seam: override the mined fleet-memory records (replaces openFleetMemory). */
  _memories?: MemoryRecord[];
}

/** Traces from the capped trace store and the (possibly larger) verbose log, deduped by id. */
function dedupeTraces(traces: TurnTrace[]): TurnTrace[] {
  const seen = new Set<string>();
  const out: TurnTrace[] = [];
  for (const t of traces) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/** Gather the local mining input for `cwd` — the one seam both candidates + promote share. */
function gatherMineInput(
  ctx: RulesCandidatesCtx,
): { traces: TurnTrace[]; memories: MemoryRecord[]; existingRules: ReturnType<typeof loadRules> } {
  const cwd = ctx.cwd ?? process.cwd();
  const traces = ctx._traces ?? dedupeTraces([...openTraceStore(cwd).list(), ...readVerboseLog(cwd)]);
  const memories = ctx._memories ?? openFleetMemory(cwd).all();
  return { traces, memories, existingRules: loadRules(ctx) };
}

export interface RulesCandidatesOptions {
  limit?: string;
  json?: boolean;
}

/**
 * `oxagen rules candidates` — mine local thinking logs + fleet memory for
 * recurring lessons and print them ranked, with evidence. Read-only: mining
 * never writes anything — see `rulesPromote` for the (approval-gated) write path.
 */
export function rulesCandidates(
  opts: RulesCandidatesOptions = {},
  ctx: RulesCandidatesCtx = {},
): RuleCandidate[] {
  const { traces, memories, existingRules } = gatherMineInput(ctx);
  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
  const candidates = mineCandidates({ traces, memories, existingRules }, limit ? { limit } : {});

  if (opts.json) {
    console.log(JSON.stringify(candidates, null, 2));
    return candidates;
  }
  if (candidates.length === 0) {
    console.log(
      "No promotion candidates yet. Recurring lessons surface here once the same gap is seen a few times (or a memory is already salient).",
    );
    return candidates;
  }
  console.log(
    `${candidates.length} rule promotion candidate${candidates.length === 1 ? "" : "s"} (never auto-written — review, then \`oxagen rules promote <id> --yes\`):\n`,
  );
  for (const c of candidates) {
    console.log(`  ${c.id}${c.guard ? "  [guard candidate]" : ""}`);
    console.log(`    ${c.text}`);
    console.log(
      `    seen ${c.occurrences}x${c.salient ? ", includes an already-salient memory" : ""} — evidence: ${c.evidence
        .slice(0, 3)
        .map((e) => e.ref)
        .join(", ")}`,
    );
  }
  return candidates;
}

export interface RulesPromoteOptions {
  yes?: boolean;
  json?: boolean;
}

/**
 * `oxagen rules promote <id>` — re-mine (deterministic over unchanged local
 * data) to resolve `id`, then write it as `.oxagen/rules/<id>.md` only when
 * `--yes` is passed. Without `--yes` this previews the candidate and writes
 * nothing — the decline path a user takes by simply not re-running with `--yes`.
 */
export function rulesPromote(
  id: string,
  opts: RulesPromoteOptions = {},
  ctx: RulesCandidatesCtx = {},
): void {
  const { traces, memories, existingRules } = gatherMineInput(ctx);
  const candidates = mineCandidates({ traces, memories, existingRules });
  const candidate = candidates.find((c) => c.id === id);
  if (!candidate) {
    console.error(`Unknown candidate "${id}". Run \`oxagen rules candidates\` to see current candidates.`);
    process.exitCode = 1;
    return;
  }

  const dir = join(ctx.cwd ?? process.cwd(), ".oxagen", "rules");
  const result = promoteCandidate(candidate, { dir, approve: !!opts.yes });

  if (opts.json) {
    console.log(JSON.stringify({ ...result, candidate }, null, 2));
    return;
  }
  if (result.status === "declined") {
    console.log(`Not written (preview only):\n\n  ${candidate.text}\n`);
    console.log(`Re-run with --yes to promote this to an enforced rule at ${result.path}.`);
    return;
  }
  if (result.status === "already-exists") {
    console.log(`${result.path} already exists — left untouched (already promoted).`);
    return;
  }
  console.log(`✓ Promoted to rule: ${result.path}`);
  console.log(
    `  Injected into the system prompt every turn${candidate.guard ? "; also hard-enforced (guarded)" : ""}.`,
  );
}
