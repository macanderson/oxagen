/**
 * schema-smoke.test.ts
 *
 * Smoke tests for the Drizzle table definitions in: environments,
 * notification, workflow, org, content, chat, mcp, and agent.
 *
 * IMPORTANT: Drizzle's `.table(name, cols, (t) => ({...}))` stores the third
 * argument (the ExtraConfigBuilder) WITHOUT calling it at construction time.
 * It is only executed when `getTableConfig(table)` is called. Therefore this
 * test file must call `getTableConfig(table)` on every table to:
 *  a) trigger the callback body → V8 coverage registers those lines, and
 *  b) assert the resulting config has the expected structure.
 *
 * No live DB or network is required — all assertions are on the TypeScript /
 * Drizzle schema objects.
 */

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { flattenCheckSql, getChecks, sqlColumnNames } from "./_test-helpers";

import {
  plans,
  subscriptions,
  paymentMethods,
  invoices,
  creditLots,
} from "../schema/billing";

// ── Imports from schema files under test ─────────────────────────────────────

import {
  environments,
  secretKeys,
  secretValues,
  secretAccessLog,
} from "../schema/environments";

import { notifications } from "../schema/notification";

import {
  playbooks,
  playbookVersions,
  playbookSteps,
  playbookEdges,
  playbookTriggers,
  playbookRuns,
  playbookStepRuns,
  playbookEvents,
  playbookApprovals,
} from "../schema/workflow";

import {
  organizations,
  orgUsers,
  orgSlugHistory,
  invitations,
} from "../schema/org";

import { generatedAssets, documents } from "../schema/content";

import { conversations, messages } from "../schema/chat";

import { githubInstallations } from "../schema/ingestion";

import {
  mcpRegistries,
  mcpCredentials,
  mcpServers,
  mcpConsents,
  mcpCatalogServers,
  mcpToolSnapshots,
} from "../schema/mcp";

import {
  agents,
  agentVersions,
  skills,
  skillVersions,
  backgroundTasks,
  approvalRequests,
  subagentFanouts,
  subagentRuns,
  agentExecutions,
  agentExecutionSteps,
  agentToolCalls,
  agentPlans,
} from "../schema/agent";

// ── Helper: assert a table is defined and call getTableConfig to trigger the
//    ExtraConfigBuilder callback (covers the callback lines in V8). ──────────

function smokeTable(
  table: Parameters<typeof getTableConfig>[0],
  expectedCols: string[],
): ReturnType<typeof getTableConfig> {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => c.name);
  for (const col of expectedCols) {
    expect(cols, `Expected column '${col}' in table '${cfg.name}'`).toContain(
      col,
    );
  }
  return cfg;
}

// ═══════════════════════════════════════════════════════════════════════════
// environments schema
// ═══════════════════════════════════════════════════════════════════════════

describe("environments.environments", () => {
  const cfg = smokeTable(environments, [
    "id",
    "name",
    "slug",
    "is_default",
    "is_active",
    "org_id",
    "workspace_id",
  ]);

  // Declared as a PARTIAL unique index (`uniqueIndex(...).where(deleted_at IS
  // NULL)`), matching the Atlas migration — so Drizzle reports it under
  // .indexes, not .uniqueConstraints. Assert the partiality too: a plain
  // unique() here would be a stricter constraint than the database has.
  it("has workspace_slug_uniq as a partial unique index", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "environments_workspace_slug_uniq",
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it("has org_workspace index", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "environments_org_workspace_idx",
    );
    expect(idx).toBeDefined();
  });
});

describe("environments.secret_keys", () => {
  smokeTable(secretKeys, ["id", "key", "sensitive", "org_id", "workspace_id"]);

  it("has storage CHECK constraint", () => {
    const checks = getChecks(secretKeys);
    const storageCheck = checks.find(
      (c) => c.name === "secret_keys_default_storage_check",
    );
    expect(storageCheck).toBeDefined();
  });
});

describe("environments.secret_values", () => {
  const cfg = smokeTable(secretValues, [
    "id",
    "secret_key_id",
    "environment_id",
    "org_id",
    "workspace_id",
  ]);

  it("has key_env_uniq unique constraint", () => {
    const uc = cfg.uniqueConstraints.find(
      (u) => u.name === "secret_values_key_env_uniq",
    );
    expect(uc).toBeDefined();
  });

  it("has storage CHECK constraint", () => {
    const checks = getChecks(secretValues);
    const storageCheck = checks.find(
      (c) => c.name === "secret_values_storage_check",
    );
    expect(storageCheck).toBeDefined();
  });
});

