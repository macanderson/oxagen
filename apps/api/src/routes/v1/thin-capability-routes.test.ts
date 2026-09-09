import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";

/**
 * Table-driven coverage for the thin capability routes — the ones whose whole
 * body is "parse the contract input → build the capability context → invoke →
 * return the output". There is no per-route logic worth a bespoke suite, but
 * the adapter contract IS worth asserting for every one of them:
 *
 *  - the request body is validated by the CONTRACT's own input schema (a bad
 *    body must never reach `invoke`),
 *  - `invoke` is called with the contract's registered capability NAME (not the
 *    file stem — ADR-025 renamed capabilities to verb-first snake_case while
 *    the files kept the old dotted stem), and
 *  - the documented success status is returned.
 *
 * Routes with real branching (chat streaming, OAuth, repo, privacy export…)
 * keep their own dedicated suites.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { agentDefinitionDelete } from "@oxagen/oxagen/contracts/agent.definition.delete";
import { agentDefinitionRevise } from "@oxagen/oxagen/contracts/agent.definition.revise";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { agentDefinitionSummarize } from "@oxagen/oxagen/contracts/agent.definition.summarize";
import { agentEnvironmentBind } from "@oxagen/oxagen/contracts/agent.environment.bind";
import { agentEnvironmentUnbind } from "@oxagen/oxagen/contracts/agent.environment.unbind";
import { agentMcpResolve } from "@oxagen/oxagen/contracts/agent.mcp.resolve";
import { agentMemoryDelete } from "@oxagen/oxagen/contracts/agent.memory.delete";
import { agentMemoryDemote } from "@oxagen/oxagen/contracts/agent.memory.demote";
import { agentMemoryPromote } from "@oxagen/oxagen/contracts/agent.memory.promote";
import { agentMemoryRemember } from "@oxagen/oxagen/contracts/agent.memory.remember";
import { agentMemoryUpdate } from "@oxagen/oxagen/contracts/agent.memory.update";
import { agentMemoryCitationsList } from "@oxagen/oxagen/contracts/agent.memory_citation.list";
import { agentMemoryCitationStats } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";
import { agentMemoryEvidenceAttach } from "@oxagen/oxagen/contracts/agent.memory_evidence.attach";
import { agentMemoryImportCommit } from "@oxagen/oxagen/contracts/agent.memory_import.commit";
import { agentMemoryImportParse } from "@oxagen/oxagen/contracts/agent.memory_import.parse";
import { agentMemoryPromotionDismiss } from "@oxagen/oxagen/contracts/agent.memory_promotion.dismiss";
import { agentMemoryPromotionCandidates } from "@oxagen/oxagen/contracts/agent.memory_promotion.list";
import { agentMemoryPromotionRationales } from "@oxagen/oxagen/contracts/agent.memory_promotion.rationales";
import { agentRoleAssign } from "@oxagen/oxagen/contracts/agent.role.assign";
import { agentRoleRevoke } from "@oxagen/oxagen/contracts/agent.role.revoke";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import { budgetPolicyRead } from "@oxagen/oxagen/contracts/budget.policy.read";
import { budgetPolicyWrite } from "@oxagen/oxagen/contracts/budget.policy.write";
import { chatMessageExecution } from "@oxagen/oxagen/contracts/chat.message.execution";
import { contextRecordPromote } from "@oxagen/oxagen/contracts/context.record.promote";
import { contextRecordPublish } from "@oxagen/oxagen/contracts/context.record.publish";
import { conversationAttachmentAdd } from "@oxagen/oxagen/contracts/conversation.attachment.add";
import { conversationChat } from "@oxagen/oxagen/contracts/conversation.chat";
import { toolDeclarationPublish } from "@oxagen/oxagen/contracts/tool.declaration.publish";

import { agentDefinitionDeleteRoute } from "./agent.definition.delete";
import { agentDefinitionReviseRoute } from "./agent.definition.revise";
import { agentDefinitionSuggestRoute } from "./agent.definition.suggest";
import { agentDefinitionSummarizeRoute } from "./agent.definition.summarize";
import { agentEnvironmentBindRoute } from "./agent.environment.bind";
import { agentEnvironmentUnbindRoute } from "./agent.environment.unbind";
import { agentMcpResolveRoute } from "./agent.mcp.resolve";
import { agentMemoryDeleteRoute } from "./agent.memory.delete";
import { agentMemoryDemoteRoute } from "./agent.memory.demote";
import { agentMemoryPromoteRoute } from "./agent.memory.promote";
import { agentMemoryRememberRoute } from "./agent.memory.remember";
import { agentMemoryUpdateRoute } from "./agent.memory.update";
import { agentMemoryCitationsListRoute } from "./agent.memory_citation.list";
import { agentMemoryCitationStatsRoute } from "./agent.memory_citation.stats";
import { agentMemoryEvidenceAttachRoute } from "./agent.memory_evidence.attach";
import { agentMemoryImportCommitRoute } from "./agent.memory_import.commit";
import { agentMemoryImportParseRoute } from "./agent.memory_import.parse";
import { agentMemoryPromotionDismissRoute } from "./agent.memory_promotion.dismiss";
import { agentMemoryPromotionCandidatesRoute } from "./agent.memory_promotion.list";
import { agentMemoryPromotionRationalesRoute } from "./agent.memory_promotion.rationales";
import { agentRoleAssignRoute } from "./agent.role.assign";
import { agentRoleRevokeRoute } from "./agent.role.revoke";
import { billingBudgetGetRoute } from "./billing.budget.get";
import { billingBudgetSetRoute } from "./billing.budget.set";
import { budgetPolicyReadRoute } from "./budget.policy.read";
import { budgetPolicyWriteRoute } from "./budget.policy.write";
import { chatMessageExecutionRoute } from "./chat.message.execution";
import { contextRecordPromoteRoute } from "./context.record.promote";
import { contextRecordPublishRoute } from "./context.record.publish";
import { conversationAttachmentAddRoute } from "./conversation.attachment.add";
import { conversationChatRoute } from "./conversation.chat";
import { toolDeclarationPublishRoute } from "./tool.declaration.publish";

const CTX = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const UUID = "33333333-3333-4333-8333-333333333333";
const OUTPUT = { ok: true };

interface ThinRoute {
  /** Route file stem — the test name, so a failure names the file. */
  file: string;
  route: Hono<never>;
  method: "GET" | "POST" | "PUT" | "PATCH";
  /** Registered (ADR-025 verb-first) capability name. */
  capability: string;
  /** A body the contract accepts. `undefined` for bodyless GET routes. */
  body?: unknown;
  /** The input `invoke` should receive — defaults to the body when omitted. */
  expectedInput?: unknown;
  /** A body the contract must reject. Omitted for bodyless GET routes. */
  invalidBody?: unknown;
  status: number;
}

