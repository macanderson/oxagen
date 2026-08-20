/**
 * Schema smoke tests for @oxagen/database.
 *
 * These tests operate entirely on the TypeScript/Drizzle table definitions
 * via `getTableConfig` — no live DB, no network, no random/wall-clock values.
 *
 * Policy assertions:
 *
 *  1. Append-only tables (credit_ledger, stripe_events, security_events)
 *     must NOT carry updated_at or deleted_at columns.
 *     Presence of those columns would allow mutation/soft-delete of immutable
 *     audit rows — a SOC2 compliance violation.
 *
 *  2. credit_balances must have a "balance_cents >= 0" CHECK constraint (the
 *     no-overdraft floor). The constraint name must contain
 *     "balance_non_negative" and the SQL expression must reference
 *     "balance_cents" and ">= 0".
 *
 *  3. credit_ledger must have a "delta_cents <> 0" CHECK constraint (a
 *     zero-delta entry is a logic error that pollutes the audit trail). The
 *     constraint name must contain "delta_non_zero" and the SQL expression
 *     must reference "delta_cents" and "<>".
 *
 * Implementation note on queryChunks:
 *   Drizzle 0.45.x stores each CHECK constraint's SQL expression as a
 *   SQL object whose `.queryChunks` array interleaves:
 *     - plain-SQL objects: { value: string[] } — the literal SQL fragments
 *     - column-reference objects: { name: string, ... } — the column
 *   We walk chunks and collect (a) literal strings from `.value[]` and (b)
 *   column names from `.name`, then join into a single string for matching.
 */

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  creditLedger,
  stripeEvents,
  securityEvents,
  creditBalances,
  agentRunAttempts,
  agentRunAttemptLeases,
  agentRunCheckpoints,
  agentRunAttemptSeals,
  agentRunFinalizationGrants,
  agentRunFinalizationObligations,
  repositoryBindings,
  retentionPolicyVersions,
  authorizationSnapshots,
  authorizationDecisions,
} from "../schema/index";
import {
  flattenCheckSql,
  sqlColumnNames,
  type DrizzleCheck,
} from "./_test-helpers";

// ---------------------------------------------------------------------------
// 1. Append-only tables: must have no updated_at or deleted_at columns
// ---------------------------------------------------------------------------

const FORBIDDEN_COLS = [
  "updated_at",
  "deleted_at",
  "updated_by_user_id",
  "deleted_by_user_id",
];

describe("append-only tables: forbidden mutation columns", () => {
  const appendOnlyTables: Array<
    [string, Parameters<typeof getTableConfig>[0]]
  > = [
    ["credit_ledger", creditLedger],
    ["stripe_events", stripeEvents],
    ["security_events", securityEvents],
    // ── Governed-run evidence foundation (run-evidence-ingress) ─────────────
    // The migration revokes UPDATE/DELETE from oxagen_app on every one of
    // these. This assertion is the schema-side half of that promise: a table
    // that grows an updated_at/deleted_at column is a table someone intends to
    // mutate, and the shape would then contradict the privilege posture. The
    // privilege posture itself is asserted against a live database in
    // integration/run-attempt-foundation.test.ts and
    // integration/authorization-foundation.test.ts.
    //
    // agent_run_attempt_leases is deliberately ABSENT: it is the one mutable
    // row in the foundation (renew/append/fence/seal all advance it) and
    // legitimately carries updated_at. Its DELETE is still revoked.
    ["agent_run_attempts", agentRunAttempts],
    ["agent_run_checkpoints", agentRunCheckpoints],
    ["agent_run_attempt_seals", agentRunAttemptSeals],
    ["agent_run_finalization_grants", agentRunFinalizationGrants],
    ["agent_run_finalization_obligations", agentRunFinalizationObligations],
    ["repository_bindings", repositoryBindings],
    ["retention_policy_versions", retentionPolicyVersions],
    ["authorization_snapshots", authorizationSnapshots],
    ["authorization_decisions", authorizationDecisions],
  ];

  for (const [tableName, table] of appendOnlyTables) {
    it(`${tableName} has no updated_at or deleted_at column`, () => {
      const cols = sqlColumnNames(table);
      for (const forbidden of FORBIDDEN_COLS) {
        expect(
          cols,
          `${tableName} must not have SQL column "${forbidden}"`,
        ).not.toContain(forbidden);
      }
    });
  }

  it("agent_run_attempt_leases is the documented mutable exception", () => {
    // Guard against the opposite drift: if someone "tidies" the lease into an
    // append-only shape, renew/fence/seal lose their only place to record
    // progress and the fencing token stops being observable.
    const cols = sqlColumnNames(agentRunAttemptLeases);
    expect(cols).toContain("updated_at");
    expect(cols).toContain("fenced_at");
    expect(cols).toContain("lease_epoch");
    // Still never soft-deletable — a fenced lease is evidence, not garbage.
    expect(cols).not.toContain("deleted_at");
  });
});

