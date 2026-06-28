/**
 * enforce.ts — Turn rules into the two enforcement signals the agent loop needs.
 *
 *   - renderRulesSection(): Tier 1 — the system-prompt block listing every rule.
 *   - guardsToDeny():       Tier 2 — guarded rules become permission deny entries
 *                           (reusing the settings permission gate) plus a map from
 *                           the deny entry back to the rule text, so a blocked tool
 *                           call returns the human rule to the model.
 */
import type { Rule } from "./types.js";

/** The system-prompt section listing active rules (Tier 1: soft adherence). */
export function renderRulesSection(rules: Rule[]): string {
  if (rules.length === 0) return "";
  const lines = [
    "",
    "## Workspace rules (binding — follow exactly; guarded rules are hard-blocked)",
  ];
  for (const r of rules) {
    lines.push(`- ${r.text}${r.guard ? "  [enforced]" : ""}`);
  }
  return lines.join("\n");
}

/** The permission-gate deny entry a guard produces (e.g. `Edit(migrations/**)`). */
export function guardDenyEntry(rule: Rule): string | null {
  const guard = rule.guard;
  if (!guard) return null;
  const tool = guard.tool ?? "*";
  const pattern = guard.denyPathGlob ?? guard.denyCommandGlob;
  return pattern ? `${tool}(${pattern})` : tool;
}

export interface RuleDenies {
  /** Deny entries to merge into `permissions.deny` for the gate. */
  deny: string[];
  /** Deny entry → human block message (rule name + text) for the gate. */
  reasons: Record<string, string>;
}

/** Convert guarded rules into gate deny entries + their human reasons (Tier 2). */
export function guardsToDeny(rules: Rule[]): RuleDenies {
  const deny: string[] = [];
  const reasons: Record<string, string> = {};
  for (const rule of rules) {
    const entry = guardDenyEntry(rule);
    if (!entry) continue;
    deny.push(entry);
    reasons[entry] = `rule "${rule.id}" — ${rule.text}`;
  }
  return { deny, reasons };
}
