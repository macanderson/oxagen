/**
 * rules command — manage and test workspace rules.
 *
 *   oxagen rules list                    List rules and which are hard-enforced
 *   oxagen rules show <name>             Show a rule's text + guard
 *   oxagen rules new <name>              Scaffold .oxagen/rules/<name>.md
 *   oxagen rules check <tool> <subject>  Dry-run a tool call against the guards
 *
 * Rules are injected into the agent's system prompt every turn and their guards
 * are hard-enforced at the tool gate.
 */
import { loadRules, guardsToDeny, scaffoldRule, type LoadRulesOptions } from "../rules/index.js";
import { evaluateLocalPermission } from "../settings/permissions-gate.js";

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
