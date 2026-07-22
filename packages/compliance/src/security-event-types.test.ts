import { readFileSync } from "node:fs";
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
  // The newest security_events CHECK migration is generated FROM this module
  // (see db-check.ts). If someone adds an event type without the paired
  // additive migration, inserts of that type fail at runtime with a constraint
  // violation — silently, because the TS union already admits it. This test is
  // the thing that fails first.
  const MIGRATION = fileURLToPath(
    new URL(
      "../../database/atlas/migrations/" +
        "20260813120000_agent_run_authorization_security_events.sql",
      import.meta.url,
    ),
  );

  it("the latest event_type migration contains every value in SECURITY_EVENT_TYPES", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    for (const type of SECURITY_EVENT_TYPES) {
      expect(sql).toContain(`'${type}'`);
    }
  });

  it("the migration's CHECK body is byte-identical to the generated clause", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(generateEventTypeCheckClause("event_type"));
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
