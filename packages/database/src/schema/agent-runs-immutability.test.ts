/**
 * The `agent_runs_v2_immutability` trigger freezes a V2 run's bindings
 * (#3999, ADR-197). The operator's workspace role is stamped once, in the
 * run's INSERT, and a role changed in the workspace afterwards must not
 * rewrite what the run says, so the trigger refuses an UPDATE that changes it.
 *
 * The function is redefined whenever a column joins the frozen list, and a
 * redefinition that drops a column would unfreeze it without any error. So
 * the newest definition must freeze every column the first one froze, plus
 * `operator_role`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../atlas/migrations/", import.meta.url),
);

const DEFINITION = 'FUNCTION "agent"."agent_runs_v2_immutability"()';

/** Every function body that defines the trigger, oldest migration first. */
function definitions(): Array<{ file: string; body: string }> {
  const found: Array<{ file: string; body: string }> = [];
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    let at = text.indexOf(DEFINITION);
    while (at !== -1) {
      const end = text.indexOf("$$;", at);
      found.push({ file, body: text.slice(at, end === -1 ? undefined : end) });
      at = text.indexOf(DEFINITION, at + DEFINITION.length);
    }
  }
  return found;
}

/** The columns a body refuses to change: each `NEW.<col> IS DISTINCT FROM OLD.<col>`. */
function frozenColumns(body: string): Set<string> {
  const columns = new Set<string>();
  for (const match of body.matchAll(
    /NEW\.([a-z_]+) IS DISTINCT FROM OLD\.([a-z_]+)/g,
  )) {
    const [, before, after] = match;
    if (before !== undefined && before === after) columns.add(before);
  }
  return columns;
}

describe("agent_runs_v2_immutability", () => {
  const all = definitions();

  it("is defined by at least the foundation migration", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it("freezes the stamped operator role in its newest definition", () => {
    const newest = all[all.length - 1];
    expect(frozenColumns(newest?.body ?? "")).toContain("operator_role");
  });

  it("keeps every column the first definition froze", () => {
    const first = frozenColumns(all[0]?.body ?? "");
    const newest = frozenColumns(all[all.length - 1]?.body ?? "");
    expect(first.size).toBeGreaterThan(0);
    for (const column of first) expect(newest).toContain(column);
  });
});
