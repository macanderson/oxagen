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
 *
 * Output discipline (ADR-023 §4): `candidates`/`promote` `--json` emits one
 * single-line JSON value on stdout (payload shape preserved); every human view
 * (list, show, check verdict, scaffold + promote confirmations) is the answer
 * and goes to stdout; validation errors exit 2 (`usage`) and not-found errors
 * exit 1 — both as uniform `✗ …` stderr lines, never touching stdout. Every
 * handler takes a trailing {@link CommandWriter} so it is REPL-bridge safe.
 * (`list`/`show`/`check`/`new` have no `--json` flag registered in program.tsx.)
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
import { openFleetMemory } from "../rules/fleet-memory.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import type { TurnTrace } from "../agent/trace.js";
import type { MemoryRecord } from "../rules/fleet-memory.js";

export type RulesCmdCtx = Pick<LoadRulesOptions, "cwd" | "userRulesDir">;

/** Map the friendly `check` tool arg to a CLI tool id + the input field. */
const TOOL_ALIAS: Record<string, { tool: string; field: "path" | "command" }> =
  {
    bash: { tool: "bash", field: "command" },
    edit: { tool: "edit_file", field: "path" },
    write: { tool: "write_file", field: "path" },
    read: { tool: "read_file", field: "path" },
  };

export function rulesList(
  ctx: RulesCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const rules = loadRules(ctx).sort((a, b) => a.id.localeCompare(b.id));
  if (rules.length === 0) {
    writer.write(
      "No rules defined. Create one with `oxagen rules new <name>`.",
    );
    return;
  }
  const lines = ["Workspace rules:", ""];
  for (const r of rules) {
    lines.push(`  ${r.id}${r.guard ? "  [enforced]" : ""}`);
    if (r.description) lines.push(`    ${r.description}`);
  }
  writer.write(lines.join("\n"));
}

export function rulesShow(
  name: string,
  ctx: RulesCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({}, writer);
  const rule = loadRules(ctx).find((r) => r.id === name);
  if (!rule) {
    out.error(
      `Unknown rule "${name}". Run \`oxagen rules list\`.`,
      "not_found",
    );
    return;
  }
  const lines = [`# ${rule.id}`];
  if (rule.description) lines.push(rule.description);
  lines.push(`\nsource: ${rule.source}`);
  if (rule.guard) {
    const g = rule.guard;
    const parts = [
      g.tool ? `tool=${g.tool}` : "",
      g.denyPathGlob ? `denyPath=${g.denyPathGlob}` : "",
      g.denyCommandGlob ? `denyCommand=${g.denyCommandGlob}` : "",
    ].filter(Boolean);
    lines.push(`guard:  ${parts.join("  ")}  (hard-enforced)`);
  } else {
    lines.push("guard:  (none — prompt-only)");
  }
  lines.push("\n--- rule ---\n");
  lines.push(rule.text);
  writer.write(lines.join("\n"));
}

export function rulesNew(
  name: string,
  ctx: RulesCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({}, writer);
  if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
    process.exitCode = 2;
    out.error(
      `Invalid rule name "${name}". Use letters, digits, dashes, underscores.`,
      "usage",
    );
    return;
  }
  const { path, created } = scaffoldRule({ name, cwd: ctx.cwd });
  if (created) {
    writer.write(`✓ Created rule ${path}`);
    writer.write(
      "  Add a guard (guard-tool / guard-deny-path / guard-deny-command) to hard-enforce it.",
    );
  } else {
    writer.write(`${path} already exists — left untouched.`);
  }
}

/** Dry-run a proposed tool call against the rule guards (no model, no side effect). */
export function rulesCheck(
  tool: string,
  subject: string,
  ctx: RulesCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({}, writer);
  const alias = TOOL_ALIAS[tool.toLowerCase()];
  if (!alias) {
    process.exitCode = 2;
    out.error(
      `Unknown tool "${tool}". Use one of: ${Object.keys(TOOL_ALIAS).join(", ")}`,
      "usage",
    );
    return;
  }
  const { deny, reasons } = guardsToDeny(loadRules(ctx));
  const input = { [alias.field]: subject };
  const result = evaluateLocalPermission(alias.tool, input, { deny });
  if (result.decision === "deny") {
    const why = result.rule
      ? (reasons[result.rule] ?? result.reason)
      : result.reason;
    // The verdict IS the answer of a dry-run check → stdout; a matched guard is a
    // non-zero (blocked) result, not a failure, so it sets exit 1 without out.error.
    writer.write(`⛔ BLOCKED: ${tool} ${subject}`);
    writer.write(`   ${why}`);
    process.exitCode = 1;
  } else {
    writer.write(`✓ allowed: ${tool} ${subject} (no guard matched)`);
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
function gatherMineInput(ctx: RulesCandidatesCtx): {
  traces: TurnTrace[];
  memories: MemoryRecord[];
  existingRules: ReturnType<typeof loadRules>;
} {
  const cwd = ctx.cwd ?? process.cwd();
  const traces =
    ctx._traces ??
    dedupeTraces([...openTraceStore(cwd).list(), ...readVerboseLog(cwd)]);
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
  writer: CommandWriter = stdoutWriter,
): RuleCandidate[] {
  const out = createOutput({ json: opts.json }, writer);
  const { traces, memories, existingRules } = gatherMineInput(ctx);
  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
  const candidates = mineCandidates(
    { traces, memories, existingRules },
    limit ? { limit } : {},
  );

  if (out.isJson) {
    out.data(candidates);
    return candidates;
  }
  if (candidates.length === 0) {
    writer.write(
      "No promotion candidates yet. Recurring lessons surface here once the same gap is seen a few times (or a memory is already salient).",
    );
    return candidates;
  }
  const lines = [
    `${candidates.length} rule promotion candidate${candidates.length === 1 ? "" : "s"} (never auto-written — review, then \`oxagen rules promote <id> --yes\`):`,
    "",
  ];
  for (const c of candidates) {
    lines.push(`  ${c.id}${c.guard ? "  [guard candidate]" : ""}`);
    lines.push(`    ${c.text}`);
    lines.push(
      `    seen ${c.occurrences}x${c.salient ? ", includes an already-salient memory" : ""} — evidence: ${c.evidence
        .slice(0, 3)
        .map((e) => e.ref)
        .join(", ")}`,
    );
  }
  writer.write(lines.join("\n"));
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
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: opts.json }, writer);
  const { traces, memories, existingRules } = gatherMineInput(ctx);
  const candidates = mineCandidates({ traces, memories, existingRules });
  const candidate = candidates.find((c) => c.id === id);
  if (!candidate) {
    out.error(
      `Unknown candidate "${id}". Run \`oxagen rules candidates\` to see current candidates.`,
      "not_found",
    );
    return;
  }

  const dir = join(ctx.cwd ?? process.cwd(), ".oxagen", "rules");
  const result = promoteCandidate(candidate, { dir, approve: !!opts.yes });

  if (out.isJson) {
    out.data({ ...result, candidate });
    return;
  }
  if (result.status === "declined") {
    writer.write(`Not written (preview only):\n\n  ${candidate.text}\n`);
    writer.write(
      `Re-run with --yes to promote this to an enforced rule at ${result.path}.`,
    );
    return;
  }
  if (result.status === "already-exists") {
    writer.write(
      `${result.path} already exists — left untouched (already promoted).`,
    );
    return;
  }
  writer.write(`✓ Promoted to rule: ${result.path}`);
  writer.write(
    `  Injected into the system prompt every turn${candidate.guard ? "; also hard-enforced (guarded)" : ""}.`,
  );
}