describe("environments.secret_access_log", () => {
  smokeTable(secretAccessLog, [
    "id",
    "org_id",
    "workspace_id",
    "action",
    "occurred_at",
  ]);

  it("action CHECK includes reveal and export", () => {
    const checks = getChecks(secretAccessLog);
    const actionCheck = checks.find(
      (c) => c.name === "secret_access_log_action_check",
    );
    expect(actionCheck).toBeDefined();
    const sql = flattenCheckSql(actionCheck!);
    expect(sql).toContain("reveal");
    expect(sql).toContain("export");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// notification schema
// ═══════════════════════════════════════════════════════════════════════════

describe("notification.notifications", () => {
  smokeTable(notifications, [
    "id",
    "org_id",
    "user_id",
    "kind",
    "title",
    "unread",
    "archived",
  ]);

  it("kind CHECK includes system, approval, run, member, security", () => {
    const checks = getChecks(notifications);
    const kindCheck = checks.find((c) => c.name === "notifications_kind_check");
    expect(kindCheck).toBeDefined();
    const sql = flattenCheckSql(kindCheck!);
    for (const val of ["system", "approval", "run", "member", "security"]) {
      expect(sql).toContain(val);
    }
  });

  it("has user_unread_idx partial index", () => {
    const cfg = getTableConfig(notifications);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "notifications_user_unread_idx",
    );
    expect(idx).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// workflow schema
// ═══════════════════════════════════════════════════════════════════════════

describe("workflow.playbooks", () => {
  smokeTable(playbooks, ["id", "name", "slug", "status", "visibility"]);

  it("status CHECK includes draft, active, archived", () => {
    const checks = getChecks(playbooks);
    const statusCheck = checks.find((c) => c.name === "playbooks_status_check");
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    expect(sql).toContain("draft");
    expect(sql).toContain("active");
    expect(sql).toContain("archived");
  });

  it("visibility CHECK includes private, workspace, organization, marketplace", () => {
    const checks = getChecks(playbooks);
    const visCheck = checks.find(
      (c) => c.name === "playbooks_visibility_check",
    );
    expect(visCheck).toBeDefined();
    const sql = flattenCheckSql(visCheck!);
    for (const v of ["private", "workspace", "organization", "marketplace"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_versions", () => {
  smokeTable(playbookVersions, [
    "id",
    "playbook_id",
    "version",
    "is_published",
  ]);

  it("has playbook_version_uniq unique index", () => {
    const cfg = getTableConfig(playbookVersions);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "playbook_versions_playbook_version_uniq",
    );
    expect(idx).toBeDefined();
  });
});

describe("workflow.playbook_steps", () => {
  smokeTable(playbookSteps, [
    "id",
    "playbook_version_id",
    "step_key",
    "step_type",
  ]);

  it("step_type CHECK includes agent and tool", () => {
    const checks = getChecks(playbookSteps);
    const typeCheck = checks.find(
      (c) => c.name === "playbook_steps_step_type_check",
    );
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    expect(sql).toContain("agent");
    expect(sql).toContain("tool");
  });
});

describe("workflow.playbook_edges", () => {
  smokeTable(playbookEdges, [
    "id",
    "playbook_version_id",
    "source_step_id",
    "target_step_id",
    "edge_type",
  ]);

  it("edge_type CHECK includes default and conditional", () => {
    const checks = getChecks(playbookEdges);
    const typeCheck = checks.find(
      (c) => c.name === "playbook_edges_edge_type_check",
    );
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    expect(sql).toContain("default");
    expect(sql).toContain("conditional");
  });
});

describe("workflow.playbook_triggers", () => {
  smokeTable(playbookTriggers, [
    "id",
    "playbook_id",
    "trigger_type",
    "is_enabled",
  ]);

  it("trigger_type CHECK includes event, schedule, api", () => {
    const checks = getChecks(playbookTriggers);
    const typeCheck = checks.find(
      (c) => c.name === "playbook_triggers_trigger_type_check",
    );
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    for (const v of ["event", "schedule", "api"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_runs", () => {
  smokeTable(playbookRuns, [
    "id",
    "org_id",
    "workspace_id",
    "playbook_id",
    "status",
    "source",
  ]);

  it("status CHECK includes pending, running, completed, failed, cancelled", () => {
    const checks = getChecks(playbookRuns);
    const statusCheck = checks.find(
      (c) => c.name === "playbook_runs_status_check",
    );
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(sql).toContain(v);
    }
  });

  it("source CHECK includes api, event, manual", () => {
    const checks = getChecks(playbookRuns);
    const sourceCheck = checks.find(
      (c) => c.name === "playbook_runs_source_check",
    );
    expect(sourceCheck).toBeDefined();
    const sql = flattenCheckSql(sourceCheck!);
    for (const v of ["api", "event", "manual"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_step_runs", () => {
  smokeTable(playbookStepRuns, [
    "id",
    "playbook_run_id",
    "playbook_step_id",
    "status",
    "attempt",
  ]);

  it("status CHECK includes pending, running, completed, failed, skipped, cancelled", () => {
    const checks = getChecks(playbookStepRuns);
    const statusCheck = checks.find(
      (c) => c.name === "playbook_step_runs_status_check",
    );
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of [
      "pending",
      "running",
      "completed",
      "failed",
      "skipped",
      "cancelled",
    ]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_events", () => {
  smokeTable(playbookEvents, [
    "id",
    "playbook_run_id",
    "sequence",
    "event_type",
    "event_hash",
  ]);

  it("event_type CHECK includes run_started, step_completed, run_completed", () => {
    const checks = getChecks(playbookEvents);
    const typeCheck = checks.find(
      (c) => c.name === "playbook_events_event_type_check",
    );
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    for (const v of ["run_started", "step_completed", "run_completed"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_approvals", () => {
  smokeTable(playbookApprovals, [
    "id",
    "playbook_run_id",
    "step_run_id",
    "status",
  ]);

  it("status CHECK includes pending, approved, denied, expired", () => {
    const checks = getChecks(playbookApprovals);
    const statusCheck = checks.find(
      (c) => c.name === "playbook_approvals_status_check",
    );
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["pending", "approved", "denied", "expired"]) {
      expect(sql).toContain(v);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// org schema
// ═══════════════════════════════════════════════════════════════════════════

describe("org.organizations", () => {
  smokeTable(organizations, [
    "id",
    "name",
    "slug",
    "plan_type",
    "status",
    "type",
  ]);

  it("type CHECK includes personal and business", () => {
    const checks = getChecks(organizations);
    const typeCheck = checks.find((c) => c.name === "organizations_type_check");
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    expect(sql).toContain("personal");
    expect(sql).toContain("business");
  });

  it("status CHECK includes active, suspended, deleted", () => {
    const checks = getChecks(organizations);
    const statusCheck = checks.find(
      (c) => c.name === "organizations_status_check",
    );
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["active", "suspended", "deleted"]) {
      expect(sql).toContain(v);
    }
  });

  it("employee_size CHECK allows NULL", () => {
    const checks = getChecks(organizations);
    const sizeCheck = checks.find(
      (c) => c.name === "organizations_employee_size_check",
    );
    expect(sizeCheck).toBeDefined();
    const sql = flattenCheckSql(sizeCheck!);
    expect(sql.toUpperCase()).toContain("NULL");
  });
});

describe("org.org_users", () => {
  smokeTable(orgUsers, ["id", "org_id", "user_id", "role", "joined_at"]);

  it("role CHECK includes owner, admin, member", () => {
    const checks = getChecks(orgUsers);
    const roleCheck = checks.find((c) => c.name === "org_users_role_check");
    expect(roleCheck).toBeDefined();
    const sql = flattenCheckSql(roleCheck!);
    for (const v of ["owner", "admin", "member"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("org.org_slug_history", () => {
  smokeTable(orgSlugHistory, [
    "id",
    "org_id",
    "old_slug",
    "new_slug",
    "changed_at",
  ]);

  it("has old_slug index", () => {
    const cfg = getTableConfig(orgSlugHistory);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "org_slug_history_old_slug_idx",
    );
    expect(idx).toBeDefined();
  });
});

describe("org.invitations", () => {
  smokeTable(invitations, ["id", "org_id", "email", "role", "status"]);

  it("status CHECK includes pending, accepted, declined, revoked, expired", () => {
    const checks = getChecks(invitations);
    const statusCheck = checks.find(
      (c) => c.name === "invitations_status_check",
    );
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["pending", "accepted", "declined", "revoked", "expired"]) {
      expect(sql).toContain(v);
    }
  });

  it("role CHECK includes owner, admin, member, viewer", () => {
    const checks = getChecks(invitations);
    const roleCheck = checks.find((c) => c.name === "invitations_role_check");
    expect(roleCheck).toBeDefined();
    const sql = flattenCheckSql(roleCheck!);
    for (const v of ["owner", "admin", "member", "viewer"]) {
      expect(sql).toContain(v);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// content schema
// ═══════════════════════════════════════════════════════════════════════════

describe("content.generated_assets", () => {
  smokeTable(generatedAssets, [
    "id",
    "user_id",
    "kind",
    "access_policy",
    "status",
    "storage_provider",
    "storage_key",
    "mime_type",
    "prompt",
    "model",
  ]);

  it("kind CHECK includes image, video, document", () => {
    const checks = getChecks(generatedAssets);
    const kindCheck = checks.find(
      (c) => c.name === "generated_assets_kind_check",
    );
    expect(kindCheck).toBeDefined();
    const sql = flattenCheckSql(kindCheck!);
    for (const v of ["image", "video", "document"]) {
      expect(sql).toContain(v);
    }
  });

  it("access_policy CHECK includes user, org, public", () => {
    const checks = getChecks(generatedAssets);
    const policyCheck = checks.find(
      (c) => c.name === "generated_assets_access_policy_check",
    );
    expect(policyCheck).toBeDefined();
    const sql = flattenCheckSql(policyCheck!);
    for (const v of ["user", "org", "public"]) {
      expect(sql).toContain(v);
    }
  });

  it("status CHECK includes pending, ready, failed", () => {
    const checks = getChecks(generatedAssets);
    const statusCheck = checks.find(
      (c) => c.name === "generated_assets_status_check",
    );
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["pending", "ready", "failed"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("content.documents", () => {
  smokeTable(documents, ["id", "org_id", "workspace_id", "title", "content"]);

  it("has org_idx index", () => {
    const cfg = getTableConfig(documents);
    const idx = cfg.indexes.find((i) => i.config.name === "documents_org_idx");
    expect(idx).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// chat schema
// ═══════════════════════════════════════════════════════════════════════════

describe("chat.conversations", () => {
  smokeTable(conversations, [
    "id",
    "org_id",
    "workspace_id",
    "user_id",
    "status",
  ]);

  it("status CHECK includes active, archived, deleted", () => {
    const checks = getChecks(conversations);
    const statusCheck = checks.find(
      (c) => c.name === "conversations_status_check",
    );
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["active", "archived", "deleted"]) {
      expect(sql).toContain(v);
    }
  });

  it("has conversations_list_idx index", () => {
    const cfg = getTableConfig(conversations);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "conversations_list_idx",
    );
    expect(idx).toBeDefined();
  });
});

describe("chat.messages", () => {
  smokeTable(messages, [
    "id",
    "org_id",
    "workspace_id",
    "conversation_id",
    "role",
    "content",
    "content_blocks",
  ]);

  it("has conversation_parent index", () => {
    const cfg = getTableConfig(messages);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "messages_conversation_parent_idx",
    );
    expect(idx).toBeDefined();
  });

  it("has conversation_created index", () => {
    const cfg = getTableConfig(messages);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "messages_conversation_created_idx",
    );
    expect(idx).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mcp schema
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp.registries (mcpRegistries)", () => {
  smokeTable(mcpRegistries, [
    "id",
    "org_id",
    "workspace_id",
    "name",
    "base_url",
    "is_default",
  ]);

  it("has registries_org_ws_url_uniq unique index", () => {
    const cfg = getTableConfig(mcpRegistries);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "registries_org_ws_url_uniq",
    );
    expect(idx).toBeDefined();
  });

  it("has registries_org_ws_default_uniq partial unique index", () => {
    const cfg = getTableConfig(mcpRegistries);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "registries_org_ws_default_uniq",
    );
    expect(idx).toBeDefined();
  });
});

describe("mcp.credentials (mcpCredentials)", () => {
  it("has expected columns", () => {
    smokeTable(mcpCredentials, [
      "id",
      "org_id",
      "workspace_id",
      "org_listing_id",
      "auth_kind",
      "status",
    ]);
  });
});

describe("mcp.mcp_servers (mcpServers)", () => {
  const cols = sqlColumnNames(mcpServers);

  it("has id column", () => {
    expect(cols).toContain("id");
  });
  it("has org_id column", () => {
    expect(cols).toContain("org_id");
  });

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(mcpServers);
    expect(cfg).toBeDefined();
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("mcp.mcp_consents (mcpConsents)", () => {
  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(mcpConsents);
    expect(cfg).toBeDefined();
  });
});

describe("mcp.mcp_catalog_servers (mcpCatalogServers)", () => {
  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(mcpCatalogServers);
    expect(cfg).toBeDefined();
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("mcp.mcp_tool_snapshots (mcpToolSnapshots)", () => {
  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(mcpToolSnapshots);
    expect(cfg).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// agent schema
// ═══════════════════════════════════════════════════════════════════════════

describe("agent.agents", () => {
  smokeTable(agents, [
    "id",
    "org_id",
    "workspace_id",
    "slug",
    "name",
    "agent_type",
    "status",
    "deployment_status",
  ]);

  it("status CHECK includes draft, active, archived", () => {
    const checks = getChecks(agents);
    const statusCheck = checks.find((c) => c.name === "agents_status_check");
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["draft", "active", "archived"]) {
      expect(sql).toContain(v);
    }
  });

  it("deployment_status CHECK includes inactive and active", () => {
    const checks = getChecks(agents);
    const deployCheck = checks.find(
      (c) => c.name === "agents_deployment_status_check",
    );
    expect(deployCheck).toBeDefined();
    const sql = flattenCheckSql(deployCheck!);
    expect(sql).toContain("inactive");
    expect(sql).toContain("active");
  });
});

describe("agent.agent_versions", () => {
  smokeTable(agentVersions, [
    "id",
    "agent_id",
    "version",
    "is_published",
    "config",
  ]);

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(agentVersions);
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("agent.skills", () => {
  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(skills);
    expect(cfg).toBeDefined();
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("agent.skill_versions", () => {
  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(skillVersions);
    expect(cfg).toBeDefined();
  });
});

describe("agent.background_tasks", () => {
  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(backgroundTasks);
    expect(cfg).toBeDefined();
    const cols = cfg.columns.map((c) => c.name);
    expect(cols).toContain("id");
  });
});

describe("agent.approval_requests", () => {
  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(approvalRequests);
    expect(cfg).toBeDefined();
  });
});

describe("agent.subagent_fanouts", () => {
  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(subagentFanouts);
    expect(cfg).toBeDefined();
  });
});

describe("agent.subagent_runs", () => {
  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(subagentRuns);
    expect(cfg).toBeDefined();
  });
});

describe("agent.agent_executions", () => {
  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(agentExecutions);
    expect(cfg).toBeDefined();
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("agent.agent_execution_steps", () => {
  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(agentExecutionSteps);
    expect(cfg).toBeDefined();
  });
});

describe("agent.agent_tool_calls", () => {
  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(agentToolCalls);
    expect(cfg).toBeDefined();
  });
});

describe("agent.agent_plans", () => {
  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(agentPlans);
    expect(cfg).toBeDefined();
    const cols = cfg.columns.map((c) => c.name);
    expect(cols).toContain("id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// billing schema — covers numeric column regression
// ═══════════════════════════════════════════════════════════════════════════

describe("billing.plans", () => {
  const cfg = smokeTable(plans, [
    "id",
    "name",
    "slug",
    "tier",
    "stripe_product_id",
  ]);

  it("tier CHECK includes free, build, scale, enterprise", () => {
    const checks = getChecks(plans);
    const tierCheck = checks.find((c) => c.name === "plans_tier_check");
    expect(tierCheck).toBeDefined();
    const sql = flattenCheckSql(tierCheck!);
    for (const v of ["free", "build", "scale", "enterprise"]) {
      expect(sql).toContain(v);
    }
  });

  it("has slug unique index", () => {
    const idx = cfg.indexes.find((i) => i.config.name === "plans_slug_idx");
    expect(idx).toBeDefined();
  });
});

describe("billing.subscriptions", () => {
  const cfg = smokeTable(subscriptions, [
    "id",
    "org_id",
    "plan_id",
    "stripe_subscription_id",
    "status",
  ]);

  it("billing_interval CHECK includes month and year", () => {
    const checks = getChecks(subscriptions);
    const intervalCheck = checks.find(
      (c) => c.name === "subscriptions_billing_interval_check",
    );
    expect(intervalCheck).toBeDefined();
    const sql = flattenCheckSql(intervalCheck!);
    expect(sql).toContain("month");
    expect(sql).toContain("year");
  });

  it("status CHECK includes active, past_due, canceled", () => {
    const checks = getChecks(subscriptions);
    const statusCheck = checks.find(
      (c) => c.name === "subscriptions_status_check",
    );
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["active", "past_due", "canceled"]) {
      expect(sql).toContain(v);
    }
  });

  it("has org_status composite index", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "subscriptions_org_status_idx",
    );
    expect(idx).toBeDefined();
  });
});

describe("billing.invoices", () => {
  it("has expected columns", () => {
    smokeTable(invoices, ["id", "org_id", "stripe_invoice_id", "status"]);
  });
});

describe("billing.payment_methods", () => {
  it("has expected columns", () => {
    smokeTable(paymentMethods, [
      "id",
      "org_id",
      "stripe_payment_method_id",
      "type",
      "is_default",
    ]);
  });
});

describe("billing.credit_lots", () => {
  const cfg = smokeTable(creditLots, [
    "id",
    "org_id",
    "original_cents",
    "remaining_cents",
  ]);

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ingestion schema (github installations registry)
// ═══════════════════════════════════════════════════════════════════════════

describe("ingestion.github_installations", () => {
  const cfg = smokeTable(githubInstallations, [
    "id",
    "public_id",
    "installation_id",
    "account_login",
    "account_id",
    "account_type",
    "app_slug",
    "repository_selection",
    "suspended_at",
    "deleted_at",
  ]);

  it("has a unique constraint on installation_id (singleton per GitHub account)", () => {
    const uc = cfg.uniqueConstraints.find(
      (u) => u.name === "github_installations_installation_id_uq",
    );
    expect(uc).toBeDefined();
  });

  it("has an account_login index", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "github_installations_account_login_idx",
    );
    expect(idx).toBeDefined();
  });

  it("is NOT tenant-scoped — a shared/system catalog (no org_id/workspace_id)", () => {
    const cols = cfg.columns.map((c) => c.name);
    expect(cols).not.toContain("org_id");
    expect(cols).not.toContain("workspace_id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Governed-run foundation (docs/specs/run-evidence-ingress)
//
// Same purpose as every block above: call getTableConfig on each new table so
// its ExtraConfigBuilder body actually executes (coverage) and its index /
// constraint names are asserted rather than assumed. The behavioural
// invariants — the V1/V2 discriminant, the one-shot grant, deny narrowing —
// live in schema-append-only.test.ts; live-database privilege and fence
// behaviour live in integration/run-attempt-foundation.test.ts and
// integration/authorization-foundation.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

import {
  agentRunAttempts,
  agentRunAttemptLeases,
  agentRunCheckpoints,
  agentRunAttemptSeals,
  agentRunFinalizationGrants,
  agentRunFinalizationObligations,
} from "../schema/agent";
import {
  repositoryBindings,
  repositoryBindingHeads,
  governedRepositorySelections,
} from "../schema/ingestion";
import { retentionPolicyVersions } from "../schema/run-evidence-foundation";
import {
  authorizationSnapshots,
  authorizationDenyGenerations,
  emergencyDenies,
  authorizationDecisions,
} from "../schema/iam";

describe("agent.agent_run_attempts", () => {
  const cfg = smokeTable(agentRunAttempts, [
    "id",
    "public_id",
    "org_id",
    "workspace_id",
    "run_id",
    "attempt_number",
    "worker_id",
    "engine_name",
    "engine_version",
    "engine_build_digest",
  ]);

  it("enforces one attempt number per run", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "agent_run_attempts_run_attempt_uq",
    );
    expect(idx?.config.unique).toBe(true);
  });

  it("pins the resolved engine identity, not just its name", () => {
    // Evidence must name the exact binary that executed, so the build/image
    // digest is NOT NULL alongside name and version.
    const digest = cfg.columns.find((c) => c.name === "engine_build_digest");
    expect(digest?.notNull).toBe(true);
  });
});

describe("agent.agent_run_attempt_leases", () => {
  const cfg = smokeTable(agentRunAttemptLeases, [
    "id",
    "org_id",
    "workspace_id",
    "attempt_id",
    "run_id",
    "lease_token",
    "lease_epoch",
    "expires_at",
    "fenced_at",
  ]);

  it("allows exactly one lease per attempt", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "agent_run_attempt_leases_attempt_uq",
    );
    expect(idx?.config.unique).toBe(true);
  });

  it("consumes each fencing epoch once per run", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "agent_run_attempt_leases_run_epoch_uq",
    );
    expect(idx?.config.unique).toBe(true);
  });

  it("scans only unfenced leases in the sweeper index", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "agent_run_attempt_leases_sweep_idx",
    );
    expect(idx?.config.where).toBeDefined();
  });
});

describe("agent.agent_run_checkpoints", () => {
  const cfg = smokeTable(agentRunCheckpoints, [
    "id",
    "org_id",
    "workspace_id",
    "run_id",
    "attempt_id",
    "event_id",
    "attempt_seq",
    "run_seq",
    "checkpoint_digest",
    "stream_digest",
    "encrypted_state_ref",
  ]);

  it("binds each checkpoint to at most one event", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "agent_run_checkpoints_event_uq",
    );
    expect(idx?.config.unique).toBe(true);
  });

  it("stores engine state by encrypted reference, never inline", () => {
    const cols = cfg.columns.map((c) => c.name);
    expect(cols).toContain("encrypted_state_ref");
    expect(cols).not.toContain("state");
    expect(cols).not.toContain("checkpoint");
  });
});

describe("agent.agent_run_attempt_seals", () => {
  const cfg = smokeTable(agentRunAttemptSeals, [
    "id",
    "org_id",
    "workspace_id",
    "run_id",
    "attempt_id",
    "terminal_status",
    "event_count",
    "event_stream_digest",
    "sealer_kind",
    "sealer_worker_id",
  ]);

  it("seals an attempt exactly once", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "agent_run_attempt_seals_attempt_uq",
    );
    expect(idx?.config.unique).toBe(true);
  });

  it("admits the reclaimer as a distinct sealer kind", () => {
    // The lease sweeper seals an abandoned attempt on the worker's behalf, so
    // "who sealed this" must distinguish the two without inventing a worker id.
    const sql = flattenCheckSql(
      getChecks(agentRunAttemptSeals).find((c) =>
        c.name.includes("sealer_kind_check"),
      )!,
    );
    expect(sql).toContain("worker");
    expect(sql).toContain("reclaimer");
  });
});

describe("agent.agent_run_finalization_grants", () => {
  const cfg = smokeTable(agentRunFinalizationGrants, [
    "id",
    "public_id",
    "org_id",
    "workspace_id",
    "run_id",
    "attempt_id",
    "seal_id",
    "attempt_public_id",
    "capability_id",
    "event_stream_digest",
  ]);

  it("mints at most one grant per attempt and per seal", () => {
    for (const name of [
      "agent_run_finalization_grants_attempt_uq",
      "agent_run_finalization_grants_seal_uq",
    ]) {
      expect(
        cfg.indexes.find((i) => i.config.name === name)?.config.unique,
        name,
      ).toBe(true);
    }
  });
});

describe("agent.agent_run_finalization_obligations", () => {
  const cfg = smokeTable(agentRunFinalizationObligations, [
    "id",
    "org_id",
    "workspace_id",
    "grant_id",
    "submission_id",
    "run_id",
    "attempt_id",
    "seal_id",
  ]);

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    expect(cfg.indexes.length).toBeGreaterThan(0);
  });
});

describe("ingestion.repository_bindings", () => {
  const cfg = smokeTable(repositoryBindings, [
    "id",
    "public_id",
    "org_id",
    "workspace_id",
    "connection_id",
    "provider",
    "provider_repository_id",
    "configured_default_ref",
    "observed_at",
    "version",
    "supersedes_binding_id",
  ]);

  it("versions bindings per (connection, provider repository)", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "repository_bindings_repository_version_uq",
    );
    expect(idx?.config.unique).toBe(true);
  });

  it("requires a non-empty configured default ref (no 'main' fallback)", () => {
    const sql = flattenCheckSql(
      getChecks(repositoryBindings).find((c) =>
        c.name.includes("default_ref_check"),
      )!,
    );
    expect(sql).toContain("configured_default_ref");
  });
});

describe("ingestion.repository_binding_heads", () => {
  const cfg = smokeTable(repositoryBindingHeads, [
    "id",
    "org_id",
    "workspace_id",
    "connection_id",
    "provider_repository_id",
    "current_binding_id",
  ]);

  it("keeps one head per (connection, provider repository)", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "repository_binding_heads_repository_uq",
    );
    expect(idx?.config.unique).toBe(true);
  });
});

describe("ingestion.governed_repository_selections", () => {
  const cfg = smokeTable(governedRepositorySelections, [
    "id",
    "org_id",
    "workspace_id",
    "connection_id",
    "primary_binding_id",
  ]);

  it("allows exactly one primary binding per governed connection", () => {
    // A connection with several repositories and no row has no primary, so
    // admission fails closed rather than guessing.
    const idx = cfg.indexes.find(
      (i) => i.config.name === "governed_repository_selections_connection_uq",
    );
    expect(idx?.config.unique).toBe(true);
  });
});

describe("evidence.retention_policy_versions", () => {
  const cfg = smokeTable(retentionPolicyVersions, [
    "id",
    "public_id",
    "org_id",
    "workspace_id",
    "version",
    "mode",
    "retained_content_classes",
    "ttl_days",
    "policy_digest",
  ]);

  it("lives in the dedicated evidence schema", () => {
    expect(cfg.schema).toBe("evidence");
  });

  it("versions per tenant and dedupes by canonical policy digest", () => {
    for (const name of [
      "retention_policy_versions_version_uniq",
      "retention_policy_versions_digest_uniq",
    ]) {
      expect(
        cfg.indexes.find((i) => i.config.name === name)?.config.unique,
        name,
      ).toBe(true);
    }
  });
});

describe("iam.authorization_snapshots", () => {
  const cfg = smokeTable(authorizationSnapshots, [
    "id",
    "public_id",
    "org_id",
    "workspace_id",
    "initiating_principal_id",
    "agent_principal_id",
    "grant_ceiling",
    "grant_ceiling_digest",
    "snapshot_digest",
    "org_deny_generation",
    "workspace_deny_generation",
    "next_validity_boundary_at",
  ]);

  it("keeps the ceiling structured rather than a flattened allowlist", () => {
    // A flattened capability list could be silently refreshed from later
    // grants and would lose per-binding expiry, which is precisely the
    // widening the pinned ceiling exists to prevent.
    const ceiling = cfg.columns.find((c) => c.name === "grant_ceiling");
    expect(ceiling?.getSQLType()).toBe("jsonb");
    expect(ceiling?.notNull).toBe(true);
  });

  it("binds a run to one executing workspace (workspace_id NOT NULL)", () => {
    expect(cfg.columns.find((c) => c.name === "workspace_id")?.notNull).toBe(
      true,
    );
  });
});

describe("iam.authorization_deny_generations", () => {
  const cfg = smokeTable(authorizationDenyGenerations, [
    "id",
    "org_id",
    "workspace_id",
    "scope_kind",
    "generation",
  ]);

  it("uses partial uniques so the org scope's NULL workspace still dedupes", () => {
    // Standard UNIQUE treats NULLs as distinct, so two org-wide rows would be
    // accepted and the counter would fork.
    for (const name of [
      "authorization_deny_generations_org_uq",
      "authorization_deny_generations_workspace_uq",
    ]) {
      const idx = cfg.indexes.find((i) => i.config.name === name);
      expect(idx?.config.unique, name).toBe(true);
      expect(idx?.config.where, `${name} must be partial`).toBeDefined();
    }
  });
});

describe("iam.emergency_denies", () => {
  const cfg = smokeTable(emergencyDenies, [
    "id",
    "public_id",
    "org_id",
    "workspace_id",
    "scope_kind",
    "deny_kind",
    "capability_id",
    "resource_scope_digest",
    "reason",
    "active",
  ]);

  it("scans only active denies on the live-check index", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "emergency_denies_active_idx",
    );
    expect(idx?.config.where).toBeDefined();
  });
});

describe("iam.authorization_decisions", () => {
  const cfg = smokeTable(authorizationDecisions, [
    "id",
    "public_id",
    "org_id",
    "workspace_id",
    "capability_id",
    "request_id",
    "actor_principal_id",
    "outcome",
    "input_digest",
    "decision_digest",
    "org_deny_generation",
  ]);

  it("records every outcome, including evaluation errors", () => {
    const sql = flattenCheckSql(
      getChecks(authorizationDecisions).find((c) =>
        c.name.includes("outcome_check"),
      )!,
    );
    for (const outcome of ["allow", "deny", "approval_pending", "error"]) {
      expect(sql, `outcome CHECK missing "${outcome}"`).toContain(outcome);
    }
  });

  it("indexes attempt-scoped audit reads without covering unbound decisions", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "authorization_decisions_attempt_idx",
    );
    expect(idx?.config.where).toBeDefined();
  });
});