const ROUTES: ThinRoute[] = [
  {
    file: "agent.definition.delete",
    route: agentDefinitionDeleteRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentDefinitionDelete.name,
    body: { agentId: "agt_1" },
    invalidBody: {},
    status: 200,
  },
  {
    file: "agent.definition.revise",
    route: agentDefinitionReviseRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentDefinitionRevise.name,
    body: { agentId: "agt_1", prompt: "give it billing read access" },
    invalidBody: { agentId: "agt_1", prompt: "short" },
    status: 200,
  },
  {
    file: "agent.definition.suggest",
    route: agentDefinitionSuggestRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentDefinitionSuggest.name,
    body: { description: "audits the fleet nightly for budget breaches" },
    invalidBody: { description: "too short" },
    status: 200,
  },
  {
    file: "agent.definition.summarize",
    route: agentDefinitionSummarizeRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentDefinitionSummarize.name,
    body: { agentId: "agt_1", force: true },
    invalidBody: { agentId: 7 },
    status: 200,
  },
  {
    file: "agent.environment.bind",
    route: agentEnvironmentBindRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentEnvironmentBind.name,
    body: { agentId: "agt_1", environmentId: "env_1", isPrimary: true },
    invalidBody: { agentId: "" },
    status: 200,
  },
  {
    file: "agent.environment.unbind",
    route: agentEnvironmentUnbindRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentEnvironmentUnbind.name,
    body: { agentId: "agt_1", environmentId: "env_1" },
    invalidBody: { agentId: "agt_1" },
    status: 200,
  },
  {
    file: "agent.mcp.resolve",
    route: agentMcpResolveRoute as unknown as Hono<never>,
    method: "GET",
    capability: agentMcpResolve.name,
    expectedInput: agentMcpResolve.input.parse({}),
    status: 200,
  },
  {
    file: "agent.memory.delete",
    route: agentMemoryDeleteRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryDelete.name,
    body: { memoryId: "m_1" },
    invalidBody: { memoryId: "" },
    status: 200,
  },
  {
    file: "agent.memory.demote",
    route: agentMemoryDemoteRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryDemote.name,
    body: { memoryId: "m_1", toClass: "RULE", enforcementScore: 40 },
    invalidBody: { memoryId: "m_1", toClass: "FACT" },
    status: 200,
  },
  {
    file: "agent.memory.promote",
    route: agentMemoryPromoteRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryPromote.name,
    body: { memoryId: "m_1", toClass: "FACT" },
    invalidBody: { memoryId: "m_1", toClass: "OBSERVATION" },
    status: 200,
  },
  {
    file: "agent.memory.remember",
    route: agentMemoryRememberRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryRemember.name,
    body: { text: "prefer withTenantDb over raw db()" },
    expectedInput: {
      text: "prefer withTenantDb over raw db()",
      source: "user",
    },
    invalidBody: { text: "" },
    status: 201,
  },
  {
    file: "agent.memory.update",
    route: agentMemoryUpdateRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryUpdate.name,
    body: { memoryId: "m_1", lesson: "revised lesson", confidenceScore: 80 },
    invalidBody: { memoryId: "m_1", confidenceScore: 900 },
    status: 200,
  },
  {
    file: "agent.memory_citation.list",
    route: agentMemoryCitationsListRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryCitationsList.name,
    body: { executionId: "aex_1", compliance: "VIOLATION" },
    invalidBody: { executionId: "aex_1", compliance: "NOT_A_COMPLIANCE" },
    status: 200,
  },
  {
    file: "agent.memory_citation.stats",
    route: agentMemoryCitationStatsRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryCitationStats.name,
    body: {},
    expectedInput: { days: 30, limit: 10 },
    invalidBody: { days: 0 },
    status: 200,
  },
  {
    file: "agent.memory_evidence.attach",
    route: agentMemoryEvidenceAttachRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryEvidenceAttach.name,
    body: { memoryId: "m_1", sourceKind: "HUMAN_CONFIRM", strength: 0.5 },
    expectedInput: {
      memoryId: "m_1",
      sourceKind: "HUMAN_CONFIRM",
      strength: 0.5,
      refutes: false,
    },
    invalidBody: { memoryId: "m_1", sourceKind: "HUMAN_CONFIRM", strength: 9 },
    status: 201,
  },
  {
    file: "agent.memory_import.commit",
    route: agentMemoryImportCommitRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryImportCommit.name,
    body: {
      drafts: [
        { lesson: "always scope by workspace", memoryKind: "ENGINEERING" },
      ],
    },
    expectedInput: {
      drafts: [
        {
          lesson: "always scope by workspace",
          memoryKind: "ENGINEERING",
          memoryClass: "OBSERVATION",
          source: "user",
          nodeRef: "user-memory",
          sourceDocument: "",
          classified: false,
        },
      ],
    },
    invalidBody: { drafts: [] },
    status: 201,
  },
  {
    file: "agent.memory_import.parse",
    route: agentMemoryImportParseRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryImportParse.name,
    body: {
      documents: [{ filename: "notes.md", content: "# lessons\n- scope it" }],
    },
    invalidBody: { documents: [] },
    status: 200,
  },
  {
    file: "agent.memory_promotion.dismiss",
    route: agentMemoryPromotionDismissRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryPromotionDismiss.name,
    body: { memoryId: "m_1" },
    expectedInput: { memoryId: "m_1", restore: false },
    invalidBody: { memoryId: "" },
    status: 200,
  },
  {
    file: "agent.memory_promotion.list",
    route: agentMemoryPromotionCandidatesRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryPromotionCandidates.name,
    body: {},
    expectedInput: { limit: 3 },
    invalidBody: { limit: 99 },
    status: 200,
  },
  {
    file: "agent.memory_promotion.rationales",
    route: agentMemoryPromotionRationalesRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentMemoryPromotionRationales.name,
    body: { memoryId: "m_1", toClass: "RULE" },
    expectedInput: { memoryId: "m_1", toClass: "RULE", count: 4 },
    invalidBody: { memoryId: "m_1", toClass: "RULE", count: 1 },
    status: 200,
  },
  {
    file: "agent.role.assign",
    route: agentRoleAssignRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentRoleAssign.name,
    body: { agentId: "agt_1", roleName: "Agent Contributor" },
    invalidBody: { agentId: "agt_1" },
    status: 200,
  },
  {
    file: "agent.role.revoke",
    route: agentRoleRevokeRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentRoleRevoke.name,
    body: { agentId: "agt_1", roleName: "Agent Contributor" },
    invalidBody: { roleName: "" },
    status: 200,
  },
  {
    file: "billing.budget.get",
    route: billingBudgetGetRoute as unknown as Hono<never>,
    method: "GET",
    capability: billingBudgetGet.name,
    expectedInput: {},
    status: 200,
  },
  {
    file: "billing.budget.set",
    route: billingBudgetSetRoute as unknown as Hono<never>,
    method: "PUT",
    capability: billingBudgetSet.name,
    body: {
      scope: "workspace",
      enabled: true,
      period: "rolling",
      windowDays: 30,
      limitUsd: 250,
    },
    // The refinement rejects a rolling budget with no window.
    invalidBody: {
      scope: "workspace",
      enabled: true,
      period: "rolling",
      limitUsd: 250,
    },
    status: 200,
  },
  {
    file: "budget.policy.read",
    route: budgetPolicyReadRoute as unknown as Hono<never>,
    method: "GET",
    capability: budgetPolicyRead.name,
    expectedInput: {},
    status: 200,
  },
  {
    file: "budget.policy.write",
    route: budgetPolicyWriteRoute as unknown as Hono<never>,
    method: "PATCH",
    capability: budgetPolicyWrite.name,
    body: { enabled: true, limitUsd: 5, graceOveragePct: 0.25 },
    invalidBody: { graceOveragePct: 99 },
    status: 200,
  },
  {
    file: "chat.message.execution",
    route: chatMessageExecutionRoute as unknown as Hono<never>,
    method: "POST",
    capability: chatMessageExecution.name,
    body: {
      messageId: UUID,
      agentId: UUID,
      agentVersionId: UUID,
      originType: "chat",
      originId: UUID,
      status: "completed",
      inputPayload: { prompt: "hi" },
    },
    expectedInput: {
      messageId: UUID,
      agentId: UUID,
      agentVersionId: UUID,
      originType: "chat",
      originId: UUID,
      status: "completed",
      inputPayload: { prompt: "hi" },
      updateMessageMetadata: true,
    },
    invalidBody: { messageId: "not-a-uuid" },
    status: 200,
  },
  {
    file: "context.record.promote",
    route: contextRecordPromoteRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextRecordPromote.name,
    body: {
      record_id: "ctr_1",
      action: "promote",
      version_id: "crv_1",
      policy_version: "2026.09",
    },
    // `.strict()` — an unknown key is a rejection, not a silent drop.
    invalidBody: {
      record_id: "ctr_1",
      action: "promote",
      policy_version: "2026.09",
      unexpected: true,
    },
    status: 200,
  },
  {
    file: "context.record.publish",
    route: contextRecordPublishRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextRecordPublish.name,
    body: { record_id: "no-raw-db", title: "No raw db()", body: "[rule]\n" },
    invalidBody: { record_id: "no-raw-db", title: "", body: "x" },
    status: 200,
  },
  {
    file: "conversation.attachment.add",
    route: conversationAttachmentAddRoute as unknown as Hono<never>,
    method: "POST",
    capability: conversationAttachmentAdd.name,
    body: { conversationId: "cnv_1", assetPublicId: "gen_1" },
    invalidBody: { conversationId: "cnv_1" },
    status: 200,
  },
  {
    file: "conversation.chat",
    route: conversationChatRoute as unknown as Hono<never>,
    method: "POST",
    capability: conversationChat.name,
    body: { conversation_id: "cnv_1", message: "hello" },
    invalidBody: { message: "hello" },
    status: 200,
  },
  {
    file: "tool.declaration.publish",
    route: toolDeclarationPublishRoute as unknown as Hono<never>,
    method: "POST",
    capability: toolDeclarationPublish.name,
    body: {
      name: "read_file",
      description: "reads a file",
      input_schema: { type: "object" },
      risk_grade: "low",
      source: "builtin",
      manifest: { v: 1 },
    },
    expectedInput: {
      name: "read_file",
      description: "reads a file",
      input_schema: { type: "object" },
      risk_grade: "low",
      source: "builtin",
      manifest: { v: 1 },
      read_only: false,
    },
    invalidBody: {
      name: "read_file",
      description: "reads a file",
      input_schema: { type: "object" },
      risk_grade: "nuclear",
      source: "builtin",
      manifest: {},
    },
    status: 200,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(CTX);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function call(entry: ThinRoute, body: unknown): Promise<Response> {
  const init: RequestInit =
    entry.method === "GET"
      ? { method: "GET" }
      : {
          method: entry.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  return await entry.route.fetch(new Request("http://localhost/", init));
}

describe("thin capability routes", () => {
  it.each(ROUTES.map((r) => [r.file, r] as const))(
    "%s dispatches its contract through invoke",
    async (_file, entry) => {
      const res = await call(entry, entry.body);

      expect(res.status).toBe(entry.status);
      expect(await res.json()).toEqual(OUTPUT);
      expect(mocks.invoke).toHaveBeenCalledWith(
        entry.capability,
        entry.expectedInput ?? entry.body,
        CTX,
        { surface: "api" },
      );
    },
  );

  it.each(
    ROUTES.filter((r) => r.invalidBody !== undefined).map(
      (r) => [r.file, r] as const,
    ),
  )("%s rejects a body its contract does not accept", async (_file, entry) => {
    const res = await call(entry, entry.invalidBody);

    expect(res.status).not.toBe(entry.status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