// ---------------------------------------------------------------------------
// 2. credit_balances: balance_cents >= 0 CHECK constraint
// ---------------------------------------------------------------------------

describe("credit_balances CHECK constraints", () => {
  const cfg = getTableConfig(creditBalances);
  const checks = cfg.checks as DrizzleCheck[];

  it("has a balanceCents column (SQL: balance_cents)", () => {
    const cols = sqlColumnNames(creditBalances);
    expect(cols).toContain("balance_cents");
  });

  it("CHECK constraint name includes 'balance_non_negative'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("balance_non_negative")),
      `Expected a CHECK named "..._balance_non_negative" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });

  it("balance_non_negative CHECK SQL references balance_cents and >= 0", () => {
    const target = checks.find((c) => c.name.includes("balance_non_negative"));
    expect(target, "balance_non_negative CHECK not found").toBeDefined();

    const sql = flattenCheckSql(target!);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/balance_cents/);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/>=/);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/0/);
  });
});

// ---------------------------------------------------------------------------
// 3. credit_ledger: delta_cents <> 0 CHECK constraint
// ---------------------------------------------------------------------------

describe("credit_ledger CHECK constraints", () => {
  const cfg = getTableConfig(creditLedger);
  const checks = cfg.checks as DrizzleCheck[];

  it("has a deltaCents column (SQL: delta_cents)", () => {
    const cols = sqlColumnNames(creditLedger);
    expect(cols).toContain("delta_cents");
  });

  it("CHECK constraint name includes 'delta_non_zero'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("delta_non_zero")),
      `Expected a CHECK named "..._delta_non_zero" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });

  it("delta_non_zero CHECK SQL references delta_cents and <> 0", () => {
    const target = checks.find((c) => c.name.includes("delta_non_zero"));
    expect(target, "delta_non_zero CHECK not found").toBeDefined();

    const sql = flattenCheckSql(target!);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/delta_cents/);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/<>/);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/0/);
  });
});

// ---------------------------------------------------------------------------
// 4. stripe_events: unique idempotency anchor on stripe_event_id
// ---------------------------------------------------------------------------

