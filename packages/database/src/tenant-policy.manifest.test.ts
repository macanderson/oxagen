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
      expect(entry.table).toMatch(/^[a-z_]+\.[a-z_]+$/); // schema.table
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
    expect(find("security.security_events")?.policyClass).toBe("workspace_nullable");
  });

  it("IAM tables live in iam.* schema after the 2026-06-11 rebuild", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    expect(find("iam.principals")?.policyClass).toBe("workspace_nullable");
    expect(find("iam.principal_role_assignments")?.policyClass).toBe("workspace_nullable");
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
    const entry = POLICY_MANIFEST.find((e) => e.table === "content.generated_assets");
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

  it("covers exactly the 66 policied tables of the v0.4.x schema", () => {
    // Intentional ratchet: adding a tenant-owned table means updating BOTH the
    // manifest and this count (and regenerating the Atlas RLS migration).
    // 62 = 63 baseline − plugin.org_denylist (removed 2026-06-17 workspace-scoping rebuild).
    // 65 = 62 + mcp.consents + mcp.tool_snapshots + security.mcp_server_changes
    //      (OXA-816 / OXA-820 external-MCP consent + snapshot tables).
    // 64 = 65 − graph.outbox (dropped 20260621120000_drop_graph_outbox.sql; the
    //      outbox/projection_checkpoints tables were never wired).
    // 66 = 64 + org.org_slug_history + workspace.workspace_slug_history
    //      (OXA-1779 slug-rename redirect history).
    expect(POLICY_MANIFEST.length).toBe(66);
  });

  it("covers slug-history tables for org + workspace renames (OXA-1779)", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    // org_slug_history has org_id only (no workspace_id) → org_only.
    expect(find("org.org_slug_history")?.policyClass).toBe("org_only");
    // workspace_slug_history has both org_id + workspace_id NN → standard.
    expect(find("workspace.workspace_slug_history")?.policyClass).toBe("standard");
  });
});
