import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import * as schema from "./schema";
import { POLICY_MANIFEST, type PolicyClass } from "./tenant-policy.manifest";

/** `schema.table` for a Drizzle table, the way the manifest spells it. */
function qualifiedName(table: Table): string {
  const pgSchema = (table as unknown as Record<symbol, string | undefined>)[
    Symbol.for("drizzle:Schema")
  ];
  return `${pgSchema ?? "public"}.${getTableName(table)}`;
}

/** Every declared table that carries an org or a scoping workspace column. */
function scopedTables(): string[] {
  const out: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value as object, Table)) continue;
    const table = value as unknown as Table;
    const columns = getTableColumns(table);
    if (!("orgId" in columns) && !("workspaceId" in columns)) continue;
    out.push(qualifiedName(table));
  }
  return out.sort();
}

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
    // ADR-043 runtime excision: workflow/eval and the agent-runtime tables
    // are gone. content.documents went with them; cms was restored later as
    // marketing infrastructure (bypass-only RLS, not on this tenant manifest).
    expect(tables).not.toContain("workflow.playbooks");
    expect(tables).not.toContain("content.documents");
    expect(tables).not.toContain("eval.eval_runs");
    expect(tables).not.toContain("cms.leads");
    expect(tables).not.toContain("cms.book_editions");
    expect(tables).not.toContain("cms.book_access_codes");
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

  it("the price book is the one org_or_global table (ADR-060)", () => {
    // cost.price_entries: org_id NULL rows are the platform list prices every
    // tenant reads, an org's negotiated rows are its own. Every other tenant
    // table carries org_id NOT NULL.
    const orgOrGlobal = POLICY_MANIFEST.filter(
      (e) => e.policyClass === "org_or_global",
    ).map((e) => e.table);
    expect(orgOrGlobal).toEqual(["cost.price_entries"]);
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

  it("registers every scoped table the schema declares", () => {
    // Derived from the Drizzle schema rather than from a list somebody keeps.
    // The count below is a ratchet — it makes adding a table deliberate — but
    // a ratchet only notices that the NUMBER moved, so a table can be added
    // and the pin bumped while the manifest entry is forgotten. That is
    // exactly what happened to `tacho.gateway_chains` (#3221): the
    // migration installed standard tenant RLS and the table carried both org
    // columns, and the manifest, which is where that is DECLARED, did not
    // mention it. The manifest is what generated RLS migrations are built
    // from, so the omission is not a reporting error — it is the table
    // dropping out of every future policy migration.
    //
    // `integration/manifest-coverage.test.ts` catches this against a live
    // database. That is the right check and it is also the slow one, gated
    // behind `rls-integration` and behind the migration having been applied.
    // This one needs neither, and the schema already knows the answer.
    //
    // Deliberately allowance-free. Every scoped table in the tree today is
    // registered, so an exclusion list would have no members and would exist
    // only as a place to put the next omission.
    const listed = new Set(POLICY_MANIFEST.map((entry) => entry.table));
    expect(scopedTables().filter((name) => !listed.has(name))).toEqual([]);
  });

  it("registers nothing the schema does not declare", () => {
    // The other direction. A manifest entry for a table that no longer exists
    // generates a policy for nothing and reads as coverage it does not have.
    const declared = new Set(scopedTables());
    expect(
      POLICY_MANIFEST.map((entry) => entry.table).filter(
        (name) => !declared.has(name),
      ),
    ).toEqual([]);
  });

  it("covers exactly the policied tables of the current schema", () => {
    // Intentional ratchet: adding a tenant-owned table means updating BOTH the
    // manifest and this count (and regenerating the Atlas RLS migration), so
    // a table can't gain org_id without a policy entry. Removing a table
    // lowers the pin — that direction is always legitimate.
    //
    // 116: `skills.config_versions` and `skills.resolutions` are this
    // branch's versioned skill-resolution config and the per-run record of
    // which version answered. Both carry org_id and workspace_id and are
    // read and written through withTenantDb, so both are `standard`.
    //
    // 114: billing.usage_outbox retains scoped usage delivery state.
    //
    // Was 113 as of `org.assistant_model_keys` (ADR-131), the OpenRouter key
    // Oxagen mints for one organisation at signup. One row per
    // organisation, carrying the enveloped key and the vendor's key hash,
    // with org_id and no workspace_id, so org_only. It is read and written
    // through withTenantDb and nothing resolves through it, which makes
    // RLS the filter here, exactly as for org.model_credentials beside it.
    //
    // Was 112 as of both sides of that merge adding a table.
    // `tacho.gateway_chains` (#3221) is the control plane's record of each
    // authorised local-MCP-gateway call and the daemon chain it was serving;
    // it landed unregistered on its first push, because the migration
    // installs standard tenant RLS and the table carries both org columns
    // while the manifest is where that is DECLARED — so it read as unscoped
    // and would have failed `rls-integration` once the migration applied, and
    // been left out of every generated RLS migration after.
    //
    // `billing.gau_reversals` (ADR-085) is the record of a refunded or disputed
    // GAU block purchase.
    //
    // Was 110 as of mcp.credential_grants (ADR-072, #2958), which landed on
    // the 109 this branch merged. Those 109 were evidence.witnesses,
    // evidence.verdicts and evidence.disclosure_policies (ADR-064, #2955)
    // alongside tools.mandates and tools.mandate_ledger (ADR-059, G2957), both
    // landing on the 104 that counted org.onboarding_state and
    // tacho.enrollment_tokens (#2967, ADR-065). So the six tables added since
    // 104 are, in order: tools.mandates, tools.mandate_ledger,
    // evidence.witnesses, evidence.verdicts, evidence.disclosure_policies and
    // mcp.credential_grants. Was 102 as of cost.findings (ADR-062, G2963). Was
    // 101 as of
    // agent.context_proposals and agent.context_appends (ADR-061, #2961).
    // Was 99 as of evidence.run_exports (ADR-058, #2952).
    // Was 98 as of billing.spend_counters, cost.price_entries, cost.run_totals
    // and cost.daily_totals (ADR-060, G2962) over WL-27's 94, which dropped
    // billing.governed_action_counters with the annual meter it counted. Was
    // 95 as of billing.contract_terms, billing.gau_buckets and
    // billing.gau_settlements (ADR-055, WL-24), and 92 before those. An
    // earlier note read "97 as of org.model_credentials" while the assertion
    // said 91, so it had already drifted from the number it was describing — a
    // count nobody can check against its own comment is a pin with no ratchet
    // behind it.
    // 117 as of workspace.tacho_session_policy, the workspace's wrapped-harness
    // session policy. The gateway does not read it yet; the table is in the
    // manifest because it carries org_id, not because anything enforces it.
    // 119 includes cost.cost_centers (ADR-142) and org.sso_group_roles
    // (ADR-145), which both arrived after the session policy table.
    expect(POLICY_MANIFEST.length).toBe(119);
  });

  it("covers the ADR-055 GAU tables as org_only (WL-24)", () => {
    // Named as well as counted, for the same reason as the governed-action
    // counter below: the contract terms, the month bucket and the settlement
    // ledger are the rows a customer's GAU invoice is computed from. All three
    // carry org_id NOT NULL and no workspace_id.
    for (const t of [
      "billing.contract_terms",
      "billing.gau_buckets",
      "billing.gau_settlements",
    ]) {
      const entry = POLICY_MANIFEST.find((e) => e.table === t);
      expect(entry, t).toBeDefined();
      expect(entry?.policyClass, t).toBe("org_only");
    }
  });

  it("no longer carries billing.governed_action_counters (WL-27)", () => {
    // The annual counter and its table were dropped with the dollar-denominated
    // meter they served; billing.gau_buckets is the row a customer's GAU
    // invoice is computed from now. A policy entry for a table that no longer
    // exists makes the generated RLS migration name a missing relation.
    expect(
      POLICY_MANIFEST.some(
        (e) => e.table === "billing.governed_action_counters",
      ),
    ).toBe(false);
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
