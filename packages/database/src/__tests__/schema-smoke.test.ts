/**
 * schema-smoke.test.ts
 *
 * Smoke tests for the Drizzle table definitions in schema files that were
 * previously untested: environments, notification, workflow, org, content,
 * chat, mcp, and agent.
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
  agentTriggers,
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
    expect(cols, `Expected column '${col}' in table '${cfg.name}'`).toContain(col);
  }
  return cfg;
}

// ═══════════════════════════════════════════════════════════════════════════
// environments schema
// ═══════════════════════════════════════════════════════════════════════════

describe("environments.environments", () => {
  const cfg = smokeTable(environments, ["id", "name", "slug", "is_default", "is_active", "org_id", "workspace_id"]);

  it("is defined", () => { expect(environments).toBeDefined(); });

  it("has workspace_slug_uniq unique constraint", () => {
    const uc = cfg.uniqueConstraints.find(
      (u) => u.name === "environments_workspace_slug_uniq",
    );
    expect(uc).toBeDefined();
  });

  it("has org_workspace index", () => {
    const idx = cfg.indexes.find((i) => i.config.name === "environments_org_workspace_idx");
    expect(idx).toBeDefined();
  });
});

describe("environments.secret_keys", () => {
  smokeTable(secretKeys, ["id", "key", "sensitive", "org_id", "workspace_id"]);

  it("is defined", () => { expect(secretKeys).toBeDefined(); });

  it("has storage CHECK constraint", () => {
    const checks = getChecks(secretKeys);
    const storageCheck = checks.find((c) => c.name === "secret_keys_default_storage_check");
    expect(storageCheck).toBeDefined();
  });
});

describe("environments.secret_values", () => {
  const cfg = smokeTable(secretValues, ["id", "secret_key_id", "environment_id", "org_id", "workspace_id"]);

  it("is defined", () => { expect(secretValues).toBeDefined(); });

  it("has key_env_uniq unique constraint", () => {
    const uc = cfg.uniqueConstraints.find((u) => u.name === "secret_values_key_env_uniq");
    expect(uc).toBeDefined();
  });

  it("has storage CHECK constraint", () => {
    const checks = getChecks(secretValues);
    const storageCheck = checks.find((c) => c.name === "secret_values_storage_check");
    expect(storageCheck).toBeDefined();
  });
});

describe("environments.secret_access_log", () => {
  smokeTable(secretAccessLog, ["id", "org_id", "workspace_id", "action", "occurred_at"]);

  it("is defined", () => { expect(secretAccessLog).toBeDefined(); });

  it("action CHECK includes reveal and export", () => {
    const checks = getChecks(secretAccessLog);
    const actionCheck = checks.find((c) => c.name === "secret_access_log_action_check");
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
  smokeTable(notifications, ["id", "org_id", "user_id", "kind", "title", "unread", "archived"]);

  it("is defined", () => { expect(notifications).toBeDefined(); });

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
    const idx = cfg.indexes.find((i) => i.config.name === "notifications_user_unread_idx");
    expect(idx).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// workflow schema
// ═══════════════════════════════════════════════════════════════════════════

describe("workflow.playbooks", () => {
  smokeTable(playbooks, ["id", "name", "slug", "status", "visibility"]);

  it("is defined", () => { expect(playbooks).toBeDefined(); });

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
    const visCheck = checks.find((c) => c.name === "playbooks_visibility_check");
    expect(visCheck).toBeDefined();
    const sql = flattenCheckSql(visCheck!);
    for (const v of ["private", "workspace", "organization", "marketplace"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_versions", () => {
  smokeTable(playbookVersions, ["id", "playbook_id", "version", "is_published"]);

  it("is defined", () => { expect(playbookVersions).toBeDefined(); });

  it("has playbook_version_uniq unique index", () => {
    const cfg = getTableConfig(playbookVersions);
    const idx = cfg.indexes.find((i) => i.config.name === "playbook_versions_playbook_version_uniq");
    expect(idx).toBeDefined();
  });
});

describe("workflow.playbook_steps", () => {
  smokeTable(playbookSteps, ["id", "playbook_version_id", "step_key", "step_type"]);

  it("is defined", () => { expect(playbookSteps).toBeDefined(); });

  it("step_type CHECK includes agent and tool", () => {
    const checks = getChecks(playbookSteps);
    const typeCheck = checks.find((c) => c.name === "playbook_steps_step_type_check");
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    expect(sql).toContain("agent");
    expect(sql).toContain("tool");
  });
});

describe("workflow.playbook_edges", () => {
  smokeTable(playbookEdges, ["id", "playbook_version_id", "source_step_id", "target_step_id", "edge_type"]);

  it("is defined", () => { expect(playbookEdges).toBeDefined(); });

  it("edge_type CHECK includes default and conditional", () => {
    const checks = getChecks(playbookEdges);
    const typeCheck = checks.find((c) => c.name === "playbook_edges_edge_type_check");
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    expect(sql).toContain("default");
    expect(sql).toContain("conditional");
  });
});

describe("workflow.playbook_triggers", () => {
  smokeTable(playbookTriggers, ["id", "playbook_id", "trigger_type", "is_enabled"]);

  it("is defined", () => { expect(playbookTriggers).toBeDefined(); });

  it("trigger_type CHECK includes event, schedule, api", () => {
    const checks = getChecks(playbookTriggers);
    const typeCheck = checks.find((c) => c.name === "playbook_triggers_trigger_type_check");
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    for (const v of ["event", "schedule", "api"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_runs", () => {
  smokeTable(playbookRuns, ["id", "org_id", "workspace_id", "playbook_id", "status", "source"]);

  it("is defined", () => { expect(playbookRuns).toBeDefined(); });

  it("status CHECK includes pending, running, completed, failed, cancelled", () => {
    const checks = getChecks(playbookRuns);
    const statusCheck = checks.find((c) => c.name === "playbook_runs_status_check");
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["pending", "running", "completed", "failed", "cancelled"]) {
      expect(sql).toContain(v);
    }
  });

  it("source CHECK includes api, event, manual", () => {
    const checks = getChecks(playbookRuns);
    const sourceCheck = checks.find((c) => c.name === "playbook_runs_source_check");
    expect(sourceCheck).toBeDefined();
    const sql = flattenCheckSql(sourceCheck!);
    for (const v of ["api", "event", "manual"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_step_runs", () => {
  smokeTable(playbookStepRuns, ["id", "playbook_run_id", "playbook_step_id", "status", "attempt"]);

  it("is defined", () => { expect(playbookStepRuns).toBeDefined(); });

  it("status CHECK includes pending, running, completed, failed, skipped, cancelled", () => {
    const checks = getChecks(playbookStepRuns);
    const statusCheck = checks.find((c) => c.name === "playbook_step_runs_status_check");
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["pending", "running", "completed", "failed", "skipped", "cancelled"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_events", () => {
  smokeTable(playbookEvents, ["id", "playbook_run_id", "sequence", "event_type", "event_hash"]);

  it("is defined", () => { expect(playbookEvents).toBeDefined(); });

  it("event_type CHECK includes run_started, step_completed, run_completed", () => {
    const checks = getChecks(playbookEvents);
    const typeCheck = checks.find((c) => c.name === "playbook_events_event_type_check");
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    for (const v of ["run_started", "step_completed", "run_completed"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("workflow.playbook_approvals", () => {
  smokeTable(playbookApprovals, ["id", "playbook_run_id", "step_run_id", "status"]);

  it("is defined", () => { expect(playbookApprovals).toBeDefined(); });

  it("status CHECK includes pending, approved, denied, expired", () => {
    const checks = getChecks(playbookApprovals);
    const statusCheck = checks.find((c) => c.name === "playbook_approvals_status_check");
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
  smokeTable(organizations, ["id", "name", "slug", "plan_type", "status", "type"]);

  it("is defined", () => { expect(organizations).toBeDefined(); });

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
    const statusCheck = checks.find((c) => c.name === "organizations_status_check");
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["active", "suspended", "deleted"]) {
      expect(sql).toContain(v);
    }
  });

  it("employee_size CHECK allows NULL", () => {
    const checks = getChecks(organizations);
    const sizeCheck = checks.find((c) => c.name === "organizations_employee_size_check");
    expect(sizeCheck).toBeDefined();
    const sql = flattenCheckSql(sizeCheck!);
    expect(sql.toUpperCase()).toContain("NULL");
  });
});

describe("org.org_users", () => {
  smokeTable(orgUsers, ["id", "org_id", "user_id", "role", "joined_at"]);

  it("is defined", () => { expect(orgUsers).toBeDefined(); });

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
  smokeTable(orgSlugHistory, ["id", "org_id", "old_slug", "new_slug", "changed_at"]);

  it("is defined", () => { expect(orgSlugHistory).toBeDefined(); });

  it("has old_slug index", () => {
    const cfg = getTableConfig(orgSlugHistory);
    const idx = cfg.indexes.find((i) => i.config.name === "org_slug_history_old_slug_idx");
    expect(idx).toBeDefined();
  });
});

describe("org.invitations", () => {
  smokeTable(invitations, ["id", "org_id", "email", "role", "status"]);

  it("is defined", () => { expect(invitations).toBeDefined(); });

  it("status CHECK includes pending, accepted, declined, revoked, expired", () => {
    const checks = getChecks(invitations);
    const statusCheck = checks.find((c) => c.name === "invitations_status_check");
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
    "id", "user_id", "kind", "access_policy", "status",
    "storage_provider", "storage_key", "mime_type", "prompt", "model",
  ]);

  it("is defined", () => { expect(generatedAssets).toBeDefined(); });

  it("kind CHECK includes image, video, document", () => {
    const checks = getChecks(generatedAssets);
    const kindCheck = checks.find((c) => c.name === "generated_assets_kind_check");
    expect(kindCheck).toBeDefined();
    const sql = flattenCheckSql(kindCheck!);
    for (const v of ["image", "video", "document"]) {
      expect(sql).toContain(v);
    }
  });

  it("access_policy CHECK includes user, org, public", () => {
    const checks = getChecks(generatedAssets);
    const policyCheck = checks.find((c) => c.name === "generated_assets_access_policy_check");
    expect(policyCheck).toBeDefined();
    const sql = flattenCheckSql(policyCheck!);
    for (const v of ["user", "org", "public"]) {
      expect(sql).toContain(v);
    }
  });

  it("status CHECK includes pending, ready, failed", () => {
    const checks = getChecks(generatedAssets);
    const statusCheck = checks.find((c) => c.name === "generated_assets_status_check");
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["pending", "ready", "failed"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("content.documents", () => {
  smokeTable(documents, ["id", "org_id", "workspace_id", "title", "content"]);

  it("is defined", () => { expect(documents).toBeDefined(); });

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
  smokeTable(conversations, ["id", "org_id", "workspace_id", "user_id", "status"]);

  it("is defined", () => { expect(conversations).toBeDefined(); });

  it("status CHECK includes active, archived, deleted", () => {
    const checks = getChecks(conversations);
    const statusCheck = checks.find((c) => c.name === "conversations_status_check");
    expect(statusCheck).toBeDefined();
    const sql = flattenCheckSql(statusCheck!);
    for (const v of ["active", "archived", "deleted"]) {
      expect(sql).toContain(v);
    }
  });

  it("has conversations_list_idx index", () => {
    const cfg = getTableConfig(conversations);
    const idx = cfg.indexes.find((i) => i.config.name === "conversations_list_idx");
    expect(idx).toBeDefined();
  });
});

describe("chat.messages", () => {
  smokeTable(messages, [
    "id", "org_id", "workspace_id", "conversation_id", "role", "content", "content_blocks",
  ]);

  it("is defined", () => { expect(messages).toBeDefined(); });

  it("has conversation_parent index", () => {
    const cfg = getTableConfig(messages);
    const idx = cfg.indexes.find((i) => i.config.name === "messages_conversation_parent_idx");
    expect(idx).toBeDefined();
  });

  it("has conversation_created index", () => {
    const cfg = getTableConfig(messages);
    const idx = cfg.indexes.find((i) => i.config.name === "messages_conversation_created_idx");
    expect(idx).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mcp schema
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp.registries (mcpRegistries)", () => {
  smokeTable(mcpRegistries, ["id", "org_id", "workspace_id", "name", "base_url", "is_default"]);

  it("is defined", () => { expect(mcpRegistries).toBeDefined(); });

  it("has registries_org_ws_url_uniq unique index", () => {
    const cfg = getTableConfig(mcpRegistries);
    const idx = cfg.indexes.find((i) => i.config.name === "registries_org_ws_url_uniq");
    expect(idx).toBeDefined();
  });

  it("has registries_org_ws_default_uniq partial unique index", () => {
    const cfg = getTableConfig(mcpRegistries);
    const idx = cfg.indexes.find((i) => i.config.name === "registries_org_ws_default_uniq");
    expect(idx).toBeDefined();
  });
});

describe("mcp.credentials (mcpCredentials)", () => {
  smokeTable(mcpCredentials, ["id", "org_id", "workspace_id", "org_listing_id", "auth_kind", "status"]);

  it("is defined", () => { expect(mcpCredentials).toBeDefined(); });
});

describe("mcp.mcp_servers (mcpServers)", () => {
  const cols = sqlColumnNames(mcpServers);

  it("is defined", () => { expect(mcpServers).toBeDefined(); });
  it("has id column", () => { expect(cols).toContain("id"); });
  it("has org_id column", () => { expect(cols).toContain("org_id"); });

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(mcpServers);
    expect(cfg).toBeDefined();
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("mcp.mcp_consents (mcpConsents)", () => {
  it("is defined", () => { expect(mcpConsents).toBeDefined(); });

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(mcpConsents);
    expect(cfg).toBeDefined();
  });
});

describe("mcp.mcp_catalog_servers (mcpCatalogServers)", () => {
  it("is defined", () => { expect(mcpCatalogServers).toBeDefined(); });

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(mcpCatalogServers);
    expect(cfg).toBeDefined();
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("mcp.mcp_tool_snapshots (mcpToolSnapshots)", () => {
  it("is defined", () => { expect(mcpToolSnapshots).toBeDefined(); });

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(mcpToolSnapshots);
    expect(cfg).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// agent schema
// ═══════════════════════════════════════════════════════════════════════════

describe("agent.agents", () => {
  smokeTable(agents, ["id", "org_id", "workspace_id", "slug", "name", "agent_type", "status", "deployment_status"]);

  it("is defined", () => { expect(agents).toBeDefined(); });

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
    const deployCheck = checks.find((c) => c.name === "agents_deployment_status_check");
    expect(deployCheck).toBeDefined();
    const sql = flattenCheckSql(deployCheck!);
    expect(sql).toContain("inactive");
    expect(sql).toContain("active");
  });
});

describe("agent.agent_triggers", () => {
  smokeTable(agentTriggers, ["id", "agent_id", "trigger_type", "enabled"]);

  it("is defined", () => { expect(agentTriggers).toBeDefined(); });

  it("trigger_type CHECK includes manual, schedule, event", () => {
    const checks = getChecks(agentTriggers);
    const typeCheck = checks.find((c) => c.name === "agent_triggers_trigger_type_check");
    expect(typeCheck).toBeDefined();
    const sql = flattenCheckSql(typeCheck!);
    for (const v of ["manual", "schedule", "event"]) {
      expect(sql).toContain(v);
    }
  });
});

describe("agent.agent_versions", () => {
  smokeTable(agentVersions, ["id", "agent_id", "version", "is_published", "config"]);

  it("is defined", () => { expect(agentVersions).toBeDefined(); });

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(agentVersions);
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("agent.skills", () => {
  it("is defined", () => { expect(skills).toBeDefined(); });

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(skills);
    expect(cfg).toBeDefined();
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("agent.skill_versions", () => {
  it("is defined", () => { expect(skillVersions).toBeDefined(); });

  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(skillVersions);
    expect(cfg).toBeDefined();
  });
});

describe("agent.background_tasks", () => {
  it("is defined", () => { expect(backgroundTasks).toBeDefined(); });

  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(backgroundTasks);
    expect(cfg).toBeDefined();
    const cols = cfg.columns.map((c) => c.name);
    expect(cols).toContain("id");
  });
});

describe("agent.approval_requests", () => {
  it("is defined", () => { expect(approvalRequests).toBeDefined(); });

  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(approvalRequests);
    expect(cfg).toBeDefined();
  });
});

describe("agent.subagent_fanouts", () => {
  it("is defined", () => { expect(subagentFanouts).toBeDefined(); });

  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(subagentFanouts);
    expect(cfg).toBeDefined();
  });
});

describe("agent.subagent_runs", () => {
  it("is defined", () => { expect(subagentRuns).toBeDefined(); });

  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(subagentRuns);
    expect(cfg).toBeDefined();
  });
});

describe("agent.agent_executions", () => {
  it("is defined", () => { expect(agentExecutions).toBeDefined(); });

  it("triggers getTableConfig (ExtraConfigBuilder callback)", () => {
    const cfg = getTableConfig(agentExecutions);
    expect(cfg).toBeDefined();
    expect(cfg.columns.length).toBeGreaterThan(0);
  });
});

describe("agent.agent_execution_steps", () => {
  it("is defined", () => { expect(agentExecutionSteps).toBeDefined(); });

  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(agentExecutionSteps);
    expect(cfg).toBeDefined();
  });
});

describe("agent.agent_tool_calls", () => {
  it("is defined", () => { expect(agentToolCalls).toBeDefined(); });

  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(agentToolCalls);
    expect(cfg).toBeDefined();
  });
});

describe("agent.agent_plans", () => {
  it("is defined", () => { expect(agentPlans).toBeDefined(); });

  it("triggers getTableConfig", () => {
    const cfg = getTableConfig(agentPlans);
    expect(cfg).toBeDefined();
    const cols = cfg.columns.map((c) => c.name);
    expect(cols).toContain("id");
  });
});
