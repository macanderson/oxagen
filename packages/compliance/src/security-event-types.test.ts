import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EMITTED_SECURITY_EVENT_TYPES,
  RESERVED_SECURITY_EVENT_TYPES,
  SECURITY_EVENT_TYPES,
  SECURITY_OUTCOMES,
  isEmittedSecurityEventType,
  isSecurityEventType,
  isSecurityOutcome,
} from "./security-event-types";
import {
  generateEventTypeCheckClause,
  generateOutcomeCheckClause,
  quotedEventTypeList,
  quotedOutcomeList,
} from "./db-check";
import * as barrel from "./index";

describe("security event taxonomy invariants", () => {
  it("has no duplicate event types", () => {
    expect(new Set(SECURITY_EVENT_TYPES).size).toBe(
      SECURITY_EVENT_TYPES.length,
    );
  });

  it("has no duplicate outcomes", () => {
    expect(new Set(SECURITY_OUTCOMES).size).toBe(SECURITY_OUTCOMES.length);
  });

  it("groups all values of a domain contiguously (no interleaving)", () => {
    // Each domain's entries must form one contiguous run, so the file stays
    // readable as grouped blocks even though within-group order is by lifecycle.
    const seen = new Set<string>();
    let currentDomain: string | null = null;
    for (const t of SECURITY_EVENT_TYPES) {
      const domain = t.split(".")[0]!;
      if (domain !== currentDomain) {
        expect(seen.has(domain)).toBe(false);
        seen.add(domain);
        currentDomain = domain;
      }
    }
  });

  it("uses the <domain>.<event> naming shape for every type", () => {
    for (const t of SECURITY_EVENT_TYPES) {
      expect(t).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("includes exactly the expected plugin.* governance event types", () => {
    // SOC2 CC6.3/CC6.8 drift guard — privileged plugin mutations (install,
    // uninstall, enabled-state change, denylist add/remove) must stay auditable.
    const pluginTypes = SECURITY_EVENT_TYPES.filter((t) =>
      t.startsWith("plugin."),
    );
    const expected = [
      "plugin.installed",
      "plugin.uninstalled",
      "plugin.enabled_changed",
      "plugin.denylist_added",
      "plugin.denylist_removed",
    ];
    expect([...pluginTypes].sort()).toEqual([...expected].sort());
  });

  it("includes exactly the four governed-run integrity event types", () => {
    // docs/specs/run-evidence-ingress — drift guard. These are INTEGRITY
    // failures (a contradicted evidence chain), never ordinary policy denials,
    // which stay on capability.invoke_denied.
    const runTypes = SECURITY_EVENT_TYPES.filter((t) =>
      t.startsWith("agent_run."),
    );
    expect([...runTypes].sort()).toEqual([
      "agent_run.event_sequence_conflict",
      "agent_run.finalization_grant_misuse",
      "agent_run.forged_decision_reference",
      "agent_run.stale_deny_generation",
    ]);
  });
});

describe("migration drift — the DB CHECK must match the taxonomy", () => {
  // The security_events event_type CHECK is generated FROM this module (see
  // db-check.ts). Adding an event type without the paired additive migration
  // fails SILENTLY at review time and LOUDLY in production: the TS union already
  // admits the value, so the insert compiles and then dies on a constraint
  // violation. This test is the thing that fails first.
  //
  // The migration is DISCOVERED, not hard-coded: whoever adds the next event
  // type writes a new migration, and this guard must move to it automatically
  // rather than demand an unrelated edit here.
  const MIGRATIONS_DIR = fileURLToPath(
    new URL("../../database/atlas/migrations/", import.meta.url),
  );

  /** The most recent migration that redefines the named CHECK constraint. */
  function latestMigrationDefining(constraint: string): {
    file: string;
    sql: string;
  } {
    const candidates = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse();
    for (const file of candidates) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (sql.includes(constraint)) {
        return { file, sql };
      }
    }
    throw new Error(
      `No migration defines ${constraint} — that column has no enforcing ` +
        "constraint.",
    );
  }

  const latestEventTypeMigration = () =>
    latestMigrationDefining("security_events_event_type_check");

  it("the latest event_type migration contains every value in SECURITY_EVENT_TYPES", () => {
    const { file, sql } = latestEventTypeMigration();
    for (const type of SECURITY_EVENT_TYPES) {
      // The failure message names the migration so the fix is obvious: either
      // add a new additive migration, or the type was added without one.
      expect(sql, `${type} is missing from ${file}`).toContain(`'${type}'`);
    }
  });

  it("the migration's CHECK body is byte-identical to the generated clause", () => {
    const { file, sql } = latestEventTypeMigration();
    expect(
      sql,
      `${file} drifted from generateEventTypeCheckClause()`,
    ).toContain(generateEventTypeCheckClause("event_type"));
  });

  it("the latest outcome migration contains every value in SECURITY_OUTCOMES", () => {
    // Same failure mode as event_type, and previously unguarded: SECURITY_OUTCOMES
    // is a const-union the emit path type-checks against, so adding a fifth
    // outcome without an additive migration compiles cleanly and then dies on a
    // constraint violation in production.
    //
    // Value-containment, not byte-identity: the shipped constraint is written as
    // `outcome = ANY (ARRAY['allow'::text, ...])` (Postgres' normalised form),
    // which is semantically equal to generateOutcomeCheckClause()'s `IN (...)`
    // but not textually equal. Requiring byte-identity here would fail on a
    // correct database.
    const { file, sql } = latestMigrationDefining(
      "security_events_outcome_check",
    );
    for (const outcome of SECURITY_OUTCOMES) {
      expect(sql, `${outcome} is missing from ${file}`).toContain(
        `'${outcome}'`,
      );
    }
  });
});

describe("public entry point (./index barrel)", () => {
  // Every external consumer imports "@oxagen/compliance", which resolves to the
  // barrel — apps/app's audit-filter parser, @oxagen/telemetry's emit helper, and
  // @oxagen/database's CHECK-constraint builder all do. Dropping a re-export line
  // from index.ts would break all three, so assert the surface directly rather
  // than only reaching the modules by their deep paths.
  it("re-exports the whole taxonomy and generator surface", () => {
    expect(barrel.SECURITY_EVENT_TYPES).toBe(SECURITY_EVENT_TYPES);
    expect(barrel.SECURITY_OUTCOMES).toBe(SECURITY_OUTCOMES);
    expect(barrel.isSecurityEventType).toBe(isSecurityEventType);
    expect(barrel.isSecurityOutcome).toBe(isSecurityOutcome);
    expect(barrel.quotedEventTypeList).toBe(quotedEventTypeList);
    expect(barrel.quotedOutcomeList).toBe(quotedOutcomeList);
    expect(barrel.generateEventTypeCheckClause).toBe(
      generateEventTypeCheckClause,
    );
    expect(barrel.generateOutcomeCheckClause).toBe(generateOutcomeCheckClause);
  });
});

describe("type guards", () => {
  it("recognises known event types and rejects unknown ones", () => {
    expect(isSecurityEventType("auth.sign_in")).toBe(true);
    expect(isSecurityEventType("auth.telepathy")).toBe(false);
    expect(isSecurityEventType("")).toBe(false);
  });

  it("recognises known outcomes and rejects unknown ones", () => {
    expect(isSecurityOutcome("allow")).toBe(true);
    expect(isSecurityOutcome("maybe")).toBe(false);
  });
});

describe("db CHECK clause generation", () => {
  it("includes every event type, single-quoted", () => {
    const list = quotedEventTypeList();
    for (const t of SECURITY_EVENT_TYPES) {
      expect(list).toContain(`'${t}'`);
    }
  });

  it("includes every outcome, single-quoted", () => {
    const list = quotedOutcomeList();
    for (const o of SECURITY_OUTCOMES) {
      expect(list).toContain(`'${o}'`);
    }
  });

  it("builds a column-scoped IN expression for event types", () => {
    const clause = generateEventTypeCheckClause("event_type");
    expect(clause).toBe(`event_type IN (${quotedEventTypeList()})`);
    expect(clause.startsWith("event_type IN (")).toBe(true);
  });

  it("builds a column-scoped IN expression for outcomes", () => {
    expect(generateOutcomeCheckClause()).toBe(
      `outcome IN (${quotedOutcomeList()})`,
    );
  });

  it("escapes embedded single quotes (injection-safety regression)", () => {
    // Drive the escape branch directly; our real constants never contain quotes.
    expect(quotedEventTypeList(["o'brien.test" as never])).toBe(
      "'o''brien.test'",
    );
  });
});

/**
 * The repository root, found by walking up for the workspace manifest.
 *
 * Deliberately not `git rev-parse`: the CI container runs as a different user
 * than the checkout owner, so git refuses with "detected dubious ownership" and
 * a module-level call takes the whole file down with it. The question this scan
 * asks — does any shipping file mention this literal — is about the filesystem,
 * not about git, so it asks the filesystem.
 */
function repoRoot(): string {
  let dir = resolve(import.meta.dirname);
  for (let up = 0; up < 10; up += 1) {
    try {
      statSync(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "could not locate the workspace root from " + import.meta.dirname,
  );
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__snapshots__",
]);

/**
 * Every shipping source file under `packages/` and `apps/`.
 *
 * Tests are excluded, and that distinction is the point: a test asserting a type
 * is NOT offered mentions the literal without emitting it, so counting tests
 * would let a type look covered because something checks it is absent. The
 * taxonomy itself is excluded for the same reason — it declares the names.
 */
function shippingSources(): string[] {
  const root = repoRoot();
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(full);
        }
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      if (entry.name.includes(".test.")) continue;
      if (entry.name.startsWith("security-event-types")) continue;
      out.push(full);
    }
  };

  walk(join(root, "packages"));
  walk(join(root, "apps"));
  return out;
}

