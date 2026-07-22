import { describe, expect, it } from "vitest";
import { POLICY_MANIFEST, type PolicyClass } from "./tenant-policy.manifest";

describe("tenant policy manifest", () => {
  it("assigns a known class to every table", () => {
    const classes: PolicyClass[] = [
      "standard",
      "workspace_nullable",
      "org_only",
      "workspace_only",
      "org_or_global",
      "standard_or_builtin",
    ];
    for (const entry of POLICY_MANIFEST) {
      expect(classes).toContain(entry.policyClass);
      expect(entry.table).toMatch(/^[a-z_]+\.[a-z][a-z0-9_]*$/); // schema.table (digits ok after first char, e.g. a2a_tasks)
    }
  });

  it("includes the known standard owned tables", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).toContain("agent.skills");
    expect(tables).toContain("agent.agents");
    expect(tables).toContain("chat.conversations");
  });

  it("covers the playbook domain added by the 2026-06-11 rebuild (OXA-1700)", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    for (const t of [
      "workflow.playbooks",
      "workflow.playbook_triggers",
      "workflow.playbook_runs",
      "workflow.playbook_step_runs",
      "workflow.playbook_events",
      "workflow.playbook_approvals",
    ]) {
      expect(find(t)?.policyClass, t).toBe("standard");
    }
    // Immutable children carry no org cols — isolation is transitive via FK,
    // so they must NOT be in the manifest (a policy on them cannot compile).
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).not.toContain("workflow.playbook_versions");
    expect(tables).not.toContain("workflow.playbook_steps");
    expect(tables).not.toContain("workflow.playbook_edges");
    expect(tables).not.toContain("agent.agent_versions");
  });

  it("marks billing tables org_only and security_events workspace_nullable", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    expect(find("billing.subscriptions")?.policyClass).toBe("org_only");
    expect(find("security.security_events")?.policyClass).toBe(
      "workspace_nullable",
    );
  });

  it("IAM tables live in iam.* schema after the 2026-06-11 rebuild", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    expect(find("iam.principals")?.policyClass).toBe("workspace_nullable");
    expect(find("iam.principal_role_assignments")?.policyClass).toBe(
      "workspace_nullable",
    );
    expect(find("iam.roles")?.policyClass).toBe("org_only");
    expect(find("iam.role_grants")?.policyClass).toBe("org_only");
    expect(find("iam.access_requests")?.policyClass).toBe("org_only");
    // Membership stays in org.*; no stale pre-rewrite org.* IAM entries.
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).toContain("org.org_users");
    expect(tables).toContain("org.invitations");
    expect(tables).not.toContain("org.principals");
    expect(tables).not.toContain("org.roles");
    expect(tables).not.toContain("org.grants");
    expect(tables).not.toContain("org.policies");
  });

  it("drops the pre-rewrite tables the old manifest still referenced", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).not.toContain("agent.workflow_runs");
    expect(tables).not.toContain("agent.workflow_run_tasks");
    expect(tables).not.toContain("agent.mcp_servers"); // moved to mcp.mcp_servers
    expect(tables).not.toContain("workflow.automations");
    expect(tables).not.toContain("workflow.automation_runs");
    expect(tables).not.toContain("auth.privacy_export_requests"); // moved to privacy.*
    expect(tables).not.toContain("auth.privacy_erasure_requests");
    expect(tables).toContain("mcp.mcp_servers");
    expect(tables).toContain("privacy.privacy_export_requests");
    expect(tables).toContain("privacy.privacy_erasure_requests");
  });

  it("content.generated_assets is present as standard", () => {
    const entry = POLICY_MANIFEST.find(
      (e) => e.table === "content.generated_assets",
    );
    expect(entry?.policyClass).toBe("standard");
  });

  it("scopes workspace_users (workspace_id only, no org_id) as workspace_only", () => {
    // It has no org_id, so it cannot use an org-keyed class — but it MUST still
    // be row-scoped on workspace_id, else membership rows leak across tenants.
    const entry = POLICY_MANIFEST.find(
      (e) => e.table === "workspace.workspace_users",
    );
    expect(entry?.policyClass).toBe("workspace_only");
  });

  it("skills tables are the only standard_or_builtin tables — builtin catalog readable, writes tenant-only", () => {
    const builtinReadable = POLICY_MANIFEST.filter(
      (e) => e.policyClass === "standard_or_builtin",
    ).map((e) => e.table);
    expect(builtinReadable).toEqual(["agent.skills", "agent.skill_versions"]);
  });

  it("there are no org_or_global tables (mcp.registries reclassified to standard in 2026-06-17 rebuild)", () => {
    const orgOrGlobal = POLICY_MANIFEST.filter(
      (e) => e.policyClass === "org_or_global",
    ).map((e) => e.table);
    expect(orgOrGlobal).toEqual([]);
  });

  it("excludes tables that carry neither org_id nor a scoping workspace_id", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    // stripe_event_processing has no org_id and no workspace_id (shared catalog)
    expect(tables).not.toContain("billing.stripe_event_processing");
    expect(tables).not.toContain("billing.plans");
    expect(tables).not.toContain("mcp.catalog_servers"); // removed 2026-06-17
    expect(tables).not.toContain("plugin.org_denylist"); // removed 2026-06-17
    expect(tables).not.toContain("ingestion.connector_schemas");
    expect(tables).not.toContain("graph.projection_checkpoints"); // dropped 2026-06-21
    expect(tables).not.toContain("graph.outbox"); // dropped 2026-06-21 (was policied; table removed)
  });

  it("has no duplicate table entries", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    const unique = new Set(tables);
    expect(unique.size).toBe(tables.length);
  });

  it("covers exactly the 89 policied tables of the v0.4.x schema", () => {
    // Intentional ratchet: adding a tenant-owned table means updating BOTH the
    // manifest and this count (and regenerating the Atlas RLS migration).
    // 62 = 63 baseline − plugin.org_denylist (removed 2026-06-17 workspace-scoping rebuild).
    // 65 = 62 + mcp.consents + mcp.tool_snapshots + security.mcp_server_changes
    //      (OXA-816 / OXA-820 external-MCP consent + snapshot tables).
    // 64 = 65 − graph.outbox (dropped 20260622000000_drop_graph_outbox.sql; the
    //      outbox/projection_checkpoints tables were never wired).
    // 66 = 64 + org.org_slug_history + workspace.workspace_slug_history
    //      (OXA-1779 slug-rename redirect history).
    // 73 = 66 + 7 schema_registry.* tables (Workspace Schema Registry, §4 + §11).
    // 71 = the actual base length on 2026-06-26 — the 73 above predated table
    //      changes never reflected here; asserted against the real
    //      POLICY_MANIFEST.length below rather than the drifted figure.
    // 75 = 71 + 4 environments.* (Phase 0 vault): environments, secret_keys,
    //      secret_values, secret_access_log — all `standard` (org_id + workspace_id NN).
    // 76 = 75 + agent.sandbox_sessions (durable code-agent sandbox registry,
    //      orgScopeMixin + tenant_isolation RLS, 20260628120000).
    // 77 = 76 + workspace.workspace_memory_policy (agent-memory decay policy,
    //      org_id + workspace_id both NOT NULL → standard, OXA-1374).
    // 76 = 77 - ingestion.entity_types (dropped as verified-dead zombie table,
    //      20260704210000_drop_zombie_schema).
    // 81 = 76 + ai.response_cache + ai.batch_jobs (semantic cache + batch jobs,
    //      20260704200000) + eval.eval_datasets + eval.eval_dataset_items +
    //      eval.eval_runs (Evals v1, 20260704220000) — all orgScopeMixin → standard.
    // 82 = 81 + agent.a2a_tasks (A2A durable task store, orgScopeMixin →
    //      standard, 20260704230000, PR #572).
    // 83 = 82 + workspace.workspace_budget_policy (per-turn budget governance,
    //      org_id + workspace_id both NOT NULL → standard, OXA-2081,
    //      20260708120000_workspace_budget_policy.sql, PR #630).
    // 85 = 83 + agent.file_locks + agent.file_lock_fences (file-lock lease
    //      authority + fencing-token counter, ADR-021 §5, orgScopeMixin +
    //      forced tenant_isolation RLS, 20260708130000_agent_file_locks.sql —
    //      bumped past the budget-policy prefix collision, PR #647).
    // 88 = 85 + environments.sandbox_templates + environments.sandbox_template_tools
    //      + environments.agent_environment_bindings (portable sandbox templates
    //      + agent-env bindings, org_id NOT NULL + tenant_isolation RLS,
    //      20260712120000_sandbox_templates.sql, PR #718 — the manifest was
    //      updated but this ratchet was not: a parallel-merge semantic conflict).
    // 89 = 88 + auth.workspace_user_preferences (per-(user, workspace) coding-agent
    //      defaults: default repo/environment, org_id + workspace_id both NOT NULL →
    //      standard tenant_isolation RLS, 20260713120000_workspace_user_preferences.sql).
    //      The table + RLS + manifest all shipped; this ratchet and the
    //      manifest-coverage integration test were the missed halves — surfaced once
    //      main CI stopped dying at pnpm install.
    // 95 = 89 + 6 billing.reseller_* tables (reseller revenue,
    //      20260725120000_reseller_revenue.sql — org_id NOT NULL, no
    //      workspace_id → org_only). The migration shipped RLS DDL inline but
    //      the manifest was never updated, so manifest-coverage failed in CI
    //      and a future re-baseline would have silently dropped the policies
    //      (found by the 2026-07-11 Postgres schema audit).
    // 96 = 95 + workspace.routing_policy (Verified-Outcome Market Router
    //      governance, PR #903: org_id NOT NULL + workspace_id NULLABLE →
    //      workspace_nullable tenant_isolation RLS,
    //      20260731130700_routing_policy.sql). Re-added here because the
    //      reseller dedupe pass on this branch dropped it while PR #903 was
    //      merging — without this entry a future re-baseline would silently
    //      drop the table's RLS policy.
    // 92 = 96 − 4 zombie tables dropped in 20260802130000_drop_zombie_tables
    //      (2026-07-11 audit §2: written but never read anywhere):
    //      auth.credentials, billing.usage_records, billing.org_billing_profiles,
    //      billing.invoice_line_items. Lowering the pin for REMOVED tables is
    //      the legitimate direction — the ratchet exists to stop tables gaining
    //      org_id without a policy entry, not to keep dead tables alive.
    // 94 = 92 + agent.agent_runs + agent.agent_run_events (durable-run schema,
    //      agent-engine v2 Phase 2a: orgScopeMixin + forced tenant_isolation
    //      RLS, 20260804100000_agent_runs_durable_schema.sql).
    // 95 = 94 + billing.spend_budgets. The table + its inline
    //      workspace_nullable RLS DDL shipped in
    //      20260806120000_spend_budgets.sql, but the manifest entry was missed
    //      — the same defect class as the reseller tables above, where a future
    //      re-baseline would silently drop the policy. Added here.
    // 109 = 95 + the 14 run/attempt/authorization foundation tables
    //      (docs/specs/run-evidence-ingress, run_attempt_foundation_expand +
    //      agent_run_authorization_foundation migrations):
    //        agent.agent_run_attempts, agent.agent_run_attempt_leases,
    //        agent.agent_run_checkpoints, agent.agent_run_attempt_seals,
    //        agent.agent_run_finalization_grants,
    //        agent.agent_run_finalization_obligations            → standard
    //        ingestion.repository_bindings,
    //        ingestion.repository_binding_heads,
    //        ingestion.governed_repository_selections            → standard
    //        evidence.retention_policy_versions                  → standard
    //        iam.authorization_snapshots                         → standard
    //        iam.authorization_deny_generations, iam.emergency_denies,
    //        iam.authorization_decisions                → workspace_nullable
    expect(POLICY_MANIFEST.length).toBe(109);
  });

  it("covers the run/attempt/authorization foundation (run-evidence-ingress)", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    // Attempt foundation: append-only at the GRANT level, but still row-scoped
    // — append-only privileges stop mutation, not cross-tenant reads.
    for (const t of [
      "agent.agent_run_attempts",
      "agent.agent_run_attempt_leases",
      "agent.agent_run_checkpoints",
      "agent.agent_run_attempt_seals",
      "agent.agent_run_finalization_grants",
      "agent.agent_run_finalization_obligations",
      "ingestion.repository_bindings",
      "ingestion.repository_binding_heads",
      "ingestion.governed_repository_selections",
      "evidence.retention_policy_versions",
      // A run always executes in exactly one workspace, so its pinned ceiling
      // is workspace-scoped rather than org-wide.
      "iam.authorization_snapshots",
    ]) {
      expect(find(t)?.policyClass, t).toBe("standard");
    }
    // Deny state and decisions are legitimately org-wide OR workspace-scoped.
    for (const t of [
      "iam.authorization_deny_generations",
      "iam.emergency_denies",
      "iam.authorization_decisions",
    ]) {
      expect(find(t)?.policyClass, t).toBe("workspace_nullable");
    }
  });

  it("covers billing.spend_budgets as workspace_nullable (org-level ceiling row)", () => {
    // A NULL workspace_id row is the org-wide ceiling visible to every
    // workspace; a non-NULL row is that workspace's own. Must match the
    // predicate 20260806120000_spend_budgets.sql already installed.
    expect(
      POLICY_MANIFEST.find((e) => e.table === "billing.spend_budgets")
        ?.policyClass,
    ).toBe("workspace_nullable");
  });

  it("covers slug-history tables for org + workspace renames (OXA-1779)", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    // org_slug_history has org_id only (no workspace_id) → org_only.
    expect(find("org.org_slug_history")?.policyClass).toBe("org_only");
    // workspace_slug_history has both org_id + workspace_id NN → standard.
    expect(find("workspace.workspace_slug_history")?.policyClass).toBe(
      "standard",
    );
  });

  it("covers workspace.workspace_memory_policy for agent-memory decay (OXA-1374)", () => {
    const entry = POLICY_MANIFEST.find(
      (e) => e.table === "workspace.workspace_memory_policy",
    );
    // Has org_id + workspace_id both NOT NULL → standard.
    expect(entry?.policyClass).toBe("standard");
  });
});
