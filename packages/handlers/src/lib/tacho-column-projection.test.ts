import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every relational read of `tacho.hosts` or `tacho.sessions` names its columns.
 *
 * Drizzle's `findFirst`/`findMany` select every column the schema declares, so
 * an unprojected read of either table names whatever the newest migration
 * added. Production applies migrations by hand after the deploy (#1275), so in
 * that window the read raises 42703 and the handler fails — for a column it was
 * never interested in.
 *
 * This is a test rather than a note because of how the defect it guards was
 * found. The host reads were guarded first; the session reads were checked,
 * judged already projected, and were not — `tacho.session.list` and
 * `tacho.session.get` still selected `gateway_observed_at`
 * (discussion_r4040558842). Nothing about a partly-guarded tree looks different
 * from a guarded one, which is exactly the shape a test is for.
 *
 * Projected means `columns:` is present, not that it is correct: an explicit
 * list is a decision someone made about a specific column, and the next
 * migration cannot silently join it. `columns: await sessionReadColumns(tx)`
 * satisfies this by being that decision, deferred to a probe.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const GUARDED = ["tachoHosts", "tachoSessions"] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.includes("test-support")) continue;
    out.push(path);
  }
  return out;
}

/** The `{...}` argument of a call, read by balancing braces from its `{`. */
function argumentObject(source: string, openBrace: number): string {
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace, i + 1);
    }
  }
  return source.slice(openBrace);
}

function unprojectedReads(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const found: string[] = [];
  const pattern = new RegExp(
    `query\\.(${GUARDED.join("|")})\\.(findFirst|findMany)\\(\\{`,
    "g",
  );
  for (const match of source.matchAll(pattern)) {
    const brace = match.index + match[0].length - 1;
    if (argumentObject(source, brace).includes("columns")) continue;
    const line = source.slice(0, match.index).split("\n").length;
    found.push(`${path.slice(SRC.length + 1)}:${line} ${match[0]}`);
  }
  return found;
}

describe("tacho relational reads", () => {
  it("name their columns, so a pending migration cannot break them", () => {
    const files = sourceFiles(SRC);
    // The scan is worthless if it reads nothing; a broken path would pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap(unprojectedReads)).toEqual([]);
  });

  it("detects an unprojected read", () => {
    // The discriminating case: the same call, with and without `columns`. A
    // test that only asserts the tree is clean passes just as well when the
    // scan matches nothing at all.
    const withColumns = `await tx.query.tachoSessions.findFirst({
      where: eq(schema.tachoSessions.id, id),
      columns: { id: true },
    });`;
    const without = `await tx.query.tachoSessions.findFirst({
      where: eq(schema.tachoSessions.id, id),
    });`;
    const scan = (source: string): boolean => {
      const match = source.match(
        /query\.(tachoHosts|tachoSessions)\.(findFirst|findMany)\(\{/,
      );
      if (!match?.index) return false;
      const brace = match.index + match[0].length - 1;
      return !argumentObject(source, brace).includes("columns");
    };
    expect(scan(without)).toBe(true);
    expect(scan(withColumns)).toBe(false);
  });
});
