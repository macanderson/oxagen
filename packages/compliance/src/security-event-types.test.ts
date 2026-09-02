import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SECURITY_EVENT_TYPES,
  SECURITY_OUTCOMES,
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