describe("stripe_events unique idempotency constraint", () => {
  it("has a stripe_event_id column", () => {
    const cols = sqlColumnNames(stripeEvents);
    expect(cols).toContain("stripe_event_id");
  });

  it("has a unique index on stripe_event_id", () => {
    const cfg = getTableConfig(stripeEvents);
    const uniqueIndexNames = cfg.indexes
      .filter((idx) => idx.config.unique === true)
      .map((idx) => idx.config.name);
    expect(
      uniqueIndexNames.some((n) => n?.includes("stripe_event")),
      `Expected a unique index containing "stripe_event" but found: [${uniqueIndexNames.join(", ")}]`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. security_events: outcome CHECK constraint exists
// ---------------------------------------------------------------------------

describe("security_events CHECK constraints", () => {
  const cfg = getTableConfig(securityEvents);
  const checks = cfg.checks as DrizzleCheck[];

  it("has an outcome column", () => {
    const cols = sqlColumnNames(securityEvents);
    expect(cols).toContain("outcome");
  });

  it("CHECK constraint name includes 'outcome_check'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("outcome_check")),
      `Expected a CHECK named "..._outcome_check" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. security_events: event_type CHECK constraint includes all billing.* types
//    (SOC2 CC6.3/CC6.8 drift guard — if this fails, the TS union and/or
//    migration SQL are out of sync with the Drizzle table definition)
// ---------------------------------------------------------------------------

import { SECURITY_EVENT_TYPES } from "../schema/security";

describe("security_events event_type CHECK constraint — billing.* types present", () => {
  const cfg = getTableConfig(securityEvents);
  const checks = cfg.checks as DrizzleCheck[];

  const eventTypeCheck = checks.find((c) =>
    c.name.includes("event_type_check"),
  );

  it("has an event_type_check constraint", () => {
    expect(
      eventTypeCheck,
      `Expected a CHECK named "..._event_type_check" but found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  it("CHECK SQL includes all billing.* values from the TS union", () => {
    const sql = flattenCheckSql(eventTypeCheck!);
    const billingTypes = SECURITY_EVENT_TYPES.filter((t) =>
      t.startsWith("billing."),
    );
    for (const t of billingTypes) {
      expect(
        sql,
        `CHECK SQL missing billing type "${t}": got "${sql}"`,
      ).toContain(t);
    }
  });

  it("SECURITY_EVENT_TYPES includes exactly the expected billing.* event types", () => {
    const billingTypes = SECURITY_EVENT_TYPES.filter((t) =>
      t.startsWith("billing."),
    );
    const expected = [
      "billing.access_denied",
      "billing.auto_reload_updated",
      "billing.checkout_initiated",
      "billing.credits_purchased",
      "billing.payment_method_added",
      "billing.payment_method_default_changed",
      "billing.payment_method_removed",
      "billing.plan_changed",
      "billing.seats_changed",
      "billing.subscription_canceled",
      "billing.subscription_reactivated",
      "billing.budget_updated",
      "billing.reseller_customer_changed",
      "billing.reseller_price_plan_changed",
      "billing.reseller_attribution_rule_changed",
      "billing.reseller_stripe_configured",
      "billing.reseller_rebill_pushed",
    ];
    expect(billingTypes.sort()).toEqual(expected.sort());
  });
});

// ---------------------------------------------------------------------------
// 7. Governed-run foundation: the V1/V2 discriminant and the one-shot grant
//
// These assertions exist because the discriminant is the ONLY thing standing
// between a preserved legacy row and a trusted one. If a CHECK is weakened or a
// partial unique index loses its predicate, the schema still compiles, the
// integration tests still pass on empty tables, and the failure only surfaces
// once real V1 history and real V2 evidence share the table.
// ---------------------------------------------------------------------------

import {
  agentRuns,
  agentRunEvents,
  emergencyDenies,
  authorizationDenyGenerations,
} from "../schema/index";
import { getChecks } from "./_test-helpers";

/** Find a CHECK by name fragment and return its flattened SQL. */
function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  fragment: string,
): string {
  const checks = getChecks(table);
  const target = checks.find((c) => c.name.includes(fragment));
  expect(
    target,
    `Expected a CHECK matching "${fragment}" but found: [${checks
      .map((c) => c.name)
      .join(", ")}]`,
  ).toBeDefined();
  return flattenCheckSql(target!);
}

describe("agent.agent_runs — RunSpecV2 discriminant", () => {
  it("keeps every V2 identity column NULLABLE at the column level", () => {
    // Column-level NOT NULL would make the expand migration impossible: the
    // table already holds V1 history with no trusted principal, repository, or
    // retention binding, and inventing one is exactly what the expand-only rule
    // forbids. Completeness is the conditional CHECK below instead.
    const cfg = getTableConfig(agentRuns);
    const v2Identity = [
      "run_kind",
      "spec_digest",
      "initiating_principal_id",
      "agent_principal_id",
      "agent_version_id",
      "agent_version_checksum",
      "authorization_snapshot_id",
      "repository_binding_id",
      "base_commit_sha",
      "base_tree_sha",
      "retention_policy_id",
      "retention_policy_digest",
      "max_attempts",
    ];
    for (const name of v2Identity) {
      const col = cfg.columns.find((c) => c.name === name);
      expect(col, `missing column ${name}`).toBeDefined();
      expect(col!.notNull, `${name} must stay nullable for V1 rows`).toBe(
        false,
      );
    }
  });

  it("spec_version defaults to 1 so existing rows backfill as legacy", () => {
    const col = getTableConfig(agentRuns).columns.find(
      (c) => c.name === "spec_version",
    );
    expect(col?.notNull).toBe(true);
    expect(col?.default).toBe(1);
  });

  it("the identity CHECK requires ALL V2 bindings and forbids them on V1", () => {
    const sql = checkSql(agentRuns, "v2_identity_check");
    // Both arms present: V1 forbids the typed set, V2 requires it.
    expect(sql).toContain("spec_version");
    for (const col of [
      "run_kind",
      "spec_digest",
      "initiating_principal_id",
      "agent_principal_id",
      "authorization_snapshot_id",
      "repository_binding_id",
      "base_commit_sha",
      "base_tree_sha",
      "retention_policy_id",
      "retention_policy_digest",
      "max_attempts",
    ]) {
      expect(sql, `identity CHECK must mention ${col}`).toContain(col);
    }
    expect(sql).toContain("IS NOT NULL");
    expect(sql).toContain("IS NULL");
  });

  it("bounds attempt_count by the pinned max_attempts", () => {
    const sql = checkSql(agentRuns, "attempt_count_check");
    expect(sql).toContain("attempt_count");
    expect(sql).toContain("max_attempts");
  });

  it("carries a next_run_seq counter rather than a global SEQUENCE", () => {
    // A SEQUENCE would not roll back with a failed append, so two events could
    // claim one run sequence. The counter lives on the row and advances inside
    // the append transaction.
    const col = getTableConfig(agentRuns).columns.find(
      (c) => c.name === "next_run_seq",
    );
    expect(col?.notNull).toBe(true);
    expect(col?.default).toBe(1);
  });
});

describe("agent.agent_run_events — V1/V2 record discriminant", () => {
  const cfg = getTableConfig(agentRunEvents);

  it("makes the legacy seq/type/payload columns nullable for V2 rows", () => {
    for (const name of ["seq", "type", "payload"]) {
      const col = cfg.columns.find((c) => c.name === name);
      expect(col, `missing legacy column ${name}`).toBeDefined();
      expect(col!.notNull, `${name} must be nullable so V2 rows omit it`).toBe(
        false,
      );
    }
  });

  it("defaults event_record_version to 1 so existing rows backfill as legacy", () => {
    const col = cfg.columns.find((c) => c.name === "event_record_version");
    expect(col?.notNull).toBe(true);
    expect(col?.default).toBe(1);
  });

  it("replaces the full (run_id, seq) unique with THREE partial uniques", () => {
    const uniques = cfg.indexes.filter((i) => i.config.unique === true);
    const byName = new Map(uniques.map((i) => [i.config.name, i]));

    for (const name of [
      "agent_run_events_v1_run_seq_uq",
      "agent_run_events_v2_run_seq_uq",
      "agent_run_events_v2_attempt_seq_uq",
    ]) {
      expect(byName.has(name), `missing partial unique ${name}`).toBe(true);
      // A predicate is what keeps a V2 row from being read as legacy. Without
      // it the index degenerates into the old full unique.
      expect(
        byName.get(name)!.config.where,
        `${name} must be PARTIAL (predicate on event_record_version)`,
      ).toBeDefined();
    }

    // The old full unique must be gone, or a V2 row could still collide on the
    // legacy key. Drizzle models it as a uniqueConstraint, not an index.
    const legacyNames = [
      ...uniques.map((i) => i.config.name),
      ...cfg.uniqueConstraints.map((u) => u.name),
    ];
    expect(legacyNames).not.toContain("agent_run_events_run_seq_uq");
  });

  it("requires exactly one of inline payload or encrypted reference on V2", () => {
    const sql = checkSql(agentRunEvents, "record_shape_check");
    expect(sql).toContain("payload_inline");
    expect(sql).toContain("encrypted_payload_ref");
    // The XOR spelling: (a IS NULL) <> (b IS NULL).
    expect(sql).toContain("<>");
  });

  it("constrains stage to the nine evidence stages", () => {
    const sql = checkSql(agentRunEvents, "stage_check");
    for (const stage of [
      "admission",
      "checkout",
      "context",
      "model",
      "tool",
      "change",
      "verification",
      "provider_publish",
      "terminal",
    ]) {
      expect(sql, `stage CHECK missing "${stage}"`).toContain(stage);
    }
  });
});

describe("finalization grant + obligation — one-shot, non-expiring, derived pending", () => {
  it("pins the grant to exactly one capability", () => {
    const sql = checkSql(agentRunFinalizationGrants, "capability_check");
    expect(sql).toContain("ingest_run_evidence");
  });

  it("has NO expiry column — the binding is the limiting authority", () => {
    // An operational expiry would let a KMS or storage outage strand an
    // obligation behind a dead grant. One successful consumption bounds it
    // instead (spec.md §"Security and retention rules").
    const cols = sqlColumnNames(agentRunFinalizationGrants);
    expect(cols).not.toContain("expires_at");
    expect(cols).not.toContain("expired_at");
  });

  it("has NO processed_at on the obligation — pending is derived by anti-join", () => {
    // A mutable processed flag reintroduces the crash window the outbox exists
    // to close: written evidence + unmarked obligation, or marked obligation +
    // rolled-back evidence.
    const cols = sqlColumnNames(agentRunFinalizationObligations);
    expect(cols).not.toContain("processed_at");
    expect(cols).not.toContain("status");
    // The stable submission identity IS the grant's public id.
    expect(cols).toContain("submission_id");
  });

  it("enforces (org_id, submission_id) uniqueness on the obligation", () => {
    const cfg = getTableConfig(agentRunFinalizationObligations);
    const idx = cfg.indexes.find(
      (i) =>
        i.config.unique === true &&
        i.config.name === "agent_run_finalization_obligations_submission_uq",
    );
    expect(idx).toBeDefined();
    expect(
      idx!.config.columns.map((c) => (c as { name: string }).name),
    ).toEqual(["org_id", "submission_id"]);
  });

  it("lets a zero-event abandoned attempt seal without a final-event digest", () => {
    // The reclaimer must be able to seal an attempt that accepted nothing,
    // WITHOUT synthesizing a terminal event. event_count = 0 pairs with a NULL
    // final-event digest and the canonical empty stream digest.
    const sql = checkSql(agentRunAttemptSeals, "event_evidence_check");
    expect(sql).toContain("event_count");
    expect(sql).toContain("final_event_digest");
    const streamCol = sqlColumnNames(agentRunAttemptSeals);
    expect(streamCol).toContain("event_stream_digest");
    const cfg = getTableConfig(agentRunAttemptSeals);
    // The stream digest is ALWAYS present, even at zero events.
    expect(
      cfg.columns.find((c) => c.name === "event_stream_digest")?.notNull,
    ).toBe(true);
    expect(
      cfg.columns.find((c) => c.name === "final_event_digest")?.notNull,
    ).toBe(false);
  });
});

describe("iam deny state — narrowing only", () => {
  it("keeps the deny generation monotonic (>= 1) and scope-typed", () => {
    const gen = checkSql(authorizationDenyGenerations, "generation_check");
    expect(gen).toContain("generation");
    expect(gen).toContain(">=");
    const scope = checkSql(authorizationDenyGenerations, "scope_kind_check");
    expect(scope).toContain("org");
    expect(scope).toContain("workspace");
  });

  it("forces an emergency deny to target a capability XOR a resource scope", () => {
    const sql = checkSql(emergencyDenies, "deny_kind_check");
    expect(sql).toContain("capability_id");
    expect(sql).toContain("resource_scope_digest");
  });

  it("keeps deactivated denies as rows rather than deletions", () => {
    const sql = checkSql(emergencyDenies, "active_check");
    expect(sql).toContain("deactivated_at");
    // No soft-delete columns — `active = false` IS the deactivation record.
    expect(sqlColumnNames(emergencyDenies)).not.toContain("deleted_at");
  });

  it("requires an authorization decision to record the generation it saw", () => {
    const sql = checkSql(authorizationDecisions, "generation_check");
    expect(sql).toContain("org_deny_generation");
    expect(sql).toContain("workspace_deny_generation");
  });

  it("requires run bindings to be complete or absent", () => {
    const sql = checkSql(authorizationDecisions, "run_binding_check");
    expect(sql).toContain("run_id");
    expect(sql).toContain("attempt_id");
    expect(sql).toContain("authorization_snapshot_id");
  });
});
