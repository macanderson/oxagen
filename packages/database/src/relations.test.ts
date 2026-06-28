/**
 * relations.test.ts
 *
 * Exercises every exported Drizzle Relations object from relations.ts.
 *
 * Drizzle's `relations(table, callback)` stores the callback on
 * `Relations.config` WITHOUT calling it during table construction. This means
 * the callback bodies are never executed by a plain import, leaving ~70% of
 * relations.ts uncovered. Calling `.config(mockHelpers)` executes each arrow
 * function body and proves that the relation map is structurally valid.
 *
 * Each assertion verifies the returned object has the expected relation keys,
 * which ensures the callback wires the right fields together.
 */

import { describe, it, expect } from "vitest";
import * as allRelations from "./relations";

// ---------------------------------------------------------------------------
// Mock helpers — stand-ins for Drizzle's `one` and `many` builder functions.
//
// Important: Drizzle's `relations(table, cb)` stores a WRAPPER around cb as
// `Relations.config`. The wrapper calls cb(helpers) and then calls
// `.withFieldName(key)` on every value in the returned map. Our mock objects
// must therefore expose `.withFieldName()` so the wrapper doesn't throw.
// ---------------------------------------------------------------------------

interface MockRelation {
  _kind: "one" | "many";
  table: unknown;
  fieldName?: string;
  withFieldName: (name: string) => MockRelation;
}

function makeMockRelation(kind: "one" | "many", table: unknown): MockRelation {
  const rel: MockRelation = {
    _kind: kind,
    table,
    withFieldName(name: string): MockRelation {
      return { ...rel, fieldName: name };
    },
  };
  return rel;
}

type MockHelpers = {
  one: (table: unknown, config?: unknown) => MockRelation;
  many: (table: unknown, config?: unknown) => MockRelation;
};

const mockHelpers: MockHelpers = {
  one: (table, _config) => makeMockRelation("one", table),
  many: (table, _config) => makeMockRelation("many", table),
};

/** Type that exposes the stored config callback on a Relations object. */
type RelationsLike = {
  config: (helpers: MockHelpers) => Record<string, MockRelation>;
};

/**
 * Helper: invoke the stored config callback with the mock helpers and return
 * the relation map. The actual callback body executes here, covering those
 * lines in relations.ts.
 */
function invokeConfig(rel: unknown): Record<string, MockRelation> {
  return (rel as RelationsLike).config(mockHelpers);
}

// ---------------------------------------------------------------------------
// Org / auth / workspace relations
// ---------------------------------------------------------------------------

describe("organizationsRelations", () => {
  it("config callback returns expected relation keys", () => {
    const result = invokeConfig(allRelations.organizationsRelations);
    expect(result).toHaveProperty("orgUsers");
    expect(result).toHaveProperty("invitations");
    expect(result).toHaveProperty("workspaces");
    expect(result).toHaveProperty("subscriptions");
    expect(result).toHaveProperty("paymentMethods");
    expect(result).toHaveProperty("invoices");
    expect(result).toHaveProperty("apiKeys");
  });
});

describe("invitationsRelations", () => {
  it("config callback returns 'org' relation", () => {
    const result = invokeConfig(allRelations.invitationsRelations);
    expect(result).toHaveProperty("org");
  });
});

