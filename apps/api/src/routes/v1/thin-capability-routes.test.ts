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
  extractClientIp: () => null,
}));
// Routes that carry their own limiter (tacho.host.enroll) are tested as
// adapters here; the limiter has its own suite.
vi.mock("../../middleware/distributed-rate-limit", () => ({
  distributedRateLimiter:
    () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
  // Routes pass this to `distributedRateLimiter` at module scope, so the mock
  // has to carry it even though the stubbed limiter never calls it.
  trustedClientIpBucketKey: () => null,
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
import { billingPrepaidOrderList } from "@oxagen/oxagen/contracts/billing.prepaid_order.list";
import { billingStatementGet } from "@oxagen/oxagen/contracts/billing.statement.get";
import { billingStatementExport } from "@oxagen/oxagen/contracts/billing.statement.export";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import { toolImport } from "@oxagen/oxagen/contracts/tool.import";
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { killSwitchSet } from "@oxagen/oxagen/contracts/kill_switch.set";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
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
import { skillPropose } from "@oxagen/oxagen/contracts/skill.propose";
import { agentPropose } from "@oxagen/oxagen/contracts/agent.propose";
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { conversationAttachmentAdd } from "@oxagen/oxagen/contracts/conversation.attachment.add";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { tachoCommandList } from "@oxagen/oxagen/contracts/tacho.command.list";
import { iamRoleCreate } from "@oxagen/oxagen/contracts/iam.role.create";
import { iamRoleGrantsSet } from "@oxagen/oxagen/contracts/iam.role.grants.set";
import { iamRoleDelete } from "@oxagen/oxagen/contracts/iam.role.delete";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { onboardingAdvance } from "@oxagen/oxagen/contracts/onboarding.advance";
import { onboardingFirstFrameGet } from "@oxagen/oxagen/contracts/onboarding.first_frame.get";
import { onboardingStateGet } from "@oxagen/oxagen/contracts/onboarding.state.get";
import { repositoryMainBind } from "@oxagen/oxagen/contracts/repository.main.bind";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import { repositoryProductionBranchSet } from "@oxagen/oxagen/contracts/repository.production_branch.set";
import { repositoryInitPrOpen } from "@oxagen/oxagen/contracts/repository.init_pr.open";
import { tachoEnrollmentTokenCreate } from "@oxagen/oxagen/contracts/tacho.enrollment_token.create";
import { tachoHostEnroll } from "@oxagen/oxagen/contracts/tacho.host.enroll";
import { conversationChat } from "@oxagen/oxagen/contracts/conversation.chat";
import { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { costUnpricedModelList } from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import { costPriceEntrySet } from "@oxagen/oxagen/contracts/cost.price_entry.set";
import { costPriceEntryRemove } from "@oxagen/oxagen/contracts/cost.price_entry.remove";
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import { spendCostCenterStatementExport } from "@oxagen/oxagen/contracts/spend.cost_center_statement.export";
import { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import { costCenterCreate } from "@oxagen/oxagen/contracts/cost_center.create";
import { costCenterDelete } from "@oxagen/oxagen/contracts/cost_center.delete";
import { costCenterSet } from "@oxagen/oxagen/contracts/cost_center.set";
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/contracts/audit.log.query";
import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { findingDismiss } from "@oxagen/oxagen/contracts/finding.dismiss";
import { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import { findingFixRecord } from "@oxagen/oxagen/contracts/finding.fix.record";
import { findingList } from "@oxagen/oxagen/contracts/finding.list";
import { toolDeclarationPublish } from "@oxagen/oxagen/contracts/tool.declaration.publish";
import { mandateGet } from "@oxagen/oxagen/contracts/mandate.get";
import { mandateGrant } from "@oxagen/oxagen/contracts/mandate.grant";
import { mandateLimitsUpdate } from "@oxagen/oxagen/contracts/mandate.limits.update";
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { approvalRuleSet } from "@oxagen/oxagen/contracts/approval_rule.set";
import { approvalRuleDelete } from "@oxagen/oxagen/contracts/approval_rule.delete";
import { approvalRuleEnabledSet } from "@oxagen/oxagen/contracts/approval_rule.enabled.set";
import { approvalAutoEligibilityGet } from "@oxagen/oxagen/contracts/approval.auto_eligibility.get";
import { mandateRequest } from "@oxagen/oxagen/contracts/mandate.request";
import { mandateRevoke } from "@oxagen/oxagen/contracts/mandate.revoke";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { runSeal } from "@oxagen/oxagen/contracts/run.seal";
import { tachoEnrollmentCreate } from "@oxagen/oxagen/contracts/tacho.enrollment.create";
import { tachoEnrollmentRevoke } from "@oxagen/oxagen/contracts/tacho.enrollment.revoke";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import { tachoSessionGet } from "@oxagen/oxagen/contracts/tacho.session.get";
import { tachoSessionList } from "@oxagen/oxagen/contracts/tacho.session.list";

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
import { billingPrepaidOrderListRoute } from "./billing.prepaid_order.list";
import { billingStatementGetRoute } from "./billing.statement.get";
import { billingStatementExportRoute } from "./billing.statement.export";
import { toolVersionListRoute } from "./tool.version.list";
import { toolClassificationSetRoute } from "./tool.classification.set";
import { toolImportRoute } from "./tool.import";
import { credentialGrantListRoute } from "./credential.grant.list";
import { killSwitchSetRoute } from "./kill_switch.set";
import { killSwitchListRoute } from "./kill_switch.list";
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
import { skillProposeRoute } from "./skill.propose";
import { agentProposeRoute } from "./agent.propose";
import { contextPrGetRoute } from "./context.pr.get";
import { contextPrMergeRoute } from "./context.pr.merge";
import { conversationAttachmentAddRoute } from "./conversation.attachment.add";
import { conversationChatRoute } from "./conversation.chat";
import { costPriceEntryListRoute } from "./cost.price_entry.list";
import { costUnpricedModelListRoute } from "./cost.unpriced_model.list";
import { costPriceEntrySetRoute } from "./cost.price_entry.set";
import { costPriceEntryRemoveRoute } from "./cost.price_entry.remove";
import { runCostGetRoute } from "./run.cost";
import { spendDrillRoute } from "./spend.drill";
import { spendGetRoute } from "./spend.get";
import { spendStatementExportRoute } from "./spend.statement.export";
import { spendCostCenterStatementExportRoute } from "./spend.cost_center_statement.export";
import { costCenterListRoute } from "./cost_center.list";
import { costCenterCreateRoute } from "./cost_center.create";
import { costCenterDeleteRoute } from "./cost_center.delete";
import { costCenterSetRoute } from "./cost_center.set";
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
import { assistantAsk } from "@oxagen/oxagen/contracts/assistant.ask";
import { assistantEngineGet } from "@oxagen/oxagen/contracts/assistant.engine.get";
import { assistantReplyFeedbackRecord } from "@oxagen/oxagen/contracts/assistant.reply_feedback.record";
import { assistantTurnCancel } from "@oxagen/oxagen/contracts/assistant.turn.cancel";
import { toolsSearch } from "@oxagen/oxagen/contracts/tools.search";
import { toolsLoad } from "@oxagen/oxagen/contracts/tools.load";
import { shellNavCountsGet } from "@oxagen/oxagen/contracts/shell.nav_counts.get";
import { runRecentList } from "@oxagen/oxagen/contracts/run.recent.list";
import { userPreferencesSet } from "@oxagen/oxagen/contracts/user.preferences.set";
import { assistantAskRoute } from "./assistant.ask";
import { assistantEngineGetRoute } from "./assistant.engine.get";
import { assistantReplyFeedbackRecordRoute } from "./assistant.reply_feedback.record";
import { assistantTurnCancelRoute } from "./assistant.turn.cancel";
import { toolsSearchRoute } from "./tools.search";
import { toolsLoadRoute } from "./tools.load";
import { shellNavCountsGetRoute } from "./shell.nav_counts.get";
import { runRecentListRoute } from "./run.recent.list";
import { userPreferencesSetRoute } from "./user.preferences.set";
import { onboardingAdvanceRoute } from "./onboarding.advance";
import { onboardingFirstFrameGetRoute } from "./onboarding.first_frame.get";
import { onboardingStateGetRoute } from "./onboarding.state.get";
import { repositoryMainBindRoute } from "./repository.main.bind";
import { repositoryLinkRoute } from "./repository.link";
import { repositoryUnlinkRoute } from "./repository.unlink";
import { repositoryListRoute } from "./repository.list";
import { repositoryTreeGetRoute } from "./repository.tree.get";
import { repositoryProductionBranchSetRoute } from "./repository.production_branch.set";
import { repositoryInitPrOpenRoute } from "./repository.init_pr.open";
import { tachoEnrollmentTokenCreateRoute } from "./tacho.enrollment_token.create";
import { tachoHostEnrollRoute } from "./tacho.host.enroll";
import { toolDeclarationPublishRoute } from "./tool.declaration.publish";
import { mandateGetRoute } from "./mandate.get";
import { mandateGrantRoute } from "./mandate.grant";
import { mandateLimitsUpdateRoute } from "./mandate.limits.update";
import { mandateListRoute } from "./mandate.list";
import { approvalRuleListRoute } from "./approval_rule.list";
import { approvalRuleSetRoute } from "./approval_rule.set";
import { approvalRuleDeleteRoute } from "./approval_rule.delete";
import { approvalRuleEnabledSetRoute } from "./approval_rule.enabled.set";
import { approvalAutoEligibilityGetRoute } from "./approval.auto_eligibility.get";
import { mandateRequestRoute } from "./mandate.request";
import { mandateRevokeRoute } from "./mandate.revoke";
import { runGetRoute } from "./run.get";
import { runListRoute } from "./run.list";
import { runSealRoute } from "./run.seal";
import { tachoEnrollmentCreateRoute } from "./tacho.enrollment.create";
import { tachoEnrollmentRevokeRoute } from "./tacho.enrollment.revoke";
import { tachoHostListRoute } from "./tacho.host.list";
import { tachoSessionGetRoute } from "./tacho.session.get";
import { tachoSessionListRoute } from "./tacho.session.list";

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
const HOST_ENROLLMENT_ID = "tch_0123456789abcdefghijkl";
/** A Tacho enrollment's required fields; the contract defaults the rest. */
const ENROLLMENT_BODY = {
  hostname: "build-01.acme.internal",
  osUser: "runner",
  platform: "darwin",
  devicePublicKey: `ed25519:${"A".repeat(42)}==`,
  harnesses: ["claude-code"],
};

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
  /**
   * The capability context `invoke` should receive — defaults to CTX. Set it
   * where the route deliberately sends something else, as the audit export
   * does with the organization-only workspace sentinel.
   */
  expectedCtx?: Record<string, unknown>;
  /** A body the contract must reject. Omitted for bodyless GET routes. */
  invalidBody?: unknown;
  /**
   * The handler wraps `c.req.json()` in a try/catch that answers 400 rather
   * than letting a parse error reach the error middleware. Set it where the
   * handler has that guard, and a malformed body is asserted to stop there.
   */
  jsonGuard?: true;
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
    file: "skill.propose",
    route: skillProposeRoute as unknown as Hono<never>,
    method: "POST",
    capability: skillPropose.name,
    body: {
      origin: "describe",
      name: "release-notes",
      body: "---\nname: release-notes\nversion: 0.1.0\nscope: workspace:core\n---\n",
    },
    expectedInput: {
      origin: "describe",
      name: "release-notes",
      body: "---\nname: release-notes\nversion: 0.1.0\nscope: workspace:core\n---\n",
      files: [],
    },
    invalidBody: { origin: "describe", name: "Release Notes", body: "x" },
    status: 200,
  },
  {
    file: "agent.propose",
    route: agentProposeRoute as unknown as Hono<never>,
    method: "POST",
    capability: agentPropose.name,
    body: {
      slug: "perf-watch",
      harness: "cursor",
      source: 'schema = "agent-definition/v0.1"\n',
    },
    invalidBody: { slug: "Perf Watch", harness: "cursor", source: "x" },
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
    jsonGuard: true,
    status: 200,
  },
  {
    file: "billing.prepaid_order.list",
    route: billingPrepaidOrderListRoute as unknown as Hono<never>,
    method: "POST",
    capability: billingPrepaidOrderList.name,
    body: { limit: 10 },
    invalidBody: { limit: 101 },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "billing.statement.get",
    route: billingStatementGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: billingStatementGet.name,
    body: { period: "month", anchor: "2026-09-01" },
    expectedInput: { period: "month", anchor: "2026-09-01", top: 25 },
    invalidBody: { period: "fortnight", anchor: "2026-09-01" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "billing.statement.export",
    route: billingStatementExportRoute as unknown as Hono<never>,
    method: "POST",
    capability: billingStatementExport.name,
    body: { period: "quarter", anchor: "2026-07-01", format: "html" },
    expectedInput: {
      period: "quarter",
      anchor: "2026-07-01",
      format: "html",
      limit: 10_000,
    },
    invalidBody: { period: "quarter", anchor: "2026-07-01", format: "pdf" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "tool.version.list",
    route: toolVersionListRoute as unknown as Hono<never>,
    method: "POST",
    capability: toolVersionList.name,
    body: { limit: 10, category: "moves_money" },
    invalidBody: { category: "Moves Money" },
    status: 200,
  },
  {
    file: "tool.classification.set",
    route: toolClassificationSetRoute as unknown as Hono<never>,
    method: "PUT",
    capability: toolClassificationSet.name,
    body: {
      toolVersionId: "tlv_1",
      riskGrade: "high",
      classification: {
        sideEffect: "write",
        egress: "third_party",
        consequenceTags: ["communicates_externally"],
        measures: {},
        dataClasses: [],
      },
      reason: "sends mail",
    },
    invalidBody: { toolVersionId: "tlv_1", riskGrade: "high", reason: "x" },
    status: 200,
  },
  {
    file: "tool.import",
    route: toolImportRoute as unknown as Hono<never>,
    method: "POST",
    capability: toolImport.name,
    body: { serverId: "mcs_1", tools: ["search"] },
    invalidBody: { serverId: "mcs_1", tools: [] },
    status: 200,
  },
  {
    file: "credential.grant.list",
    route: credentialGrantListRoute as unknown as Hono<never>,
    method: "POST",
    capability: credentialGrantList.name,
    body: { limit: 5 },
    invalidBody: { limit: 0 },
    status: 200,
  },
  {
    file: "kill_switch.set",
    route: killSwitchSetRoute as unknown as Hono<never>,
    method: "PUT",
    capability: killSwitchSet.name,
    body: {
      target: { kind: "class", id: "moves_money" },
      on: true,
      reason: "processor incident",
    },
    invalidBody: { target: { kind: "class", id: "moves_money" }, on: true },
    status: 200,
  },
  {
    file: "kill_switch.list",
    route: killSwitchListRoute as unknown as Hono<never>,
    method: "POST",
    capability: killSwitchList.name,
    body: { onlyOn: true, limit: 10 },
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
    jsonGuard: true,
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
    // #3302: kind/force/statement are required on every publish.
    body: {
      record_id: "no-raw-db",
      title: "No raw db()",
      body: "[rule]\n",
      kind: "rule",
      force: "should",
      statement: "No raw db() calls in handlers.",
    },
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
    jsonGuard: true,
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
    jsonGuard: true,
    status: 200,
  },
  // The shell (#2968): the in-app agent's turn and engine probe, the command
  // menu's search, belt definitions and recent runs, the sidebar counts, the
  // account preferences.
  {
    file: "assistant.ask",
    route: assistantAskRoute as unknown as Hono<never>,
    method: "POST",
    capability: assistantAsk.name,
    body: { content: "explain this run" },
    expectedInput: {
      content: "explain this run",
      conversationId: null,
      pageContext: null,
    },
    invalidBody: { content: "" },
    status: 200,
  },
  {
    file: "assistant.turn.cancel",
    route: assistantTurnCancelRoute as unknown as Hono<never>,
    method: "POST",
    capability: assistantTurnCancel.name,
    body: { turnId: "0192d4a8-7c1e-7a00-8000-0000000000f1" },
    invalidBody: { turnId: "not-a-uuid" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "assistant.engine.get",
    route: assistantEngineGetRoute as unknown as Hono<never>,
    method: "GET",
    capability: assistantEngineGet.name,
    body: {},
    status: 200,
  },
  {
    file: "assistant.reply_feedback.record",
    route: assistantReplyFeedbackRecordRoute as unknown as Hono<never>,
    method: "POST",
    capability: assistantReplyFeedbackRecord.name,
    body: {
      conversationId: "0192d4a8-7c1e-7a00-8000-0000000000c1",
      runId: "arun_0123456789abcdef012345",
      verdict: "wrong",
    },
    expectedInput: {
      conversationId: "0192d4a8-7c1e-7a00-8000-0000000000c1",
      runId: "arun_0123456789abcdef012345",
      verdict: "wrong",
      note: null,
    },
    invalidBody: {
      conversationId: "0192d4a8-7c1e-7a00-8000-0000000000c1",
      runId: "arun_0123456789abcdef012345",
      verdict: "wrong",
      note: "x".repeat(501),
    },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "tools.search",
    route: toolsSearchRoute as unknown as Hono<never>,
    method: "POST",
    capability: toolsSearch.name,
    body: { query: "budget", kinds: ["tool"] },
    invalidBody: { query: "budget", kinds: ["node"] },
    status: 200,
  },
  {
    file: "tools.load",
    route: toolsLoadRoute as unknown as Hono<never>,
    method: "POST",
    capability: toolsLoad.name,
    body: { names: ["list_runs"] },
    invalidBody: { names: [] },
    status: 200,
  },
  {
    file: "shell.nav_counts.get",
    route: shellNavCountsGetRoute as unknown as Hono<never>,
    method: "GET",
    capability: shellNavCountsGet.name,
    body: {},
    status: 200,
  },
  {
    file: "run.recent.list",
    route: runRecentListRoute as unknown as Hono<never>,
    method: "POST",
    capability: runRecentList.name,
    body: { limit: 5 },
    invalidBody: { limit: 50 },
    status: 200,
  },
  {
    file: "user.preferences.set",
    route: userPreferencesSetRoute as unknown as Hono<never>,
    method: "PATCH",
    capability: userPreferencesSet.name,
    body: { theme: "dark" },
    invalidBody: { theme: "sepia" },
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
    file: "onboarding.state.get",
    route: onboardingStateGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: onboardingStateGet.name,
    body: {},
    invalidBody: { step: "run" },
    status: 200,
  },
  {
    file: "onboarding.advance",
    route: onboardingAdvanceRoute as unknown as Hono<never>,
    method: "POST",
    capability: onboardingAdvance.name,
    body: { to: "run" },
    invalidBody: { to: "organization" },
    status: 200,
  },
  {
    file: "onboarding.first_frame.get",
    route: onboardingFirstFrameGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: onboardingFirstFrameGet.name,
    body: { agentId: "agt_0123456789" },
    expectedInput: { agentId: "agt_0123456789", waitMs: 0 },
    invalidBody: { agentId: "not-an-agent" },
    status: 200,
  },
  {
    file: "repository.main.bind",
    route: repositoryMainBindRoute as unknown as Hono<never>,
    method: "POST",
    capability: repositoryMainBind.name,
    body: { owner: "acme", name: "widgets" },
    invalidBody: { owner: "acme", name: "wid gets" },
    status: 201,
  },
  {
    file: "repository.link",
    route: repositoryLinkRoute as unknown as Hono<never>,
    method: "POST",
    capability: repositoryLink.name,
    body: { owner: "acme", name: "shared-lib" },
    expectedInput: { provider: "github", owner: "acme", name: "shared-lib" },
    invalidBody: { owner: "acme", name: "shared lib" },
    jsonGuard: true,
    status: 201,
  },
  {
    file: "repository.unlink",
    route: repositoryUnlinkRoute as unknown as Hono<never>,
    method: "POST",
    capability: repositoryUnlink.name,
    body: { bindingId: "rpb_0a1b2c" },
    invalidBody: { bindingId: "not-a-binding" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "repository.tree.get",
    route: repositoryTreeGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: repositoryTreeGet.name,
    body: { bindingId: "rpb_0a1b2c" },
    invalidBody: { bindingId: "not-a-binding" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "repository.production_branch.set",
    route: repositoryProductionBranchSetRoute as unknown as Hono<never>,
    method: "POST",
    capability: repositoryProductionBranchSet.name,
    body: { bindingId: "rpb_0a1b2c", branch: "release/2026" },
    invalidBody: { bindingId: "rpb_0a1b2c", branch: "has space" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "repository.init_pr.open",
    route: repositoryInitPrOpenRoute as unknown as Hono<never>,
    method: "POST",
    capability: repositoryInitPrOpen.name,
    body: {
      bindingId: "rpb_0a1b2c",
      governanceMode: "team",
      workspaceToml: 'schema = "oxagen-workspace/v0.1"',
      governanceToml: 'mode = "team"',
    },
    invalidBody: { bindingId: "rpb_0a1b2c", governanceMode: "lax" },
    jsonGuard: true,
    status: 201,
  },
  {
    file: "repository.list",
    route: repositoryListRoute as unknown as Hono<never>,
    method: "GET",
    capability: repositoryList.name,
    expectedInput: repositoryList.input.parse({}),
    status: 200,
  },
  {
    file: "tacho.enrollment_token.create",
    route: tachoEnrollmentTokenCreateRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoEnrollmentTokenCreate.name,
    body: { agentId: "agt_0123456789" },
    expectedInput: { agentId: "agt_0123456789", ttlMinutes: 30 },
    invalidBody: { agentId: "agt_0123456789", ttlMinutes: 600 },
    status: 201,
  },
  {
    file: "tacho.host.enroll",
    route: tachoHostEnrollRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoHostEnroll.name,
    body: {
      token: "oxe_1time_0123456789abcdefghjkmnpqrs",
      hostname: "mbp.local",
      osUser: "dev",
      platform: "darwin",
      devicePublicKey: `ed25519:${"A".repeat(44)}`,
      harnesses: ["claude-code"],
    },
    expectedInput: {
      token: "oxe_1time_0123456789abcdefghjkmnpqrs",
      hostname: "mbp.local",
      osUser: "dev",
      platform: "darwin",
      devicePublicKey: `ed25519:${"A".repeat(44)}`,
      harnesses: ["claude-code"],
      managed: false,
      validityDays: 180,
    },
    invalidBody: {
      token: "not-a-token",
      hostname: "mbp.local",
      osUser: "dev",
      platform: "darwin",
      devicePublicKey: `ed25519:${"A".repeat(44)}`,
      harnesses: ["claude-code"],
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
      // Both carry a schema default, so the parsed input the route dispatches
      // holds them even when the body declares neither (ADR-059 decision 6).
      consequence_tags: [],
      measures: {},
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
    jsonGuard: true,
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
    jsonGuard: true,
    status: 200,
  },
  {
    file: "spend.waste",
    route: spendWasteListRoute as unknown as Hono<never>,
    method: "POST",
    capability: spendWasteList.name,
    body: { period: { from: "2026-09-01", to: "2026-09-30" } },
    invalidBody: { period: { from: "2026-02-30", to: "2026-03-01" } },
    jsonGuard: true,
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
    jsonGuard: true,
    status: 200,
  },
  {
    file: "spend.cost_center_statement.export",
    route: spendCostCenterStatementExportRoute as unknown as Hono<never>,
    method: "POST",
    capability: spendCostCenterStatementExport.name,
    body: { month: "2026-09" },
    expectedInput: { month: "2026-09", format: "csv" },
    invalidBody: { month: "2026-13" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "cost_center.list",
    route: costCenterListRoute as unknown as Hono<never>,
    method: "POST",
    capability: costCenterList.name,
    body: {},
    // The input is strict: an unknown field never reaches invoke.
    invalidBody: { workspace: "wrk_1" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "cost_center.create",
    route: costCenterCreateRoute as unknown as Hono<never>,
    method: "POST",
    capability: costCenterCreate.name,
    body: { label: "ENG-1001", description: "Platform engineering" },
    // `~none` is the unassigned key, and the label pattern refuses it.
    invalidBody: { label: "~none" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "cost_center.delete",
    route: costCenterDeleteRoute as unknown as Hono<never>,
    method: "POST",
    capability: costCenterDelete.name,
    body: { label: "ENG-1001" },
    invalidBody: { label: "" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "cost_center.set",
    route: costCenterSetRoute as unknown as Hono<never>,
    method: "POST",
    capability: costCenterSet.name,
    body: { target: "agent", agent: "reviewer", costCenter: "ENG-1001" },
    // An agent target must name the agent (the contract's refinement).
    invalidBody: { target: "agent", costCenter: "ENG-1001" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "audit.events.export",
    route: auditEventsExportRoute as unknown as Hono<never>,
    method: "POST",
    capability: auditEventsExport.name,
    body: { outcome: "deny" },
    expectedInput: { outcome: "deny", format: "csv" },
    // An export answers for the whole organization, so the route sends the
    // organization-only sentinel whichever router it was reached through.
    expectedCtx: { ...CTX, workspaceId: ORG_ONLY_WORKSPACE_ID },
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
    jsonGuard: true,
    status: 200,
  },
  {
    file: "cost.price_entry.list",
    route: costPriceEntryListRoute as unknown as Hono<never>,
    method: "POST",
    capability: costPriceEntryList.name,
    body: { at: "2026-09-14T00:00:00.000Z", includeScheduled: true },
    invalidBody: { at: "yesterday" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "cost.unpriced_model.list",
    route: costUnpricedModelListRoute as unknown as Hono<never>,
    method: "POST",
    capability: costUnpricedModelList.name,
    body: { since: "2026-08-14T00:00:00.000Z" },
    invalidBody: { since: "last month" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "cost.price_entry.set",
    route: costPriceEntrySetRoute as unknown as Hono<never>,
    // POST, matching the route: the write moved off PUT so a body that
    // restates the row key is not mistaken for a full-resource replace.
    method: "POST",
    capability: costPriceEntrySet.name,
    body: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "input_uncached",
      usdPerMillion: 2.4,
    },
    invalidBody: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "input_uncached",
      usdPerMillion: -1,
    },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "cost.price_entry.remove",
    route: costPriceEntryRemoveRoute as unknown as Hono<never>,
    method: "POST",
    capability: costPriceEntryRemove.name,
    body: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "input_uncached",
    },
    invalidBody: { provider: "anthropic", model: "claude-sonnet-5" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "mandate.get",
    route: mandateGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: mandateGet.name,
    body: { mandateId: "mnd_01j9k3" },
    expectedInput: { mandateId: "mnd_01j9k3", ledgerLimit: 100 },
    // A memory id, not a mandate public id: the contract owns the prefix.
    invalidBody: { mandateId: "m_1" },
    status: 200,
  },
  {
    file: "mandate.grant",
    route: mandateGrantRoute as unknown as Hono<never>,
    method: "POST",
    capability: mandateGrant.name,
    body: {
      agentId: "agt_1",
      consequenceTags: ["moves_money"],
      limits: {
        refund_amount: {
          perCall: "50000000",
          perPeriod: "500000000",
          period: "daily",
          currencyOrUnit: "USD",
        },
      },
      tools: ["stripe.refund@1"],
      purpose: "issue refunds under fifty dollars without waking a person",
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-12-01T00:00:00.000Z",
    },
    expectedInput: {
      agentId: "agt_1",
      consequenceTags: ["moves_money"],
      limits: {
        refund_amount: {
          perCall: "50000000",
          perPeriod: "500000000",
          period: "daily",
          currencyOrUnit: "USD",
        },
      },
      targets: {},
      tools: ["stripe.refund@1"],
      approval: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
      purpose: "issue refunds under fifty dollars without waking a person",
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-12-01T00:00:00.000Z",
    },
    // validTo before validFrom — the body's cross-field refinement.
    invalidBody: {
      ...{
        agentId: "agt_1",
        consequenceTags: ["moves_money"],
        limits: {
          refund_amount: {
            perCall: "50000000",
            perPeriod: "500000000",
            period: "daily",
            currencyOrUnit: "USD",
          },
        },
        tools: ["stripe.refund@1"],
        purpose: "issue refunds under fifty dollars without waking a person",
        validFrom: "2026-09-01T00:00:00.000Z",
        validTo: "2026-12-01T00:00:00.000Z",
      },
      validTo: "2026-08-01T00:00:00.000Z",
    },
    status: 200,
  },
  {
    file: "mandate.limits.update",
    route: mandateLimitsUpdateRoute as unknown as Hono<never>,
    method: "POST",
    capability: mandateLimitsUpdate.name,
    body: { mandateId: "mnd_01j9k3", validTo: "2026-12-31T00:00:00.000Z" },
    // Names no change: the contract refuses an update that updates nothing.
    invalidBody: { mandateId: "mnd_01j9k3" },
    status: 200,
  },
  {
    file: "mandate.list",
    route: mandateListRoute as unknown as Hono<never>,
    method: "POST",
    capability: mandateList.name,
    body: {},
    expectedInput: { limit: 50 },
    // "paused" is not one of draft/active/expired/revoked.
    invalidBody: { status: "paused" },
    status: 200,
  },
  {
    file: "approval_rule.list",
    route: approvalRuleListRoute as unknown as Hono<never>,
    method: "POST",
    capability: approvalRuleList.name,
    body: {},
    // The read takes no argument at all.
    invalidBody: { limit: 10 },
    status: 200,
  },
  {
    file: "approval_rule.set",
    route: approvalRuleSetRoute as unknown as Hono<never>,
    method: "POST",
    capability: approvalRuleSet.name,
    body: {
      rules: [
        {
          id: "small-vendor-payments",
          name: "Small vendor payments",
          tools: ["stripe__create_payment@*"],
        },
      ],
    },
    expectedInput: {
      rules: [
        {
          id: "small-vendor-payments",
          name: "Small vendor payments",
          tools: ["stripe__create_payment@*"],
          enabled: true,
          maxMeasures: {},
          allowTargets: {},
          standingWindowMs: null,
          businessHours: null,
        },
      ],
    },
    // A rule id is a slug; "Small Vendor" is not one.
    invalidBody: {
      rules: [{ id: "Small Vendor", name: "x", tools: ["stripe__*"] }],
    },
    status: 200,
  },
  {
    file: "approval_rule.delete",
    route: approvalRuleDeleteRoute as unknown as Hono<never>,
    method: "POST",
    capability: approvalRuleDelete.name,
    body: { ruleId: "small-vendor-payments" },
    invalidBody: {},
    status: 200,
  },
  {
    file: "approval_rule.enabled.set",
    route: approvalRuleEnabledSetRoute as unknown as Hono<never>,
    method: "POST",
    capability: approvalRuleEnabledSet.name,
    body: { ruleId: "small-vendor-payments", enabled: false },
    invalidBody: { ruleId: "small-vendor-payments" },
    status: 200,
  },
  {
    file: "approval.auto_eligibility.get",
    route: approvalAutoEligibilityGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: approvalAutoEligibilityGet.name,
    body: { approvalId: "apr_0123456789abcdefghjkmn" },
    invalidBody: { approvalId: "nope" },
    status: 200,
  },
  {
    file: "mandate.request",
    route: mandateRequestRoute as unknown as Hono<never>,
    method: "POST",
    capability: mandateRequest.name,
    body: {
      agentId: "agt_1",
      consequenceTags: ["moves_money"],
      limits: {
        refund_amount: {
          perCall: "50000000",
          perPeriod: "500000000",
          period: "daily",
          currencyOrUnit: "USD",
        },
      },
      tools: ["stripe.refund@1"],
      purpose: "issue refunds under fifty dollars without waking a person",
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-12-01T00:00:00.000Z",
    },
    expectedInput: {
      agentId: "agt_1",
      consequenceTags: ["moves_money"],
      limits: {
        refund_amount: {
          perCall: "50000000",
          perPeriod: "500000000",
          period: "daily",
          currencyOrUnit: "USD",
        },
      },
      targets: {},
      tools: ["stripe.refund@1"],
      approval: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
      purpose: "issue refunds under fifty dollars without waking a person",
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-12-01T00:00:00.000Z",
    },
    // A mandate over no tool pattern grants nothing and is refused.
    invalidBody: {
      ...{
        agentId: "agt_1",
        consequenceTags: ["moves_money"],
        limits: {
          refund_amount: {
            perCall: "50000000",
            perPeriod: "500000000",
            period: "daily",
            currencyOrUnit: "USD",
          },
        },
        tools: ["stripe.refund@1"],
        purpose: "issue refunds under fifty dollars without waking a person",
        validFrom: "2026-09-01T00:00:00.000Z",
        validTo: "2026-12-01T00:00:00.000Z",
      },
      tools: [],
    },
    status: 200,
  },
  {
    file: "mandate.revoke",
    route: mandateRevokeRoute as unknown as Hono<never>,
    method: "POST",
    capability: mandateRevoke.name,
    body: { mandateId: "mnd_01j9k3", reason: "the agent shipped its refund" },
    // Revoking is a recorded act: an empty reason is refused.
    invalidBody: { mandateId: "mnd_01j9k3", reason: "" },
    status: 200,
  },
  {
    file: "run.get",
    route: runGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: runGet.name,
    body: { runId: "tse_0192d4a87c1e7a0080000000" },
    expectedInput: {
      runId: "tse_0192d4a87c1e7a0080000000",
      frameLimit: 200,
      waitMs: 0,
    },
    // waitMs is a long-poll budget the handler holds open: it is capped.
    invalidBody: { runId: "tse_0192d4a87c1e7a0080000000", waitMs: 60_000 },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "run.list",
    route: runListRoute as unknown as Hono<never>,
    method: "POST",
    capability: runList.name,
    body: {},
    expectedInput: { limit: 50 },
    invalidBody: { limit: 0 },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "run.seal",
    route: runSealRoute as unknown as Hono<never>,
    method: "POST",
    capability: runSeal.name,
    body: {
      runId: "tse_0192d4a87c1e7a0080000000",
      reason: "the agent answered and the terminal sat open",
    },
    // The reason lands on the kill command: an empty one is refused, not stored.
    invalidBody: { runId: "tse_0192d4a87c1e7a0080000000", reason: "" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "tacho.enrollment.create",
    route: tachoEnrollmentCreateRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoEnrollmentCreate.name,
    body: ENROLLMENT_BODY,
    expectedInput: { ...ENROLLMENT_BODY, managed: false, validityDays: 180 },
    // Not an Ed25519 key: an enrollment without one can sign nothing.
    invalidBody: { ...ENROLLMENT_BODY, devicePublicKey: "ed25519:short" },
    jsonGuard: true,
    status: 201,
  },
  {
    file: "tacho.enrollment.revoke",
    route: tachoEnrollmentRevokeRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoEnrollmentRevoke.name,
    body: { hostEnrollmentId: HOST_ENROLLMENT_ID, reason: "laptop returned" },
    invalidBody: { hostEnrollmentId: "tch_1" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "tacho.host.list",
    route: tachoHostListRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoHostList.name,
    body: {},
    expectedInput: { limit: 50 },
    // "retired" is not one of active/paused/suspended/revoked.
    invalidBody: { status: "retired" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "tacho.session.get",
    route: tachoSessionGetRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoSessionGet.name,
    body: { sessionUuid: UUID },
    invalidBody: { sessionUuid: "session-1" },
    jsonGuard: true,
    status: 200,
  },
  {
    file: "tacho.session.list",
    route: tachoSessionListRoute as unknown as Hono<never>,
    method: "POST",
    capability: tachoSessionList.name,
    body: {},
    expectedInput: { includeChildren: false, limit: 50 },
    // "finished" is not one of running/completed/aborted/crashed/unknown.
    invalidBody: { outcome: "finished" },
    jsonGuard: true,
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

/** The same request, but the body is not JSON at all. */
async function callMalformed(entry: ThinRoute): Promise<Response> {
  return await entry.route.fetch(
    new Request("http://localhost/", {
      method: entry.method,
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
  );
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
        entry.expectedCtx ?? CTX,
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

  it.each(ROUTES.filter((r) => r.jsonGuard).map((r) => [r.file, r] as const))(
    "%s answers 400 for a body that is not JSON",
    async (_file, entry) => {
      const res = await callMalformed(entry);

      expect(res.status).toBe(400);
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );
});