/** Event-type literals that appear in shipping source, computed in one pass. */
function referencedTypes(): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of shippingSources()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const type of SECURITY_EVENT_TYPES) {
      if (!found.has(type) && text.includes(`"${type}"`)) found.add(type);
    }
  }
  return found;
}

describe("the emitted subset", () => {
  it("is the full union minus the reserved list, with no third copy to drift", () => {
    expect(new Set(EMITTED_SECURITY_EVENT_TYPES)).toEqual(
      new Set(
        SECURITY_EVENT_TYPES.filter(
          (t) => !RESERVED_SECURITY_EVENT_TYPES.includes(t as never),
        ),
      ),
    );
    expect(
      EMITTED_SECURITY_EVENT_TYPES.length +
        RESERVED_SECURITY_EVENT_TYPES.length,
    ).toBe(SECURITY_EVENT_TYPES.length);
  });

  it("excludes every reserved type", () => {
    for (const type of RESERVED_SECURITY_EVENT_TYPES) {
      expect(EMITTED_SECURITY_EVENT_TYPES, type).not.toContain(type);
      expect(isEmittedSecurityEventType(type), type).toBe(false);
    }
  });

  it("keeps the full union intact for the DB CHECK and historical rows", () => {
    // Narrowing what a UI offers must never narrow what the column accepts.
    for (const type of RESERVED_SECURITY_EVENT_TYPES) {
      expect(SECURITY_EVENT_TYPES).toContain(type);
    }
  });

  it("names the eight the audit found", () => {
    expect(RESERVED_SECURITY_EVENT_TYPES).toHaveLength(8);
  });
});

/**
 * The markers are only worth anything if they are true. These fail in BOTH
 * directions, which is what the module's note asks for: a reserved type that
 * gained an emitter is a stale marker, and a non-reserved type that lost its
 * last one is a type quietly reading as covered.
 */
describe("the RESERVED markers match the repository", () => {
  it("finds no emitter for any reserved type", () => {
    const referenced = referencedTypes();
    const stale = RESERVED_SECURITY_EVENT_TYPES.filter((t) =>
      referenced.has(t),
    );
    expect(
      stale,
      `these are marked RESERVED but something now references them — ` +
        `move them into the emitted set: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("finds a reference for every emitted type", () => {
    const referenced = referencedTypes();
    const orphaned = EMITTED_SECURITY_EVENT_TYPES.filter(
      (t) => !referenced.has(t),
    );
    expect(
      orphaned,
      `these are offered as filterable but nothing references them — ` +
        `mark them RESERVED: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });
});
