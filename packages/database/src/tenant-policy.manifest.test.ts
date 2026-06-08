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
      expect(entry.table).toMatch(/^[a-z_]+\.[a-z_]+$/); // schema.table
    }
  });

  it("includes the known standard owned tables", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).toContain("agent.agents");
    expect(tables).toContain("chat.conversations");
  });

  it("marks billing tables org_only and security_events workspace_nullable", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    expect(find("billing.subscriptions")?.policyClass).toBe("org_only");
    expect(find("security.security_events")?.policyClass).toBe("workspace_nullable");
  });

  it("IAM tables live in org.* schema (not iam.*)", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    // Verify correct schema assignment
    expect(tables).toContain("org.principals");
    expect(tables).toContain("org.roles");
    expect(tables).toContain("org.role_grants");
    expect(tables).toContain("org.grants");
    expect(tables).toContain("org.policies");
    expect(tables).toContain("org.access_requests");
    expect(tables).toContain("org.principal_role_assignments");
    // No iam.* entries should exist
    expect(tables.every((t) => !t.startsWith("iam."))).toBe(true);
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

  it("excludes tables that carry neither org_id nor a scoping workspace_id", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    // stripe_event_processing has no org_id and no workspace_id (shared catalog)
    expect(tables).not.toContain("billing.stripe_event_processing");
  });

  it("has no duplicate table entries", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    const unique = new Set(tables);
    expect(unique.size).toBe(tables.length);
  });
});
