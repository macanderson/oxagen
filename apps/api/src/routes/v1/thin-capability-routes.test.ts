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

import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { agentDefinitionCommit } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { agentDefinitionDelete } from "@oxagen/oxagen/contracts/agent.definition.delete";
import { agentDefinitionRevise } from "@oxagen/oxagen/contracts/agent.definition.revise";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { agentDefinitionSummarize } from "@oxagen/oxagen/contracts/agent.definition.summarize";
import { agentEnvironmentBind } from "@oxagen/oxagen/contracts/agent.environment.bind";
import { agentGet } from "@oxagen/oxagen/contracts/agent.get";
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
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
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { agentRoleAssign } from "@oxagen/oxagen/contracts/agent.role.assign";
import { agentRoleRevoke } from "@oxagen/oxagen/contracts/agent.role.revoke";
import { agentSuspend } from "@oxagen/oxagen/contracts/agent.suspend";
import { agentToolbeltGet } from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { billingAutoTopupSet } from "@oxagen/oxagen/contracts/billing.auto_topup.set";
import { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import { billingGauBucketGet } from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import { billingGauBucketPurchase } from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import { budgetPolicyRead } from "@oxagen/oxagen/contracts/budget.policy.read";
import { budgetPolicyWrite } from "@oxagen/oxagen/contracts/budget.policy.write";
import { chatMessageExecution } from "@oxagen/oxagen/contracts/chat.message.execution";
import { contextRecordPromote } from "@oxagen/oxagen/contracts/context.record.promote";
import { contextRecordPublish } from "@oxagen/oxagen/contracts/context.record.publish";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { contextRecordsGet } from "@oxagen/oxagen/contracts/context.records.get";
import { contextRecordsAppend } from "@oxagen/oxagen/contracts/context.records.append";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { conversationAttachmentAdd } from "@oxagen/oxagen/contracts/conversation.attachment.add";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { tachoCommandList } from "@oxagen/oxagen/contracts/tacho.command.list";
import { iamRoleCreate } from "@oxagen/oxagen/contracts/iam.role.create";
import { iamRoleGrantsSet } from "@oxagen/oxagen/contracts/iam.role.grants.set";
import { iamRoleDelete } from "@oxagen/oxagen/contracts/iam.role.delete";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { conversationChat } from "@oxagen/oxagen/contracts/conversation.chat";
import { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { findingDismiss } from "@oxagen/oxagen/contracts/finding.dismiss";
import { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import { findingFixRecord } from "@oxagen/oxagen/contracts/finding.fix.record";
import { findingList } from "@oxagen/oxagen/contracts/finding.list";
import { toolDeclarationPublish } from "@oxagen/oxagen/contracts/tool.declaration.publish";

import { agentCredentialRotateRoute } from "./agent.credential.rotate";
import { agentDefinitionCommitRoute } from "./agent.definition.commit";
import { agentDefinitionDeleteRoute } from "./agent.definition.delete";
import { agentDefinitionReviseRoute } from "./agent.definition.revise";
import { agentDefinitionSuggestRoute } from "./agent.definition.suggest";
import { agentDefinitionSummarizeRoute } from "./agent.definition.summarize";
import { agentEnvironmentBindRoute } from "./agent.environment.bind";
import { agentGetRoute } from "./agent.get";
import { agentListRoute } from "./agent.list";
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
import { agentRegisterRoute } from "./agent.register";
import { agentRetireRoute } from "./agent.retire";
import { agentRoleAssignRoute } from "./agent.role.assign";
import { agentRoleRevokeRoute } from "./agent.role.revoke";
import { agentSuspendRoute } from "./agent.suspend";
import { agentToolbeltGetRoute } from "./agent.toolbelt.get";
import { apiKeyListRoute } from "./api.key.list";
import { billingBudgetGetRoute } from "./billing.budget.get";
import { billingAutoTopupSetRoute } from "./billing.auto_topup.set";
import { billingContractRateGetRoute } from "./billing.contract_rate.get";
import { billingGauBucketGetRoute } from "./billing.gau_bucket.get";
import { billingGauBucketPurchaseRoute } from "./billing.gau_bucket.purchase";
import { billingInvoiceListRoute } from "./billing.invoice.list";
import { billingBudgetSetRoute } from "./billing.budget.set";
import { budgetPolicyReadRoute } from "./budget.policy.read";
import { budgetPolicyWriteRoute } from "./budget.policy.write";
import { chatMessageExecutionRoute } from "./chat.message.execution";
import { contextRecordPromoteRoute } from "./context.record.promote";
import { contextRecordPublishRoute } from "./context.record.publish";
import { contextRecordsListRoute } from "./context.records.list";
import { contextRecordsGetRoute } from "./context.records.get";
import { contextRecordsAppendRoute } from "./context.records.append";
import { contextProposalCreateRoute } from "./context.proposal.create";
import { contextProposalListRoute } from "./context.proposal.list";
import { contextProposalDismissRoute } from "./context.proposal.dismiss";
import { contextPrOpenRoute } from "./context.pr.open";
import { contextPrGetRoute } from "./context.pr.get";
import { contextPrMergeRoute } from "./context.pr.merge";
import { conversationAttachmentAddRoute } from "./conversation.attachment.add";
import { conversationChatRoute } from "./conversation.chat";
import { costPriceEntryListRoute } from "./cost.price_entry.list";
import { runCostGetRoute } from "./run.cost";
import { spendDrillRoute } from "./spend.drill";
import { spendGetRoute } from "./spend.get";
import { spendStatementExportRoute } from "./spend.statement.export";
import { auditEventsExportRoute } from "./audit.events.export";
import { spendWasteListRoute } from "./spend.waste";
import { findingDismissRoute } from "./finding.dismiss";
import { findingEvidenceGetRoute } from "./finding.evidence.get";
import { findingFixRecordRoute } from "./finding.fix.record";
import { findingListRoute } from "./finding.list";
import { tachoCommandDispatchRoute } from "./tacho.command.dispatch";
import { tachoCommandListRoute } from "./tacho.command.list";
import { iamRoleCreateRoute } from "./iam.role.create";
import { iamRoleGrantsSetRoute } from "./iam.role.grants.set";
import { iamRoleDeleteRoute } from "./iam.role.delete";
import { workspaceArchiveRoute } from "./workspace.archive";
import { tachoIncidentListRoute } from "./tacho.incident.list";
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
  // Steering (ADR-061).
  {
    file: "context.records.list",
    route: contextRecordsListRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextRecordsList.name,
    body: { kind: "rule" },
    expectedInput: { kind: "rule", limit: 50, offset: 0 },
    invalidBody: { kind: "directive" },
    status: 200,
  },
  {
    file: "context.records.get",
    route: contextRecordsGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextRecordsGet.name,
    body: { recordId: "ctx.release.notes-format" },
    invalidBody: {},
    status: 200,
  },
  {
    file: "context.records.append",
    route: contextRecordsAppendRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextRecordsAppend.name,
    body: { kind: "observation", lineageId: "ctx.a", statement: "x" },
    expectedInput: {
      kind: "observation",
      lineageId: "ctx.a",
      statement: "x",
      sharingScope: "workspace",
      sourceRefs: [],
      evidenceLinks: [],
    },
    invalidBody: { kind: "rule", lineageId: "ctx.a", statement: "x" },
    status: 200,
  },
  {
    file: "context.proposal.create",
    route: contextProposalCreateRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextProposalCreate.name,
    body: {
      record: {
        lineageId: "ctx.a",
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: "x",
      },
      rationale: "why",
    },
    expectedInput: {
      record: {
        lineageId: "ctx.a",
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: "x",
      },
      rationale: "why",
      support: { runs: [], agents: [], recordIds: [], evidenceLinks: [] },
    },
    invalidBody: {
      record: {
        lineageId: "ctx.a",
        kind: "constraint",
        force: "must",
        sharingScope: "workspace",
        statement: "x",
      },
      rationale: "why",
    },
    status: 200,
  },
  {
    file: "context.proposal.list",
    route: contextProposalListRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextProposalList.name,
    body: {},
    expectedInput: { limit: 50, offset: 0 },
    invalidBody: { status: "candidate" },
    status: 200,
  },
  {
    file: "context.proposal.dismiss",
    route: contextProposalDismissRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextProposalDismiss.name,
    body: { proposalId: "prp_1", reason: "duplicate" },
    invalidBody: { proposalId: "prp_1" },
    status: 200,
  },
  {
    file: "context.pr.open",
    route: contextPrOpenRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextPrOpen.name,
    body: { proposalId: "prp_1" },
    invalidBody: { proposalId: "ctr_1" },
    status: 200,
  },
  {
    file: "context.pr.get",
    route: contextPrGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextPrGet.name,
    body: { proposalId: "prp_1" },
    invalidBody: {},
    status: 200,
  },
  {
    file: "context.pr.merge",
    route: contextPrMergeRoute as unknown as Hono<never>,
    method: "POST",
    capability: contextPrMerge.name,
    body: { proposalId: "prp_1" },
    invalidBody: { proposalId: "prp_1", force: true },
    status: 200,
  },
  {
    file: "agent.list",
    route: agentListRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentList.name,
    body: { limit: 10 },
    invalidBody: { limit: 0 },
    status: 200,
  },
  {
    file: "agent.get",
    route: agentGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentGet.name,
    body: { agentId: "release-bot" },
    invalidBody: {},
    status: 200,
  },
  {
    file: "agent.register",
    route: agentRegisterRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentRegister.name,
    body: { slug: "release-bot", name: "Release bot", harness: "stella" },
    expectedInput: {
      slug: "release-bot",
      name: "Release bot",
      harness: "stella",
      validityDays: 180,
    },
    // The slug regex refuses an upper-case slug.
    invalidBody: {
      slug: "Release-Bot",
      name: "Release bot",
      harness: "stella",
    },
    status: 200,
  },
  {
    file: "agent.credential.rotate",
    route: agentCredentialRotateRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentCredentialRotate.name,
    body: { agentId: "agt_1", validityDays: 30 },
    invalidBody: { agentId: "agt_1", validityDays: 400 },
    status: 200,
  },
  {
    file: "agent.suspend",
    route: agentSuspendRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentSuspend.name,
    body: { agentId: "agt_1" },
    expectedInput: { agentId: "agt_1", suspended: true },
    invalidBody: { agentId: "agt_1", suspended: "yes" },
    status: 200,
  },
  {
    file: "agent.retire",
    route: agentRetireRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentRetire.name,
    body: { agentId: "agt_1", reason: "decommissioned" },
    invalidBody: {},
    status: 200,
  },
  {
    file: "agent.definition.commit",
    route: agentDefinitionCommitRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentDefinitionCommit.name,
    body: {
      agentId: "agt_1",
      branch: "agents/release-bot",
      source: 'schema = "agent-definition/v0.1"\nslug = "release-bot"\n',
    },
    // `..` is not a git branch name.
    invalidBody: {
      agentId: "agt_1",
      branch: "agents/../main",
      source: 'schema = "agent-definition/v0.1"\n',
    },
    status: 200,
  },
  {
    file: "agent.toolbelt.get",
    route: agentToolbeltGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentToolbeltGet.name,
    body: { agentId: "agt_1", mode: "searchable" },
    invalidBody: { agentId: "agt_1", mode: "compact" },
    status: 200,
  },
  {
    file: "tacho.incident.list",
    route: tachoIncidentListRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoIncidentList.name,
    body: { open: true, limit: 20 },
    invalidBody: { open: "yes" },
    status: 200,
  },
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
    file: "api.key.list",
    route: apiKeyListRoute as unknown as Hono<never>,
    method: "GET",
    capability: apiKeyList.name,
    expectedInput: {},
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
    file: "billing.contract_rate.get",
    route: billingContractRateGetRoute as unknown as Hono<never>,
    method: "GET",
    capability: billingContractRateGet.name,
    expectedInput: {},
    status: 200,
  },
  {
    file: "billing.gau_bucket.get",
    route: billingGauBucketGetRoute as unknown as Hono<never>,
    method: "GET",
    capability: billingGauBucketGet.name,
    expectedInput: {},
    status: 200,
  },
  {
    file: "billing.gau_bucket.purchase",
    route: billingGauBucketPurchaseRoute as unknown as Hono<never>,
    method: "POST",
    capability: billingGauBucketPurchase.name,
    body: {
      quantityGau: 10_000,
      successPath: "/acme/billing?checkout=success",
      cancelPath: "/acme/billing?checkout=cancel",
    },
    invalidBody: {
      quantityGau: 10_000,
      successPath: "https://evil.example/",
      cancelPath: "/acme/billing",
    },
    status: 200,
  },
  {
    file: "billing.invoice.list",
    route: billingInvoiceListRoute as unknown as Hono<never>,
    method: "POST",
    capability: billingInvoiceList.name,
    body: { limit: 10 },
    invalidBody: { limit: 0 },
    status: 200,
  },
  {
    file: "billing.auto_topup.set",
    route: billingAutoTopupSetRoute as unknown as Hono<never>,
    method: "PUT",
    capability: billingAutoTopupSet.name,
    body: { enabled: true, blocks: 2 },
    invalidBody: { enabled: true, blocks: 0 },
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
      limit: { micros: "250000000", currency: "USD" },
    },
    // The refinement rejects a rolling budget with no window.
    invalidBody: {
      scope: "workspace",
      enabled: true,
      period: "rolling",
      limit: { micros: "250000000", currency: "USD" },
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
    file: "tacho.command.dispatch",
    route: tachoCommandDispatchRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoCommandDispatch.name,
    body: { target: { kind: "run", id: "tse_a1b2c3" }, command: "pause" },
    // `expiresInMs` defaults in the contract, so the handler sees a field the
    // request never sent — assert the resolved input, not the body.
    expectedInput: {
      target: { kind: "run", id: "tse_a1b2c3" },
      command: "pause",
      expiresInMs: 3_600_000,
    },
    // `steer` carries prompt content, so the contract's cross-field refine
    // refuses it with no payload. A shape error would be caught by any
    // invalid body; this one proves the refine runs in the adapter too.
    invalidBody: {
      target: { kind: "run", id: "tse_a1b2c3" },
      command: "steer",
    },
    status: 201,
  },
  {
    file: "tacho.command.list",
    route: tachoCommandListRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoCommandList.name,
    body: { runId: "tse_a1b2c3" },
    expectedInput: { runId: "tse_a1b2c3", limit: 50 },
    invalidBody: { runId: "not-a-run-id" },
    status: 200,
  },
  {
    file: "iam.role.create",
    route: iamRoleCreateRoute as unknown as Hono<never>,
    method: "POST",
    capability: iamRoleCreate.name,
    body: {
      name: "agent.release",
      scopeKind: "workspace",
      permissions: ["run.read"],
    },
    expectedInput: {
      name: "agent.release",
      scopeKind: "workspace",
      description: null,
      permissions: ["run.read"],
    },
    invalidBody: {
      name: "agent.release",
      scopeKind: "workspace",
      permissions: ["org.*"],
    },
    status: 201,
  },
  {
    file: "iam.role.grants.set",
    route: iamRoleGrantsSetRoute as unknown as Hono<never>,
    method: "POST",
    capability: iamRoleGrantsSet.name,
    body: { roleId: "rol_1", permissions: ["run.read"] },
    invalidBody: { roleId: "rol_1", permissions: [] },
    status: 200,
  },
  {
    file: "iam.role.delete",
    route: iamRoleDeleteRoute as unknown as Hono<never>,
    method: "POST",
    capability: iamRoleDelete.name,
    body: { roleId: "rol_1" },
    invalidBody: { roleId: "Owner" },
    status: 200,
  },
  {
    file: "workspace.archive",
    route: workspaceArchiveRoute as unknown as Hono<never>,
    method: "POST",
    capability: workspaceArchive.name,
    body: { workspaceId: "wrk_1" },
    invalidBody: { workspaceId: "core" },
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
  {
    file: "spend.get",
    route: spendGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: spendGet.name,
    body: {
      period: { from: "2026-09-01", to: "2026-09-30" },
      groupBy: "operator",
    },
    invalidBody: {
      period: { from: "2026-09-30", to: "2026-09-01" },
      groupBy: "operator",
    },
    status: 200,
  },
  {
    file: "spend.drill",
    route: spendDrillRoute as unknown as Hono<never>,
    method: "POST",
    capability: spendDrill.name,
    body: { kind: "agent", key: "acme.core.cc" },
    expectedInput: { kind: "agent", key: "acme.core.cc", days: 30 },
    invalidBody: { kind: "model", key: "claude-sonnet-5" },
    status: 200,
  },
  {
    file: "spend.waste",
    route: spendWasteListRoute as unknown as Hono<never>,
    method: "POST",
    capability: spendWasteList.name,
    body: { period: { from: "2026-09-01", to: "2026-09-30" } },
    invalidBody: { period: { from: "2026-02-30", to: "2026-03-01" } },
    status: 200,
  },
  {
    file: "finding.list",
    route: findingListRoute as unknown as Hono<never>,
    method: "POST",
    capability: findingList.name,
    body: {},
    expectedInput: { status: "open" },
    invalidBody: { status: "stale" },
    status: 200,
  },
  {
    file: "finding.evidence.get",
    route: findingEvidenceGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: findingEvidenceGet.name,
    body: { findingId: "fnd_0123456789abcdefghjkmn" },
    invalidBody: { findingId: "0192d4a8-7c1e-7a00-8000-000000000001" },
    status: 200,
  },
  {
    file: "finding.fix.record",
    route: findingFixRecordRoute as unknown as Hono<never>,
    method: "POST",
    capability: findingFixRecord.name,
    body: { findingId: "fnd_0123456789abcdefghjkmn" },
    invalidBody: { findingId: "0192d4a8-7c1e-7a00-8000-000000000001" },
    status: 200,
  },
  {
    file: "finding.dismiss",
    route: findingDismissRoute as unknown as Hono<never>,
    method: "POST",
    capability: findingDismiss.name,
    body: { findingId: "fnd_0123456789abcdefghjkmn" },
    invalidBody: { findingId: "0192d4a8-7c1e-7a00-8000-000000000001" },
    status: 200,
  },
  {
    file: "spend.statement.export",
    route: spendStatementExportRoute as unknown as Hono<never>,
    method: "POST",
    capability: spendStatementExport.name,
    body: { month: "2026-09" },
    expectedInput: { month: "2026-09", format: "csv" },
    invalidBody: { month: "2026-13" },
    status: 200,
  },
  {
    file: "audit.events.export",
    route: auditEventsExportRoute as unknown as Hono<never>,
    method: "POST",
    capability: auditEventsExport.name,
    body: { outcome: "deny" },
    expectedInput: { outcome: "deny", format: "csv" },
    invalidBody: { format: "pdf" },
    status: 200,
  },
  {
    file: "run.cost",
    route: runCostGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: runCostGet.name,
    body: { runId: "tse_0192d4a87c1e7a0080000000" },
    invalidBody: { runId: "run_1" },
    status: 200,
  },
  {
    file: "cost.price_entry.list",
    route: costPriceEntryListRoute as unknown as Hono<never>,
    method: "POST",
    capability: costPriceEntryList.name,
    body: { at: "2026-09-14T00:00:00.000Z" },
    invalidBody: { at: "yesterday" },
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
