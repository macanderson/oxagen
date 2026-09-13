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
    ];
    for (const entry of POLICY_MANIFEST) {
      expect(classes).toContain(entry.policyClass);
      expect(entry.table).toMatch(/^[a-z_]+\.[a-z][a-z0-9_]*$/); // schema.table (digits ok after the first char)
    }
  });

  it("includes the known standard owned tables", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).toContain("agent.agents");
    expect(tables).toContain("chat.conversations");
  });

  it("omits immutable children whose isolation is transitive via FK", () => {
    // They carry no org cols — a policy on them cannot compile.
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).not.toContain("agent.agent_versions");
  });

  it("marks billing tables org_only and security_events workspace_nullable", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    expect(find("billing.subscriptions")?.policyClass).toBe("org_only");
    expect(find("security.security_events")?.policyClass).toBe(
      "workspace_nullable",
    );
  });

  it("IAM tables live in the iam.* schema", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    expect(find("iam.principals")?.policyClass).toBe("workspace_nullable");
    expect(find("iam.principal_role_assignments")?.policyClass).toBe(
      "workspace_nullable",
    );
    expect(find("iam.roles")?.policyClass).toBe("org_only");
    expect(find("iam.role_grants")?.policyClass).toBe("org_only");
    expect(find("iam.access_requests")?.policyClass).toBe("org_only");
    // Membership stays in org.*; IAM state does not.
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).toContain("org.org_users");
    expect(tables).toContain("org.invitations");
    expect(tables).not.toContain("org.principals");
    expect(tables).not.toContain("org.roles");
    expect(tables).not.toContain("org.grants");
    expect(tables).not.toContain("org.policies");
  });

  it("excludes tables that no longer exist or moved to another schema", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).not.toContain("agent.workflow_runs");
    expect(tables).not.toContain("agent.workflow_run_tasks");
    expect(tables).not.toContain("agent.mcp_servers"); // moved to mcp.mcp_servers
    expect(tables).not.toContain("workflow.automations");
    expect(tables).not.toContain("workflow.automation_runs");
    // ADR-043 runtime excision: the whole workflow/content/cms/eval domains,
    // plus the agent-runtime tables, are gone from the schema entirely.
    expect(tables).not.toContain("workflow.playbooks");
    expect(tables).not.toContain("content.documents");
    expect(tables).not.toContain("eval.eval_runs");
    expect(tables).not.toContain("agent.skills");
    expect(tables).not.toContain("agent.sandbox_sessions");
    expect(tables).not.toContain("agent.file_locks");
    expect(tables).not.toContain("agent.agent_run_checkpoints");
    expect(tables).not.toContain("agent.agent_run_attempt_leases");
    // The A2A JSON-RPC transport went with the runtime, and its durable task
    // store with it (20260907150000_agent_runs_post_runtime.sql).
    expect(tables).not.toContain("agent.a2a_tasks");
    expect(tables).not.toContain("environments.sandbox_templates");
    expect(tables).not.toContain("ai.batch_jobs");
    expect(tables).not.toContain("ingestion.governed_repository_selections");
    expect(tables).not.toContain("auth.privacy_export_requests"); // moved to privacy.*
    expect(tables).not.toContain("auth.privacy_erasure_requests");
    expect(tables).toContain("mcp.mcp_servers");
    expect(tables).toContain("privacy.privacy_export_requests");
    expect(tables).toContain("privacy.privacy_erasure_requests");
  });

  it("keeps content.generated_assets — the attachment path survived ADR-043", () => {
    // content.documents went with the runtime; the blob reference row backs
    // asset.upload / conversation.attachment.add / conversation.files.list.
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

  it("there are no org_or_global tables", () => {
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
    expect(tables).not.toContain("mcp.catalog_servers");
    expect(tables).not.toContain("plugin.org_denylist");
    expect(tables).not.toContain("ingestion.connector_schemas");
    expect(tables).not.toContain("graph.projection_checkpoints");
    expect(tables).not.toContain("graph.outbox");
  });

  it("has no duplicate table entries", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    const unique = new Set(tables);
    expect(unique.size).toBe(tables.length);
  });

  it("covers exactly the policied tables of the current schema", () => {
    // Intentional ratchet: adding a tenant-owned table means updating BOTH the
    // manifest and this count (and regenerating the Atlas RLS migration), so
    // a table can't gain org_id without a policy entry. Removing a table
    // lowers the pin — that direction is always legitimate.
    //
    // 92 as of billing.governed_action_counters (ADR-052). The preceding note
    // read "97 as of org.model_credentials" while the assertion said 91, so it
    // had already drifted from the number it was describing — a count nobody
    // can check against its own comment is a pin with no ratchet behind it.
    expect(POLICY_MANIFEST.length).toBe(92);
  });

  it("covers billing.governed_action_counters as org_only (ADR-052)", () => {
    // Named as well as counted. The count above catches a table that gains an
    // org_id without a policy; it cannot catch this one being swapped for a
    // different table while the total stays the same, and the governed-action
    // counter is the row a customer's invoice is computed from.
    const entry = POLICY_MANIFEST.find(
      (e) => e.table === "billing.governed_action_counters",
    );
    expect(entry).toBeDefined();
    // org_only rather than standard: the allowance and the volume band are both
    // annual and org-wide, so the table carries no workspace_id to scope by.
    expect(entry?.policyClass).toBe("org_only");
  });

  it("covers the run/attempt/authorization foundation (run-evidence-ingress)", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    // Attempt foundation: append-only at the GRANT level, but still row-scoped
    // — append-only privileges stop mutation, not cross-tenant reads.
    for (const t of [
      "agent.agent_run_attempts",
      "agent.agent_run_attempt_seals",
      "agent.agent_run_finalization_grants",
      "agent.agent_run_finalization_obligations",
      "ingestion.repository_bindings",
      "ingestion.repository_binding_heads",
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

  it("covers slug-history tables for org + workspace renames", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    // org_slug_history has org_id only (no workspace_id) → org_only.
    expect(find("org.org_slug_history")?.policyClass).toBe("org_only");
    // workspace_slug_history has both org_id + workspace_id NN → standard.
    expect(find("workspace.workspace_slug_history")?.policyClass).toBe(
      "standard",
    );
  });

  it("covers workspace.workspace_memory_policy for agent-memory decay", () => {
    const entry = POLICY_MANIFEST.find(
      (e) => e.table === "workspace.workspace_memory_policy",
    );
    // Has org_id + workspace_id both NOT NULL → standard.
    expect(entry?.policyClass).toBe("standard");
  });
});