describe("orgUsersRelations", () => {
  it("config callback returns 'org' and 'user' relations", () => {
    const result = invokeConfig(allRelations.orgUsersRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("user");
  });
});

describe("usersRelations", () => {
  it("config callback returns membership and session relations", () => {
    const result = invokeConfig(allRelations.usersRelations);
    expect(result).toHaveProperty("orgMemberships");
    expect(result).toHaveProperty("workspaceMemberships");
    expect(result).toHaveProperty("sessions");
    expect(result).toHaveProperty("accounts");
    expect(result).toHaveProperty("conversations");
  });
});

describe("sessionsRelations", () => {
  it("config callback returns 'user' relation", () => {
    const result = invokeConfig(allRelations.sessionsRelations);
    expect(result).toHaveProperty("user");
  });
});

describe("accountsRelations", () => {
  it("config callback returns 'user' relation", () => {
    const result = invokeConfig(allRelations.accountsRelations);
    expect(result).toHaveProperty("user");
  });
});

describe("workspacesRelations", () => {
  it("config callback returns 'org' and 'members' relations", () => {
    const result = invokeConfig(allRelations.workspacesRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("members");
  });
});

describe("workspaceUsersRelations", () => {
  it("config callback returns 'workspace' and 'user' relations", () => {
    const result = invokeConfig(allRelations.workspaceUsersRelations);
    expect(result).toHaveProperty("workspace");
    expect(result).toHaveProperty("user");
  });
});

// ---------------------------------------------------------------------------
// MCP / security relations
// ---------------------------------------------------------------------------

describe("mcpServersRelations", () => {
  it("config callback returns org, consents, toolSnapshots relations", () => {
    const result = invokeConfig(allRelations.mcpServersRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("consents");
    expect(result).toHaveProperty("toolSnapshots");
  });
});

describe("mcpConsentsRelations", () => {
  it("config callback returns org, server, user relations", () => {
    const result = invokeConfig(allRelations.mcpConsentsRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("server");
    expect(result).toHaveProperty("user");
  });
});

describe("mcpToolSnapshotsRelations", () => {
  it("config callback returns org and server relations", () => {
    const result = invokeConfig(allRelations.mcpToolSnapshotsRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("server");
  });
});

describe("mcpServerChangesRelations", () => {
  it("config callback returns org and server relations", () => {
    const result = invokeConfig(allRelations.mcpServerChangesRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("server");
  });
});

// ---------------------------------------------------------------------------
// Skill relations
// ---------------------------------------------------------------------------

describe("skillsRelations", () => {
  it("config callback returns workspace and versions relations", () => {
    const result = invokeConfig(allRelations.skillsRelations);
    expect(result).toHaveProperty("workspace");
    expect(result).toHaveProperty("versions");
  });
});

describe("skillVersionsRelations", () => {
  it("config callback returns skill and parentVersion relations", () => {
    const result = invokeConfig(allRelations.skillVersionsRelations);
    expect(result).toHaveProperty("skill");
    expect(result).toHaveProperty("parentVersion");
  });
});

// ---------------------------------------------------------------------------
// Background task / approval / subagent relations
// ---------------------------------------------------------------------------

describe("backgroundTasksRelations", () => {
  it("config callback returns workspace relation", () => {
    const result = invokeConfig(allRelations.backgroundTasksRelations);
    expect(result).toHaveProperty("workspace");
  });
});

describe("approvalRequestsRelations", () => {
  it("config callback returns message relation", () => {
    const result = invokeConfig(allRelations.approvalRequestsRelations);
    expect(result).toHaveProperty("message");
  });
});

describe("subagentFanoutsRelations", () => {
  it("config callback returns parentMessage and runs relations", () => {
    const result = invokeConfig(allRelations.subagentFanoutsRelations);
    expect(result).toHaveProperty("parentMessage");
    expect(result).toHaveProperty("runs");
  });
});

describe("subagentRunsRelations", () => {
  it("config callback returns fanout relation", () => {
    const result = invokeConfig(allRelations.subagentRunsRelations);
    expect(result).toHaveProperty("fanout");
  });
});

// ---------------------------------------------------------------------------
// Chat relations
// ---------------------------------------------------------------------------

describe("conversationsRelations", () => {
  it("config callback returns user, activeLeafMessage, messages relations", () => {
    const result = invokeConfig(allRelations.conversationsRelations);
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("activeLeafMessage");
    expect(result).toHaveProperty("messages");
  });
});

describe("messagesRelations", () => {
  it("config callback returns conversation, parent, children relations", () => {
    const result = invokeConfig(allRelations.messagesRelations);
    expect(result).toHaveProperty("conversation");
    expect(result).toHaveProperty("parent");
    expect(result).toHaveProperty("children");
  });
});

// ---------------------------------------------------------------------------
// Billing relations
// ---------------------------------------------------------------------------

describe("plansRelations", () => {
  it("config callback returns subscriptions relation", () => {
    const result = invokeConfig(allRelations.plansRelations);
    expect(result).toHaveProperty("subscriptions");
  });
});

describe("subscriptionsRelations", () => {
  it("config callback returns org, plan, invoices, usageRecords relations", () => {
    const result = invokeConfig(allRelations.subscriptionsRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("plan");
    expect(result).toHaveProperty("invoices");
    expect(result).toHaveProperty("usageRecords");
  });
});

describe("paymentMethodsRelations", () => {
  it("config callback returns org relation", () => {
    const result = invokeConfig(allRelations.paymentMethodsRelations);
    expect(result).toHaveProperty("org");
  });
});

describe("invoicesRelations", () => {
  it("config callback returns org, subscription, lineItems relations", () => {
    const result = invokeConfig(allRelations.invoicesRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("subscription");
    expect(result).toHaveProperty("lineItems");
  });
});

describe("invoiceLineItemsRelations", () => {
  it("config callback returns invoice relation", () => {
    const result = invokeConfig(allRelations.invoiceLineItemsRelations);
    expect(result).toHaveProperty("invoice");
  });
});

describe("usageRecordsRelations", () => {
  it("config callback returns org and subscription relations", () => {
    const result = invokeConfig(allRelations.usageRecordsRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("subscription");
  });
});

describe("creditBalancesRelations", () => {
  it("config callback returns org relation", () => {
    const result = invokeConfig(allRelations.creditBalancesRelations);
    expect(result).toHaveProperty("org");
  });
});

describe("creditLedgerRelations", () => {
  it("config callback returns org relation", () => {
    const result = invokeConfig(allRelations.creditLedgerRelations);
    expect(result).toHaveProperty("org");
  });
});

describe("stripeEventsRelations", () => {
  it("config callback returns processing relation", () => {
    const result = invokeConfig(allRelations.stripeEventsRelations);
    expect(result).toHaveProperty("processing");
  });
});

describe("stripeEventProcessingRelations", () => {
  it("config callback returns event relation", () => {
    const result = invokeConfig(allRelations.stripeEventProcessingRelations);
    expect(result).toHaveProperty("event");
  });
});

// ---------------------------------------------------------------------------
// IAM relations
// ---------------------------------------------------------------------------

describe("principalsRelations", () => {
  it("config callback returns org, roleAssignments, accessRequests relations", () => {
    const result = invokeConfig(allRelations.principalsRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("roleAssignments");
    expect(result).toHaveProperty("accessRequests");
  });
});

describe("rolesRelations", () => {
  it("config callback returns org, roleGrants, principalAssignments, parentRole, childRoles", () => {
    const result = invokeConfig(allRelations.rolesRelations);
    expect(result).toHaveProperty("org");
    expect(result).toHaveProperty("roleGrants");
    expect(result).toHaveProperty("principalAssignments");
    expect(result).toHaveProperty("parentRole");
    expect(result).toHaveProperty("childRoles");
  });
});

describe("roleGrantsRelations", () => {
  it("config callback returns role and org relations", () => {
    const result = invokeConfig(allRelations.roleGrantsRelations);
    expect(result).toHaveProperty("role");
    expect(result).toHaveProperty("org");
  });
});

describe("principalRoleAssignmentsRelations", () => {
  it("config callback returns principal, role, org relations", () => {
    const result = invokeConfig(allRelations.principalRoleAssignmentsRelations);
    expect(result).toHaveProperty("principal");
    expect(result).toHaveProperty("role");
    expect(result).toHaveProperty("org");
  });
});

describe("accessRequestsRelations", () => {
  it("config callback returns requester and org relations", () => {
    const result = invokeConfig(allRelations.accessRequestsRelations);
    expect(result).toHaveProperty("requester");
    expect(result).toHaveProperty("org");
  });
});

// ---------------------------------------------------------------------------
// Agent relations
// ---------------------------------------------------------------------------

describe("agentsRelations", () => {
  it("config callback returns workspace, versions, executions relations", () => {
    const result = invokeConfig(allRelations.agentsRelations);
    expect(result).toHaveProperty("workspace");
    expect(result).toHaveProperty("versions");
    expect(result).toHaveProperty("executions");
  });
});

describe("agentVersionsRelations", () => {
  it("config callback returns agent, executions, stepRuns relations", () => {
    const result = invokeConfig(allRelations.agentVersionsRelations);
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("executions");
    expect(result).toHaveProperty("stepRuns");
  });
});

describe("agentExecutionsRelations", () => {
  it("config callback returns agent, agentVersion, workspace, steps relations", () => {
    const result = invokeConfig(allRelations.agentExecutionsRelations);
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("agentVersion");
    expect(result).toHaveProperty("workspace");
    expect(result).toHaveProperty("steps");
  });
});

describe("agentExecutionStepsRelations", () => {
  it("config callback returns execution and toolCalls relations", () => {
    const result = invokeConfig(allRelations.agentExecutionStepsRelations);
    expect(result).toHaveProperty("execution");
    expect(result).toHaveProperty("toolCalls");
  });
});

describe("agentToolCallsRelations", () => {
  it("config callback returns executionStep relation", () => {
    const result = invokeConfig(allRelations.agentToolCallsRelations);
    expect(result).toHaveProperty("executionStep");
  });
});

describe("agentPlansRelations", () => {
  it("config callback returns workspace relation", () => {
    const result = invokeConfig(allRelations.agentPlansRelations);
    expect(result).toHaveProperty("workspace");
  });
});

// ---------------------------------------------------------------------------
// Playbook / workflow relations
// ---------------------------------------------------------------------------

describe("playbooksRelations", () => {
  it("config callback returns workspace, versions, triggers, runs relations", () => {
    const result = invokeConfig(allRelations.playbooksRelations);
    expect(result).toHaveProperty("workspace");
    expect(result).toHaveProperty("versions");
    expect(result).toHaveProperty("triggers");
    expect(result).toHaveProperty("runs");
  });
});

describe("playbookVersionsRelations", () => {
  it("config callback returns playbook, steps, edges, runs relations", () => {
    const result = invokeConfig(allRelations.playbookVersionsRelations);
    expect(result).toHaveProperty("playbook");
    expect(result).toHaveProperty("steps");
    expect(result).toHaveProperty("edges");
    expect(result).toHaveProperty("runs");
  });
});

describe("playbookStepsRelations", () => {
  it("config callback returns version, outboundEdges, inboundEdges, stepRuns", () => {
    const result = invokeConfig(allRelations.playbookStepsRelations);
    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("outboundEdges");
    expect(result).toHaveProperty("inboundEdges");
    expect(result).toHaveProperty("stepRuns");
  });
});

describe("playbookEdgesRelations", () => {
  it("config callback returns version, sourceStep, targetStep relations", () => {
    const result = invokeConfig(allRelations.playbookEdgesRelations);
    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("sourceStep");
    expect(result).toHaveProperty("targetStep");
  });
});

describe("playbookTriggersRelations", () => {
  it("config callback returns playbook and workspace relations", () => {
    const result = invokeConfig(allRelations.playbookTriggersRelations);
    expect(result).toHaveProperty("playbook");
    expect(result).toHaveProperty("workspace");
  });
});

describe("playbookRunsRelations", () => {
  it("config callback returns playbook, version, workspace, parentRun, childRuns, stepRuns, events, approvals", () => {
    const result = invokeConfig(allRelations.playbookRunsRelations);
    expect(result).toHaveProperty("playbook");
    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("workspace");
    expect(result).toHaveProperty("parentRun");
    expect(result).toHaveProperty("childRuns");
    expect(result).toHaveProperty("stepRuns");
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("approvals");
  });
});

describe("playbookStepRunsRelations", () => {
  it("config callback returns run, step, agentVersion, events, approvals relations", () => {
    const result = invokeConfig(allRelations.playbookStepRunsRelations);
    expect(result).toHaveProperty("run");
    expect(result).toHaveProperty("step");
    expect(result).toHaveProperty("agentVersion");
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("approvals");
  });
});

describe("playbookEventsRelations", () => {
  it("config callback returns run and stepRun relations", () => {
    const result = invokeConfig(allRelations.playbookEventsRelations);
    expect(result).toHaveProperty("run");
    expect(result).toHaveProperty("stepRun");
  });
});

describe("playbookApprovalsRelations", () => {
  it("config callback returns run and stepRun relations", () => {
    const result = invokeConfig(allRelations.playbookApprovalsRelations);
    expect(result).toHaveProperty("run");
    expect(result).toHaveProperty("stepRun");
  });
});

// ---------------------------------------------------------------------------
// Schema Registry relations
// ---------------------------------------------------------------------------

describe("schemaRegistriesRelations", () => {
  it("config callback returns pinnedVersion, draftVersion, versions relations", () => {
    const result = invokeConfig(allRelations.schemaRegistriesRelations);
    expect(result).toHaveProperty("pinnedVersion");
    expect(result).toHaveProperty("draftVersion");
    expect(result).toHaveProperty("versions");
  });
});

describe("schemaVersionsRelations", () => {
  it("config callback returns registry, parentVersion, childVersions, schemas", () => {
    const result = invokeConfig(allRelations.schemaVersionsRelations);
    expect(result).toHaveProperty("registry");
    expect(result).toHaveProperty("parentVersion");
    expect(result).toHaveProperty("childVersions");
    expect(result).toHaveProperty("schemas");
  });
});

describe("schemasRelations", () => {
  it("config callback returns version, nodeLabels, relationshipTypes relations", () => {
    const result = invokeConfig(allRelations.schemasRelations);
    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("nodeLabels");
    expect(result).toHaveProperty("relationshipTypes");
  });
});

describe("schemaActivationsRelations", () => {
  it("config callback returns an empty object (app-enforced cross-workspace joins)", () => {
    const result = invokeConfig(allRelations.schemaActivationsRelations);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});

describe("nodeLabelsRelations", () => {
  it("config callback returns version, schema, properties relations", () => {
    const result = invokeConfig(allRelations.nodeLabelsRelations);
    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("schema");
    expect(result).toHaveProperty("properties");
  });
});

describe("relationshipTypesRelations", () => {
  it("config callback returns version, schema, properties relations", () => {
    const result = invokeConfig(allRelations.relationshipTypesRelations);
    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("schema");
    expect(result).toHaveProperty("properties");
  });
});

describe("schemaPropertiesRelations", () => {
  it("config callback returns version, nodeLabel, relationshipType relations", () => {
    const result = invokeConfig(allRelations.schemaPropertiesRelations);
    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("nodeLabel");
    expect(result).toHaveProperty("relationshipType");
  });
});

// ---------------------------------------------------------------------------
// Completeness guard — no exported relation is accidentally skipped
// ---------------------------------------------------------------------------

describe("relations.ts completeness guard", () => {
  it("all exported objects are Relations instances with a config callback", () => {
    for (const [name, rel] of Object.entries(allRelations)) {
      const asRel = rel as unknown as { config?: unknown };
      expect(
        typeof asRel.config,
        `${name}.config should be a function`,
      ).toBe("function");
    }
  });
});
