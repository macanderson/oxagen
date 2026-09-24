import { runOutcomesSettingsRoute } from "./routes/v1/run.outcomes.settings";
import { configurationCloneGetRoute } from "./routes/v1/configuration.clone.get";
import { configurationCloneProposeRoute } from "./routes/v1/configuration.clone.propose";
import { revokeMemberInviteRoute } from "./routes/v1/org.member_invite.revoke";
import { resendMemberInviteRoute } from "./routes/v1/org.member_invite.resend";
import { Hono } from "hono";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requestLogger } from "./middleware/logger";
import { corsMiddleware } from "./middleware/cors";
import { errorMiddleware } from "./middleware/error";
import { authMiddleware } from "./middleware/auth";
import { orgMiddleware } from "./middleware/org";
import { workspaceMiddleware } from "./middleware/workspace";
import {
  authorizationFingerprintBucketKey,
  distributedRateLimiter,
  enrolledMachineBucketKey,
  rateLimitBudgets,
  trustedClientIpBucketKey,
} from "./middleware/distributed-rate-limit";
import { health } from "./routes/health";
import { stripeWebhook } from "./routes/stripe";
import { inngestRoute } from "./routes/inngest";
import { organizationCreateRoute } from "./routes/v1/org.create";
import { workspaceCreateRoute } from "./routes/v1/workspace.create";
import { orgListRoute } from "./routes/v1/org.list";
import { workspaceListRoute } from "./routes/v1/workspace.list";
import { billingAutoTopupSetRoute } from "./routes/v1/billing.auto_topup.set";
import { billingContractRateGetRoute } from "./routes/v1/billing.contract_rate.get";
import { billingGauBucketGetRoute } from "./routes/v1/billing.gau_bucket.get";
import { billingInvoiceListRoute } from "./routes/v1/billing.invoice.list";
import { billingPrepaidOrderListRoute } from "./routes/v1/billing.prepaid_order.list";
import { billingStatementGetRoute } from "./routes/v1/billing.statement.get";
import { billingStatementExportRoute } from "./routes/v1/billing.statement.export";
import { billingSubscriptionReadRoute } from "./routes/v1/billing.subscription.read";
import { billingUsageBreakdownRoute } from "./routes/v1/billing.usage.breakdown";
import { billingSubscriptionUpgradeStartRoute } from "./routes/v1/billing.subscription_upgrade.start";
import { billingCreditsPurchaseRoute } from "./routes/v1/billing.credits.purchase";
import { billingGauBucketPurchaseRoute } from "./routes/v1/billing.gau_bucket.purchase";
import { billingActionRateCardRoute } from "./routes/v1/billing.action_rate_card";
import { billingActionEstimateRoute } from "./routes/v1/billing.action_estimate";
import { billingEvidenceRetentionRoute } from "./routes/v1/billing.evidence_retention";
import { chatMessageSendRoute } from "./routes/v1/chat.message.send";
import { chatMessageExecutionRoute } from "./routes/v1/chat.message.execution";
import { chatStreamRoute } from "./routes/v1/chat.stream";
import { assistantAskRoute } from "./routes/v1/assistant.ask";
import { assistantEngineGetRoute } from "./routes/v1/assistant.engine.get";
import { toolsSearchRoute } from "./routes/v1/tools.search";
import { toolsLoadRoute } from "./routes/v1/tools.load";
import { shellNavCountsGetRoute } from "./routes/v1/shell.nav_counts.get";
import { runRecentListRoute } from "./routes/v1/run.recent.list";
import { userPreferencesSetRoute } from "./routes/v1/user.preferences.set";
import { userProfileUpdateRoute } from "./routes/v1/user.profile.update";
import { agentToolListRoute } from "./routes/v1/agent.tool.list";
import { agentMcpRegisterRoute } from "./routes/v1/agent.mcp.register";
import { agentMcpListRoute } from "./routes/v1/agent.mcp.list";
import { agentMcpResolveRoute } from "./routes/v1/agent.mcp.resolve";
import { agentMcpSetEnabledRoute } from "./routes/v1/agent.mcp.set_enabled";
import { agentMcpDeleteRoute } from "./routes/v1/agent.mcp.delete";
import { agentMcpRegistrySearchRoute } from "./routes/v1/agent.mcp.registry.search";
import { agentMcpAuthorizeStartRoute } from "./routes/v1/agent.mcp.authorize.start";
import { agentMcpAuthorizeCompleteRoute } from "./routes/v1/agent.mcp.authorize.complete";
import { agentMcpConsentResolveRoute } from "./routes/v1/agent.mcp_consent.resolve";
import { agentMcpConsentListRoute } from "./routes/v1/agent.mcp_consent.list";
import { agentMemoryRecallRoute } from "./routes/v1/agent.memory.recall";
import { agentMemoryWriteRoute } from "./routes/v1/agent.memory.write";
import { agentMemoryListRoute } from "./routes/v1/agent.memory.list";
import { agentMemoryUpdateRoute } from "./routes/v1/agent.memory.update";
import { agentMemoryDeleteRoute } from "./routes/v1/agent.memory.delete";
import { agentMemoryRememberRoute } from "./routes/v1/agent.memory.remember";
import { agentMemoryPolicyReadRoute } from "./routes/v1/agent.memory_policy.read";
import { agentMemoryPolicyWriteRoute } from "./routes/v1/agent.memory_policy.write";
import { agentMemoryImportParseRoute } from "./routes/v1/agent.memory_import.parse";
import { agentMemoryImportCommitRoute } from "./routes/v1/agent.memory_import.commit";
import { agentMemoryPromoteRoute } from "./routes/v1/agent.memory.promote";
import { agentMemoryDemoteRoute } from "./routes/v1/agent.memory.demote";
import { agentMemoryPromotionCandidatesRoute } from "./routes/v1/agent.memory_promotion.list";
import { agentMemoryPromotionDismissRoute } from "./routes/v1/agent.memory_promotion.dismiss";
import { agentMemoryPromotionRationalesRoute } from "./routes/v1/agent.memory_promotion.rationales";
import { agentMemoryCiteRoute } from "./routes/v1/agent.memory.cite";
import { agentMemoryEvidenceAttachRoute } from "./routes/v1/agent.memory_evidence.attach";
import { agentMemoryCitationsListRoute } from "./routes/v1/agent.memory_citation.list";
import { agentMemoryCitationStatsRoute } from "./routes/v1/agent.memory_citation.stats";
import { agentApprovalListRoute } from "./routes/v1/agent.approval.list";
import { agentApprovalListResolvedRoute } from "./routes/v1/agent.approval.list_resolved";
import { agentApprovalResolveRoute } from "./routes/v1/agent.approval.resolve";
import { agentExecutionRecordRoute } from "./routes/v1/agent.execution.record";
import { agentTraceGetRoute } from "./routes/v1/agent.trace.get";
import { agentDebugTraceRoute } from "./routes/v1/agent.debug.trace";
import { telemetryErrorClusterRoute } from "./routes/v1/telemetry.error.cluster";
import { agentExecutionListRoute } from "./routes/v1/agent.execution.list";
import { modelCapabilityListRoute } from "./routes/v1/model.capability.list";
import { commandMenuSearchRoute } from "./routes/v1/command.menu.search";
import { commandMenuSuggestRoute } from "./routes/v1/command.menu.suggest";
import { referenceSearchRoute } from "./routes/v1/reference.search";
import { systemInstallInstructionsRoute } from "./routes/v1/system.install.instructions";
import { orgMemberAddRoute } from "./routes/v1/org.member.add";
import { orgMemberInviteAcceptRoute } from "./routes/v1/org.member_invite.accept";
import { orgMemberInviteDeclineRoute } from "./routes/v1/org.member_invite.decline";
import { orgMemberRemoveRoute } from "./routes/v1/org.member.remove";
import { orgMemberRoleChangeRoute } from "./routes/v1/org.member_role.change";
import { userPreferencesReadRoute } from "./routes/v1/user.preferences.read";
import { budgetPolicyReadRoute } from "./routes/v1/budget.policy.read";
import { budgetPolicyWriteRoute } from "./routes/v1/budget.policy.write";
import { workspaceBudgetPolicyReadRoute } from "./routes/v1/workspace.budget_policy.read";
import { workspaceBudgetPolicyWriteRoute } from "./routes/v1/workspace.budget_policy.write";
import { billingBudgetGetRoute } from "./routes/v1/billing.budget.get";
import { billingBudgetSetRoute } from "./routes/v1/billing.budget.set";
import { userWorkspacePreferencesReadRoute } from "./routes/v1/user.workspace_preferences.read";
import { userWorkspacePreferencesWriteRoute } from "./routes/v1/user.workspace_preferences.write";
import { authWhoamiRoute } from "./routes/v1/auth.whoami";
import { workspaceModelSettingsReadRoute } from "./routes/v1/workspace.model_settings.read";
import { workspaceModelSettingsWriteRoute } from "./routes/v1/workspace.model_settings.write";
import { promptSettingsReadRoute } from "./routes/v1/prompt.settings.read";
import { promptSettingsWriteRoute } from "./routes/v1/prompt.settings.write";
import { orgDataPlaneRoute } from "./routes/v1/org.data_plane";
import { orgModelCredentialRoute } from "./routes/v1/org.model_credential";
import { orgSsoRoute } from "./routes/v1/org.sso";
import { orgSettingsReadRoute } from "./routes/v1/org.settings.read";
import { orgSettingsWriteRoute } from "./routes/v1/org.settings.write";
import { workspaceSettingsReadRoute } from "./routes/v1/workspace.settings.read";
import { workspaceSettingsWriteRoute } from "./routes/v1/workspace.settings.write";
import { conversationListRoute } from "./routes/v1/conversation.list";
import { conversationRenameRoute } from "./routes/v1/conversation.rename";
import { conversationArchiveRoute } from "./routes/v1/conversation.archive";
import { conversationDeleteRoute } from "./routes/v1/conversation.delete";
import { conversationPurgeRoute } from "./routes/v1/conversation.purge";
import { conversationFilesListRoute } from "./routes/v1/conversation.files.list";
import { conversationExportRoute } from "./routes/v1/conversation.export";
import { conversationAttachmentAddRoute } from "./routes/v1/conversation.attachment.add";
import { assetUploadRoute } from "./routes/v1/asset.upload";
import { pluginRegistryListRoute } from "./routes/v1/plugin.registry.list";
import { pluginRegistryAddRoute } from "./routes/v1/plugin.registry.add";
import { pluginRegistryRemoveRoute } from "./routes/v1/plugin.registry.remove";
import { pluginCatalogBrowseRoute } from "./routes/v1/plugin.catalog.browse";
import { pluginCatalogGetRoute } from "./routes/v1/plugin.catalog.get";
import { pluginCatalogSyncRoute } from "./routes/v1/plugin.catalog.sync";
import { pluginOrgListRoute } from "./routes/v1/plugin.org.list";
import { pluginOrgInstallRoute } from "./routes/v1/plugin.org.install";
import { pluginOrgInstallBulkRoute } from "./routes/v1/plugin.org.install_bulk";
import { pluginOrgUninstallRoute } from "./routes/v1/plugin.org.uninstall";
import { pluginSetEnabledRoute } from "./routes/v1/plugin.set_enabled";
import { pluginCredentialSetSecretRoute } from "./routes/v1/plugin.credential.set_secret";
import { pluginCredentialReauthRoute } from "./routes/v1/plugin.credential.reauth";
import { pluginCredentialRevokeRoute } from "./routes/v1/plugin.credential.revoke";
// Environments + credential vault.
import { environmentCreateRoute } from "./routes/v1/environment.create";
import { environmentListRoute } from "./routes/v1/environment.list";
import { environmentGetRoute } from "./routes/v1/environment.get";
import { environmentUpdateRoute } from "./routes/v1/environment.update";
import { environmentDeleteRoute } from "./routes/v1/environment.delete";
import { environmentSetDefaultRoute } from "./routes/v1/environment.set_default";
// Agent ↔ environment bindings.
import { agentEnvironmentBindRoute } from "./routes/v1/agent.environment.bind";
import { agentEnvironmentUnbindRoute } from "./routes/v1/agent.environment.unbind";
import { agentEnvironmentListRoute } from "./routes/v1/agent.environment.list";
import { secretKeyUpsertRoute } from "./routes/v1/secret.key.upsert";
import { secretKeyListRoute } from "./routes/v1/secret.key.list";
import { secretKeyDeleteRoute } from "./routes/v1/secret.key.delete";
import { secretValueSetRoute } from "./routes/v1/secret.value.set";
import { secretValueUnsetRoute } from "./routes/v1/secret.value.unset";
import { secretImportEnvRoute } from "./routes/v1/secret.import_env";
import { secretRevealRoute } from "./routes/v1/secret.reveal";
import { secretExportRoute } from "./routes/v1/secret.export";
import { notificationsListRoute } from "./routes/v1/notification.list";
import { notificationsMarkRoute } from "./routes/v1/notification.mark";
import { pluginSettingsSetAuthAlertsRoute } from "./routes/v1/plugin.settings.set_auth_alerts";
import { pluginSettingsGetAuthAlertsRoute } from "./routes/v1/plugin.settings.get_auth_alerts";
import { capabilityRegistryListRoute } from "./routes/v1/capability.registry.list";
import { capabilityRegistryGetRoute } from "./routes/v1/capability.registry.get";
import { iamRoleListRoute } from "./routes/v1/iam.role.list";
import { iamRoleCreateRoute } from "./routes/v1/iam.role.create";
import { iamRoleGrantsSetRoute } from "./routes/v1/iam.role.grants.set";
import { iamRoleDeleteRoute } from "./routes/v1/iam.role.delete";
import { workspaceArchiveRoute } from "./routes/v1/workspace.archive";
import { apiKeyCreateRoute } from "./routes/v1/api.key.create";
import { apiKeyListRoute } from "./routes/v1/api.key.list";
import { apiKeyRevokeRoute } from "./routes/v1/api.key.revoke";
import { apiKeyRotateRoute } from "./routes/v1/api.key.rotate";
import { listMembersRoute } from "./routes/v1/workspace.member.list";
import { workspaceInviteSendRoute } from "./routes/v1/workspace.invite.send";
import { conversationChatRoute } from "./routes/v1/conversation.chat";
import { toolDeclarationPublishRoute } from "./routes/v1/tool.declaration.publish";
import { mandateGrantRoute } from "./routes/v1/mandate.grant";
import { mandateRequestRoute } from "./routes/v1/mandate.request";
import { mandateListRoute } from "./routes/v1/mandate.list";
import { mandateGetRoute } from "./routes/v1/mandate.get";
import { mandateRevokeRoute } from "./routes/v1/mandate.revoke";
import { mandateLimitsUpdateRoute } from "./routes/v1/mandate.limits.update";
import { approvalRuleListRoute } from "./routes/v1/approval_rule.list";
import { approvalRuleSetRoute } from "./routes/v1/approval_rule.set";
import { approvalRuleDeleteRoute } from "./routes/v1/approval_rule.delete";
import { approvalRuleEnabledSetRoute } from "./routes/v1/approval_rule.enabled.set";
import { approvalAutoEligibilityGetRoute } from "./routes/v1/approval.auto_eligibility.get";
import { toolDeclarationListRoute } from "./routes/v1/tool.declaration.list";
import { toolVersionListRoute } from "./routes/v1/tool.version.list";
import { toolClassificationSetRoute } from "./routes/v1/tool.classification.set";
import { toolImportRoute } from "./routes/v1/tool.import";
import { credentialGrantListRoute } from "./routes/v1/credential.grant.list";
import { killSwitchSetRoute } from "./routes/v1/kill_switch.set";
import { killSwitchListRoute } from "./routes/v1/kill_switch.list";
import { contextRecordPublishRoute } from "./routes/v1/context.record.publish";
import { contextRecordListRoute } from "./routes/v1/context.record.list";
import { contextRecordReviseRoute } from "./routes/v1/context.record.revise";
import { contextRecordPromoteRoute } from "./routes/v1/context.record.promote";
import { contextRecordsListRoute } from "./routes/v1/context.records.list";
import { contextRecordsGetRoute } from "./routes/v1/context.records.get";
import { contextRecordsAppendRoute } from "./routes/v1/context.records.append";
import { contextSteeringDeliveriesRoute } from "./routes/v1/context.steering.deliveries";
import { contextSteeringFreshnessRoute } from "./routes/v1/context.steering.freshness";
import { contextProposalCreateRoute } from "./routes/v1/context.proposal.create";
import { contextProposalListRoute } from "./routes/v1/context.proposal.list";
import { contextProposalDismissRoute } from "./routes/v1/context.proposal.dismiss";
import { contextPrOpenRoute } from "./routes/v1/context.pr.open";
import { contextPrGetRoute } from "./routes/v1/context.pr.get";
import { contextPrMergeRoute } from "./routes/v1/context.pr.merge";
import { agentDefinitionCreateRoute } from "./routes/v1/agent.definition.create";
import { agentDefinitionDeleteRoute } from "./routes/v1/agent.definition.delete";
import { agentDefinitionUpdateRoute } from "./routes/v1/agent.definition.update";
import { agentDefinitionPublishRoute } from "./routes/v1/agent.definition.publish";
import { agentDefinitionGetRoute } from "./routes/v1/agent.definition.get";
import { agentDefinitionListRoute } from "./routes/v1/agent.definition.list";
import { agentRoleAssignRoute } from "./routes/v1/agent.role.assign";
import { agentRoleRevokeRoute } from "./routes/v1/agent.role.revoke";
import { agentRoleListRoute } from "./routes/v1/agent.role.list";
import { agentRoleGetRoute } from "./routes/v1/agent.role.get";
import { agentDefinitionSuggestRoute } from "./routes/v1/agent.definition.suggest";
import { agentDefinitionReviseRoute } from "./routes/v1/agent.definition.revise";
import { agentDefinitionSummarizeRoute } from "./routes/v1/agent.definition.summarize";
import { routerPolicyGetRoute } from "./routes/v1/router.policy.get";
import { routerPolicySetRoute } from "./routes/v1/router.policy.set";
import { routerStatsListRoute } from "./routes/v1/router.stats.list";
import { routerDecisionPreviewRoute } from "./routes/v1/router.decision.preview";
import { agentDeployRoute } from "./routes/v1/agent.deploy";
import { privacyDataExportRoute } from "./routes/v1/privacy.data.export";
import { privacyDataEraseRoute } from "./routes/v1/privacy.data.erase";
import { connectionRoute } from "./routes/v1/connection";
import { webhookRoute } from "./routes/v1/webhook";
import {
  githubOauthRoute,
  githubOauthCallbackRoute,
} from "./routes/v1/github-oauth";
import { githubAppWebhookRoute } from "./routes/v1/github-webhook";
import { gitlabWebhookRoute } from "./routes/v1/gitlab-webhook";
import { graphNodeGetRoute } from "./routes/v1/graph.node.get";
import { graphNodeSearchRoute } from "./routes/v1/graph.node.search";
import { graphSearchRoute } from "./routes/v1/graph.search";
import { repoRoute } from "./routes/v1/repo";
import { integrationRoute } from "./routes/v1/integration";
import { schemaRoute } from "./routes/v1/schema";
import {
  pluginSchemaRoute,
  pluginVersionRoute,
} from "./routes/v1/plugin-schema";
import { graphNodeListRoute } from "./routes/v1/graph.node.list";
import { graphStatsRoute } from "./routes/v1/graph.stats";
import { ontologyQueryRoute } from "./routes/v1/ontology.query";
import { ontologyNeighborsRoute } from "./routes/v1/ontology.neighbors";
import { auditLogQueryRoute } from "./routes/v1/audit.log.query";
import { auditEventsExportRoute } from "./routes/v1/audit.events.export";
import { authCliTokenRoute } from "./routes/v1/auth.cli.token";
import { scimRoute } from "./routes/scim";
import { telemetryUsageRoute } from "./routes/v1/telemetry.usage";
import { telemetryStellaEnrollRoute } from "./routes/v1/telemetry.stella.enroll";
import { telemetryStellaIngestRoute } from "./routes/v1/telemetry.stella.ingest";
import { cmsRoute } from "./routes/v1/cms";
import { tachoContainedLaunchRegisterRoute } from "./routes/v1/tacho.contained_launch.register";
import { tachoBundleGetRoute } from "./routes/v1/tacho.bundle.get";
import { tachoGithubTokenIssueRoute } from "./routes/v1/tacho.github_token.issue";
import { tachoCommandDispatchRoute } from "./routes/v1/tacho.command.dispatch";
import { tachoCommandFetchRoute } from "./routes/v1/tacho.command.fetch";
import { tachoCommandListRoute } from "./routes/v1/tacho.command.list";
import { tachoEnrollmentCreateRoute } from "./routes/v1/tacho.enrollment.create";
import { tachoEnrollmentRevokeRoute } from "./routes/v1/tacho.enrollment.revoke";
import { tachoEventsIngestRoute } from "./routes/v1/tacho.events.ingest";
import { tachoHostEnrollRoute } from "./routes/v1/tacho.host.enroll";
import { tachoEnrollmentTokenCreateRoute } from "./routes/v1/tacho.enrollment_token.create";
import { onboardingStateGetRoute } from "./routes/v1/onboarding.state.get";
import { onboardingAdvanceRoute } from "./routes/v1/onboarding.advance";
import { onboardingFirstFrameGetRoute } from "./routes/v1/onboarding.first_frame.get";
import { repositoryMainBindRoute } from "./routes/v1/repository.main.bind";
import { repositoryMainGetRoute } from "./routes/v1/repository.main.get";
import { repositoryLinkRoute } from "./routes/v1/repository.link";
import { repositoryUnlinkRoute } from "./routes/v1/repository.unlink";
import { repositoryListRoute } from "./routes/v1/repository.list";
import { repositoryTreeGetRoute } from "./routes/v1/repository.tree.get";
import { repositoryProductionBranchSetRoute } from "./routes/v1/repository.production_branch.set";
import { repositoryInitPrOpenRoute } from "./routes/v1/repository.init_pr.open";
import { contextGovernanceModeSetRoute } from "./routes/v1/context.governance_mode.set";
import { repositoryInstallationListRoute } from "./routes/v1/repository.installation.list";
import { repositoryInstallationCandidatesRoute } from "./routes/v1/repository.installation.candidates";
import { repositoryInstallationAttachRoute } from "./routes/v1/repository.installation.attach";
import { repositoryGitlabAttachRoute } from "./routes/v1/repository.gitlab.attach";
import { tachoHostListRoute } from "./routes/v1/tacho.host.list";
import { tachoSessionPolicyReadRoute } from "./routes/v1/tacho.session_policy.read";
import { tachoSessionPolicyWriteRoute } from "./routes/v1/tacho.session_policy.write";
import { tachoSessionGetRoute } from "./routes/v1/tacho.session.get";
import { tachoSessionListRoute } from "./routes/v1/tacho.session.list";
import { runListRoute } from "./routes/v1/run.list";
import { runGetRoute } from "./routes/v1/run.get";
import { runFrameBodyGetRoute } from "./routes/v1/run.frame_body.get";
import { runTranscriptGetRoute } from "./routes/v1/run.transcript.get";
import { runChainGetRoute } from "./routes/v1/run.chain.get";
import { runStreamRoute } from "./routes/v1/run.stream";
import { runBisectRoute } from "./routes/v1/run.bisect";
import { runForkRoute } from "./routes/v1/run.fork";
import { runExportRoute } from "./routes/v1/run.export";
import { runExportGetRoute } from "./routes/v1/run.export.get";
import { runExportDownloadRoute } from "./routes/v1/run.export.download";
import { runSealRoute } from "./routes/v1/run.seal";
import { runSummarizeRoute } from "./routes/v1/run.summarize";
import { agentListRoute } from "./routes/v1/agent.list";
import { agentGetRoute } from "./routes/v1/agent.get";
import { agentRegisterRoute } from "./routes/v1/agent.register";
import { agentCredentialRotateRoute } from "./routes/v1/agent.credential.rotate";
import { agentSuspendRoute } from "./routes/v1/agent.suspend";
import { agentRetireRoute } from "./routes/v1/agent.retire";
import { agentDefinitionCommitRoute } from "./routes/v1/agent.definition.commit";
import { agentProposeRoute } from "./routes/v1/agent.propose";
import { agentToolbeltGetRoute } from "./routes/v1/agent.toolbelt.get";
import { tachoIncidentListRoute } from "./routes/v1/tacho.incident.list";
import { spendGetRoute } from "./routes/v1/spend.get";
import { spendDrillRoute } from "./routes/v1/spend.drill";
import { spendWasteListRoute } from "./routes/v1/spend.waste";
import { skillConfigGetRoute } from "./routes/v1/skill.config.get";
import { skillConfigUpdateRoute } from "./routes/v1/skill.config.update";
import { skillSearchPreviewRoute } from "./routes/v1/skill.search.preview";
import { skillListRoute } from "./routes/v1/skill.list";
import { skillProposeRoute } from "./routes/v1/skill.propose";
import { spendStatementExportRoute } from "./routes/v1/spend.statement.export";
import { spendCostCenterStatementExportRoute } from "./routes/v1/spend.cost_center_statement.export";
import { costCenterListRoute } from "./routes/v1/cost_center.list";
import { costCenterCreateRoute } from "./routes/v1/cost_center.create";
import { costCenterDeleteRoute } from "./routes/v1/cost_center.delete";
import { costCenterSetRoute } from "./routes/v1/cost_center.set";
import { findingListRoute } from "./routes/v1/finding.list";
import { findingEvidenceGetRoute } from "./routes/v1/finding.evidence.get";
import { findingFixRecordRoute } from "./routes/v1/finding.fix.record";
import { findingDismissRoute } from "./routes/v1/finding.dismiss";
import { runCostGetRoute } from "./routes/v1/run.cost";
import { runTurnsGetRoute } from "./routes/v1/run.turns.get";
import { runWorkGetRoute } from "./routes/v1/run.work.get";
import { runOutputsGetRoute } from "./routes/v1/run.outputs.get";
import { runTokenIssueRoute } from "./routes/v1/run.token.issue";
import { runFramesIngestRoute } from "./routes/v1/run.frames.ingest";
import { runProofGetRoute } from "./routes/v1/run.proof.get";
import { evidenceDisclosureGrainSetRoute } from "./routes/v1/evidence.disclosure_grain.set";
import { costPriceEntryListRoute } from "./routes/v1/cost.price_entry.list";
import { costPriceEntryRemoveRoute } from "./routes/v1/cost.price_entry.remove";
import { costPriceEntrySetRoute } from "./routes/v1/cost.price_entry.set";
import { costUnpricedModelListRoute } from "./routes/v1/cost.unpriced_model.list";

export type AppEnv = {
  Variables: {
    requestId: string;
    userId: string | null;
    apiKeyId: string | null;
    orgId: string | null;
    workspaceId: string | null;
    capabilityContext?: CapabilityContext;
  };
};

export const app = new Hono<AppEnv>();

app.use("*", requestLogger);
// CORS must run before auth: a preflight OPTIONS carries no credentials, so
// it has to short-circuit here or the browser never sends the real request.
app.use("*", corsMiddleware);
app.onError(errorMiddleware);

// Public routes — health and Stripe webhook bypass auth. The webhook needs
// the raw body for signature verification and is its own auth surface.
app.route("/health", health);
app.route("/webhooks/stripe", stripeWebhook);
// GitHub App webhook: single global URL, resolves connections from the payload's
// installation id. Mounted BEFORE the generic /webhooks route so "/webhooks/github/app"
// is not captured as connectorId=github, connectionId=app.
app.route("/webhooks/github/app", githubAppWebhookRoute);
// GitLab project webhooks (#3762): one hook per connected project, authenticated
// by its secret token. Mounted BEFORE the generic /webhooks route for the same reason.
app.route("/webhooks/gitlab", gitlabWebhookRoute);
// Connector webhooks: unauthenticated — HMAC validation is the security boundary.
app.route("/webhooks", webhookRoute);
// Inngest cloud polls /api/inngest for the function manifest; signing-key
// verification is enforced inside the inngest/hono serve handler.
app.route("/api/inngest", inngestRoute);

// SCIM 2.0 provisioning (#3734). An identity provider holds no session and no
// API key: the organization's SCIM bearer token is the boundary, resolved
// inside the route, so it is mounted before the auth-gated /v1 groups. The
// app proxies https://app.oxagen.sh/api/scim/v2/* here. The ceiling keys on
// the Authorization header, so one token cannot drown another organization's
// provisioning; Okta and Entra ID push well under 600 requests a minute.
app.use(
  "/api/scim/v2/*",
  distributedRateLimiter({
    keyPrefix: "scim-preauth-credential",
    max: 600,
    bucketKey: authorizationFingerprintBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);
app.route("/api/scim/v2", scimRoute);

// Public CLI token exchange — no auth middleware (the code + PKCE verifier are
// the security boundary; RFC 8252 + RFC 7636 S256). Must be mounted BEFORE the
// auth-gated /v1 groups so authMiddleware never sees this path.
app.route("/v1/auth/cli", authCliTokenRoute);

// Public, anonymous CLI usage telemetry (OSS trust surface — TELEMETRY.md).
// No auth is possible (OSS/BYOK users may have no session) or wanted (the
// payload is anonymous by design) — strict schema validation + a per-IP rate
// limit inside the route are the security boundary. Mounted BEFORE the
// auth-gated /v1 groups for the same reason as /v1/auth/cli above.
app.route("/v1/telemetry", telemetryUsageRoute);

// Public marketing lead gate for oxagen.sh (demo form + ebook gate). No
// session: Zod allowlist + per-IP rate limit inside the route are the
// boundary. Mounted before the auth-gated /v1 groups so a visitor never
// gets a 401 Missing credentials.
app.route("/v1/cms", cmsRoute);

// Public run export download (get_run_export's URL). No session: an outside
// auditor fetches the bundle with the link alone. The signed, expiring token
// in the query is the boundary. Mounted before the auth-gated /v1 groups for
// the same reason as /v1/auth/cli above.
//
// The IP-keyed pre-auth ceiling sits above the mount because Hono runs
// middleware in registration order, and a limiter registered after the route
// would not wrap it. IP only: the URL carries no Authorization header, so a
// credential bucket would pool every caller into one counter. `methods: "all"`
// because the route is a GET and the limiter counts POST alone by default.
// Each hit streams a whole bundle, so the ceiling is well under the ingest
// one; an attributable caller gets 300 downloads a minute, and an
// unattributable one skips the counter rather than sharing a bucket, the same
// rule as every other pre-auth mount.
app.use(
  "/v1/run-exports/download",
  distributedRateLimiter({
    keyPrefix: "run-export-preauth-ip",
    max: 300,
    bucketKey: trustedClientIpBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);
app.route("/v1/run-exports/download", runExportDownloadRoute);

// Shared pre-authentication ceilings for credential stuffing on Stella intake.
// Register both on the concrete root path before the auth-gated subrouter:
// Hono preserves parent registration order, so exhausted buckets never reach
// API-key resolution. The generous trusted-IP ceiling keeps shared enterprise
// NATs usable; the credential fingerprint limits one abused key across IPs.
app.use(
  "/v1/telemetry/stella/*",
  distributedRateLimiter({
    keyPrefix: "stella-preauth-ip",
    max: 3_000,
    bucketKey: trustedClientIpBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);
app.use(
  "/v1/telemetry/stella/*",
  distributedRateLimiter({
    keyPrefix: "stella-preauth-credential",
    max: 60,
    bucketKey: authorizationFingerprintBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);

// A machine with a single-use enrollment token has no credential to
// authenticate with yet (#2967): the token in the body is the boundary. The
// route carries its own pre-auth ceilings (per token, per client IP). It is
// mounted before the auth-gated /v1 group, which would answer it 401, and
// before the /v1/tacho/* ceilings below, whose credential bucket it would
// otherwise share with every caller that sends no Authorization header.
app.route("/v1/tacho/enroll", tachoHostEnrollRoute);

// Post-auth ceilings for an enrolled Tacho host, in requests/minute. Constants
// for the same reason as STELLA_TELEMETRY_PER_MIN below: ADR-043 retired
// RATE_LIMIT_AGENT_EXEC_PER_MIN, whose value this limiter used to borrow, and a
// drain rate belongs to the ingress rather than to a per-deployment knob.
//
// Two buckets, not one. Until 2026-09-18 events, bundle and commands shared a
// single 30/min counter per host, and two things went wrong with that on the
// same day. A daemon on an old wire (`tacho.commands.v1`) got 3,683 HTTP 400s
// on its command poll in 2.5 h; every one of them counted, so the host's
// event ingest was throttled by a poll that could never succeed. And a host
// running hundreds of parallel Claude sessions spooled 35,380 frames, which at
// 30 batches of 200 a minute is a ceiling of 6,000 frames/min before the
// backlog can even hold steady. Ingest is the evidence path and gets its own
// budget; the control paths (bundle refresh, command poll) keep the old one,
// so a retry storm on either can no longer starve the other.
const TACHO_HOST_PER_MIN = 30;
const TACHO_INGEST_PER_MIN = 120;

// Tacho hosts speak to Oxagen with their enrolled API key, whose scope pins
// org and workspace, so the machine routes sit on a static path outside the
// slug group. Same pre-auth ceilings as the Stella intake: a per-IP bucket
// for shared NATs and a per-credential bucket for one abused key. The
// credential bucket is the sum of the post-auth budgets: it sees every
// request the enrolled key makes across all three paths, so anything lower
// would be the operative ceiling for a healthy host and would put the two
// buckets below back into one.
//
// Registered HERE, above `app.route("/v1", userScoped)`, and not beside the
// `/v1/tacho` mount further down. `userScoped` applies `authMiddleware` on
// `*`, which becomes a `/v1/*` matcher covering `/v1/tacho/*` too, and Hono
// runs matching middleware in registration order. Registered after that mount
// these ran AFTER authentication, so the ceiling a credential-stuffing attacker
// is supposed to hit never saw one unauthenticated request — every bad
// credential was rejected by auth first and counted against nothing. Keep them
// above that mount or they stop being pre-auth.
app.use(
  "/v1/tacho/*",
  distributedRateLimiter({
    keyPrefix: "tacho-preauth-ip",
    max: 6_000,
    bucketKey: trustedClientIpBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);
app.use(
  "/v1/tacho/*",
  distributedRateLimiter({
    keyPrefix: "tacho-preauth-credential",
    max: TACHO_INGEST_PER_MIN + TACHO_HOST_PER_MIN,
    bucketKey: authorizationFingerprintBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);

app.use(
  "/v1/run-ingest/*",
  distributedRateLimiter({
    keyPrefix: "ledger-preauth-ip",
    max: 6000,
    bucketKey: trustedClientIpBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);
app.use(
  "/v1/run-ingest/*",
  distributedRateLimiter({
    keyPrefix: "ledger-preauth-credential",
    max: 120,
    bucketKey: authorizationFingerprintBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);

// /v1 user-level routes (org + workspace CRUD) require auth but no
// org scope: a freshly-authenticated user can create their first
// org without one existing.
const userScoped = new Hono<AppEnv>();
userScoped.use("*", authMiddleware);
userScoped.route("/organizations", organizationCreateRoute);
// Credential probe + identity echo (auth-only, no scope). Works for both
// session and API-key auth — unlike the user.preferences/org.list pickers
// below, it never requires a userId, so a machine (API-key) client can use it
// to validate its key. This is the canonical `oxagen login` validation probe.
userScoped.route("/auth/whoami", authWhoamiRoute);
// Pre-org tenant + workspace pickers for the CLI linker (auth-only, no scope).
userScoped.route("/user/organizations", orgListRoute);
userScoped.route("/user/workspaces", workspaceListRoute);
userScoped.route("/user/preferences/read", userPreferencesReadRoute);
userScoped.route("/user/preferences", userPreferencesSetRoute);
userScoped.route("/user/profile", userProfileUpdateRoute);
// Per-turn dollar budget (user-scoped default).
userScoped.route("/user/budget/read", budgetPolicyReadRoute);
userScoped.route("/user/budget/write", budgetPolicyWriteRoute);
// The onboarding gate before an organization exists (#2967): `organization`.
userScoped.route("/onboarding/state", onboardingStateGetRoute);
app.route("/v1", userScoped);

// Post-auth ceiling for enrolled Stella evidence ingress, in requests/minute.
// A constant rather than an env budget: ADR-043 retired the agent runtime and
// with it RATE_LIMIT_AGENT_EXEC_PER_MIN, whose value this limiter used to
// borrow. The two pre-auth ceilings on the same path (just below) are constants
// for the same reason — a drain rate is a property of the ingress, not of a
// per-deployment knob. The value matches the retired budget's default so the
// effective limit is unchanged.
const STELLA_TELEMETRY_PER_MIN = 30;

// Enrolled Stella operational telemetry is machine-to-machine only. The
// workspace API key carries its immutable org+workspace scope, so this static
// path sits outside the human-readable /:org_slug/:workspace_slug group.
const stellaTelemetryScoped = new Hono<AppEnv>();
stellaTelemetryScoped.use("*", authMiddleware);
stellaTelemetryScoped.use(
  "*",
  distributedRateLimiter({
    keyPrefix: "stella-telemetry",
    max: STELLA_TELEMETRY_PER_MIN,
    // Deliberately workspace-wide, unlike the per-host Tacho ceiling below:
    // this bounds a workspace's total evidence ingress rather than any one
    // instance's share of it, and telemetry.stella.ingest.test.ts pins that.
  }),
);
stellaTelemetryScoped.route("/", telemetryStellaIngestRoute);
app.route("/v1/telemetry/stella", stellaTelemetryScoped);

// The post-auth ceilings (TACHO_INGEST_PER_MIN, TACHO_HOST_PER_MIN) are
// declared above the pre-auth mounts, which derive their credential ceiling
// from them.
const ledgerIngress = new Hono<AppEnv>();
ledgerIngress.use("*", authMiddleware);
ledgerIngress.use(
  "*",
  distributedRateLimiter({
    keyPrefix: "ledger-ingest",
    max: 120,
    bucketKey: enrolledMachineBucketKey,
  }),
);
ledgerIngress.route("/", runFramesIngestRoute);
app.route("/v1/run-ingest", ledgerIngress);

const tachoScoped = new Hono<AppEnv>();
tachoScoped.use("*", authMiddleware);
tachoScoped.use(
  "/events",
  distributedRateLimiter({
    keyPrefix: "tacho-ingest",
    max: TACHO_INGEST_PER_MIN,
    // Per HOST, which is what "per enrolled Tacho host" above means. The
    // default derivation keys on workspaceId, so every host enrolled into one
    // workspace would share a single counter.
    bucketKey: enrolledMachineBucketKey,
  }),
);
// One limiter for both control paths: they share the `tacho-host` counter on
// purpose, because together they are one host's control-plane chatter.
const tachoControlLimiter = distributedRateLimiter({
  keyPrefix: "tacho-host",
  max: TACHO_HOST_PER_MIN,
  bucketKey: enrolledMachineBucketKey,
});
tachoScoped.use("/bundle", tachoControlLimiter);
tachoScoped.use("/commands", tachoControlLimiter);
tachoScoped.use(
  "/github-token",
  distributedRateLimiter({
    keyPrefix: "tacho-github-token",
    max: TACHO_HOST_PER_MIN,
    bucketKey: enrolledMachineBucketKey,
  }),
);
tachoScoped.use(
  "/contained-launch",
  distributedRateLimiter({
    keyPrefix: "tacho-contained-launch",
    max: TACHO_HOST_PER_MIN,
    bucketKey: enrolledMachineBucketKey,
  }),
);
tachoScoped.route("/", tachoEventsIngestRoute);
tachoScoped.route("/", tachoBundleGetRoute);
tachoScoped.route("/", tachoGithubTokenIssueRoute);
tachoScoped.route("/", tachoContainedLaunchRegisterRoute);
tachoScoped.route("/", tachoCommandFetchRoute);
app.route("/v1/tacho", tachoScoped);

// Distributed, workspace-keyed rate limiters for the expensive surfaces. Budgets
// are env-tunable (requests/minute) with conservative defaults; the store is
// Postgres so the limit is global across serverless instances (the in-memory
// rateLimiter would only bound each warm instance). `max` is a lazy resolver so
// the env budget is read on the first limited request, not at module load —
// importing app.ts (route tests, tooling) must never require env access.
const chatRateLimiter = distributedRateLimiter({
  keyPrefix: "chat",
  max: () => rateLimitBudgets().chat,
});
// /v1/:org_slug/:workspace_slug/* — org + workspace scoped routes.
const orgScoped = new Hono<AppEnv>();
orgScoped.use("*", authMiddleware, orgMiddleware, workspaceMiddleware);
// Rate limiting: mounted AFTER auth/org/workspace (so orgId/workspaceId are
// populated for keying) and BEFORE the route registrations below — Hono runs
// middleware in registration order, so a limiter registered after a route would
// not wrap it. The limiter counts POST only, so cheap co-located GET reads pass
// through untouched.
orgScoped.use("/chat/*", chatRateLimiter);
orgScoped.route("/workspaces", workspaceCreateRoute);
orgScoped.route("/workspaces/archive", workspaceArchiveRoute);
// Minting an enrollment is an operator action, so it sits behind the session
// auth this router applies — not beside the ingest route, whose API-key gate
// an already-enrolled machine could otherwise use to mint more enrollments.
orgScoped.route("/telemetry/stella/enrollments", telemetryStellaEnrollRoute);
// Tacho operator actions: enrol and revoke hosts, command them, and read the
// fleet. Session auth with the org role checked in the handlers.
orgScoped.route("/tacho/enrollments", tachoEnrollmentCreateRoute);
orgScoped.route("/tacho/enrollments/revoke", tachoEnrollmentRevokeRoute);
// The one-time enrollment token and the onboarding gate (#2967).
orgScoped.route("/tacho/enrollment-tokens", tachoEnrollmentTokenCreateRoute);
orgScoped.route("/onboarding/advance", onboardingAdvanceRoute);
orgScoped.route("/onboarding/first-frame", onboardingFirstFrameGetRoute);
orgScoped.route("/repository/main", repositoryMainBindRoute);
// The read beside the write, on the same path: GET answers the bound repo, the
// install state and the signed GitHub doors; the picker it feeds sits one level
// down, under the installation the workspace acts through.
orgScoped.route("/repository/main", repositoryMainGetRoute);
// The workspace's repositories beyond the main one (MC spec §10.1): the list
// of all of them, and the link and unlink writes for linked repositories.
orgScoped.route("/repositories", repositoryListRoute);
orgScoped.route("/repository/link", repositoryLinkRoute);
orgScoped.route("/repository/unlink", repositoryUnlinkRoute);
// The Repositories page (MC spec §10.1, §10.2, §11.4).
orgScoped.route("/repository/tree", repositoryTreeGetRoute);
orgScoped.route(
  "/repository/production-branch",
  repositoryProductionBranchSetRoute,
);
orgScoped.route("/repository/init-pr", repositoryInitPrOpenRoute);
orgScoped.route("/context/governance-mode", contextGovernanceModeSetRoute);
orgScoped.route(
  "/repository/installation/repositories",
  repositoryInstallationListRoute,
);
// The other half of the connect: which installation this workspace acts
// through. The identity URL the dialog opens always returns a code and never an
// `installation_id`, so a person whose account already carries the App comes
// back with nothing attached — these two offer the choice and settle it.
orgScoped.route(
  "/repository/installation/candidates",
  repositoryInstallationCandidatesRoute,
);
orgScoped.route(
  "/repository/installation/attach",
  repositoryInstallationAttachRoute,
);
// A gitlab.com project connects with a project access token instead of an App
// installation (attach_gitlab_project, #3762).
orgScoped.route("/repository/gitlab/attach", repositoryGitlabAttachRoute);
// Run controls (dispatch_command, list_commands): addressed to runs, agents
// and the workspace rather than to a host, so they sit beside /runs.
orgScoped.route("/commands", tachoCommandDispatchRoute);
orgScoped.route("/commands/list", tachoCommandListRoute);
orgScoped.route("/tacho/hosts", tachoHostListRoute);
orgScoped.route("/tacho/session-policy", tachoSessionPolicyReadRoute);
orgScoped.route("/tacho/session-policy", tachoSessionPolicyWriteRoute);
orgScoped.route("/tacho/sessions", tachoSessionListRoute);
orgScoped.route("/tacho/sessions/get", tachoSessionGetRoute);
// Runs across both stores (the evidence ledger and tacho sessions): the
// Fleet list and the Run header with its frame page.
orgScoped.route("/runs", runListRoute);
orgScoped.route("/runs/get", runGetRoute);
orgScoped.route("/runs/frame-body", runFrameBodyGetRoute);
orgScoped.route("/runs/transcript", runTranscriptGetRoute);
orgScoped.route("/runs/chain", runChainGetRoute);
// One run's frames, live. GET, so EventSource can open it and resume from
// Last-Event-ID; the read underneath is get_run, gates and all.
orgScoped.route("/runs/:run_id/stream", runStreamRoute);
orgScoped.route("/runs/bisect", runBisectRoute);
orgScoped.route("/runs/fork", runForkRoute);
orgScoped.route("/runs/export", runExportRoute);
orgScoped.route("/runs/export-status", runExportGetRoute);
// An operator's seal of a wrapped run, with a kill queued for its agent
// (seal_run, ADR-169).
orgScoped.route("/runs/seal", runSealRoute);
orgScoped.route("/runs/summarize", runSummarizeRoute);
// Spend (ADR-060): the rollup by level, the drill, waste, the statement, one
// run's cost and the price book. All noBillingGate reads of Postgres rollups.
orgScoped.route("/spend", spendGetRoute);
orgScoped.route("/spend/drill", spendDrillRoute);
orgScoped.route("/spend/waste", spendWasteListRoute);
orgScoped.route("/spend/statement/export", spendStatementExportRoute);
// Cost-center chargeback (ADR-142). The list, create, delete, and statement
// are organization-level (`scoped: false`). Set writes the active workspace or
// one of its agents.
orgScoped.route(
  "/spend/cost-center-statement/export",
  spendCostCenterStatementExportRoute,
);
orgScoped.route("/spend/cost-centers", costCenterListRoute);
orgScoped.route("/spend/cost-centers/create", costCenterCreateRoute);
orgScoped.route("/spend/cost-centers/delete", costCenterDeleteRoute);
orgScoped.route("/spend/cost-centers/set", costCenterSetRoute);
// The skills a workspace's harness sessions reported at start (#3098): a
// noBillingGate read of tacho.sessions.
orgScoped.route("/configurations/clone", configurationCloneGetRoute);
orgScoped.route(
  "/configurations/clone/propose",
  configurationCloneProposeRoute,
);
orgScoped.route("/skills/config", skillConfigGetRoute);
orgScoped.route("/skills/config/update", skillConfigUpdateRoute);
orgScoped.route("/skills/search/preview", skillSearchPreviewRoute);
orgScoped.route("/skills", skillListRoute);
// A skill added or replaced as a pull request against the main repository (ADR-090).
orgScoped.route("/skills/propose", skillProposeRoute);
orgScoped.route("/spend/findings", findingListRoute);
orgScoped.route("/spend/findings/evidence", findingEvidenceGetRoute);
orgScoped.route("/spend/findings/fix", findingFixRecordRoute);
orgScoped.route("/spend/findings/dismiss", findingDismissRoute);
orgScoped.route("/runs/cost", runCostGetRoute);
orgScoped.route("/runs/turns", runTurnsGetRoute);
orgScoped.route("/runs/outputs", runOutputsGetRoute);
orgScoped.route("/runs/work", runWorkGetRoute);
// Proof (ADR-064): a run's witness record and the workspace's disclosure grain.
// Both handlers refuse an API-key caller; the session auth above is the path.
orgScoped.route("/runs/proof", runProofGetRoute);
orgScoped.route("/runs/token", runTokenIssueRoute);
orgScoped.route("/evidence/disclosure-grain", evidenceDisclosureGrainSetRoute);
orgScoped.route("/cost/price-entries", costPriceEntryListRoute);
orgScoped.route("/cost/price-entries/set", costPriceEntrySetRoute);
orgScoped.route("/cost/price-entries/remove", costPriceEntryRemoveRoute);
orgScoped.route("/cost/unpriced-models", costUnpricedModelListRoute);
orgScoped.route("/billing/gau-bucket", billingGauBucketGetRoute);
orgScoped.route("/billing/invoices", billingInvoiceListRoute);
// ADR-165: the prepaid orders an enterprise paid for in advance.
orgScoped.route("/billing/prepaid-orders", billingPrepaidOrderListRoute);
// ADR-165: the billing statement for a period, as data and as a file.
orgScoped.route("/billing/statement", billingStatementGetRoute);
orgScoped.route("/billing/statement/export", billingStatementExportRoute);
orgScoped.route("/billing/auto-topup", billingAutoTopupSetRoute);
orgScoped.route("/billing/subscription", billingSubscriptionReadRoute);
orgScoped.route("/billing/contract-rate", billingContractRateGetRoute);
orgScoped.route(
  "/billing/subscription/upgrade/start",
  billingSubscriptionUpgradeStartRoute,
);
orgScoped.route("/billing/credits/purchase", billingCreditsPurchaseRoute);
orgScoped.route("/billing/gau-bucket/purchase", billingGauBucketPurchaseRoute);
orgScoped.route("/billing/usage/breakdown", billingUsageBreakdownRoute);
// Governed-action meter (ADR-052, docs/specs/governed-action-metering.md):
// the rate card, the run->action estimator, and evidence-retention posture.
// All three are noBillingGate reads. This org's position against its own
// terms is /billing/gau-bucket (ADR-055).
orgScoped.route("/billing/actions/rate-card", billingActionRateCardRoute);
orgScoped.route("/billing/actions/estimate", billingActionEstimateRoute);
orgScoped.route("/billing/evidence/retention", billingEvidenceRetentionRoute);
orgScoped.route("/chat/messages", chatMessageSendRoute);
orgScoped.route("/chat/messages/execution", chatMessageExecutionRoute);
orgScoped.route("/chat/stream", chatStreamRoute);
// The shell (#2968): the in-app agent's turn and engine probe, the command
// menu's search, belt definitions and recent runs, the sidebar counts.
orgScoped.route("/assistant/ask", assistantAskRoute);
orgScoped.route("/assistant/engine", assistantEngineGetRoute);
orgScoped.route("/tools/search", toolsSearchRoute);
orgScoped.route("/tools/load", toolsLoadRoute);
orgScoped.route("/shell/nav-counts", shellNavCountsGetRoute);
orgScoped.route("/runs/recent", runRecentListRoute);
orgScoped.route("/conversations", conversationListRoute);
// GET /conversations/:conversationId/files — registered at the same prefix as the
// list route; Hono dispatches by method+full path so it does not clash with the
// bare GET /conversations list or the /conversations/{rename,archive,…} sub-paths.
orgScoped.route("/conversations", conversationFilesListRoute);
// GET /conversations/:conversationId/export — same prefix trick as /files above.
orgScoped.route("/conversations", conversationExportRoute);
orgScoped.route("/conversations/rename", conversationRenameRoute);
orgScoped.route("/conversations/archive", conversationArchiveRoute);
orgScoped.route("/conversations/delete", conversationDeleteRoute);
orgScoped.route("/conversations/purge", conversationPurgeRoute);
// POST /conversations/attachments — link an already-uploaded asset to a conversation.
orgScoped.route("/conversations/attachments", conversationAttachmentAddRoute);
// Agent governance routes live under the org + workspace scope so every call
// inherits the same auth, isolation, and audit envelope as the rest of v1.
orgScoped.route("/agent/tools", agentToolListRoute);
orgScoped.route("/agent/mcp-servers", agentMcpRegisterRoute);
orgScoped.route("/agent/mcp-servers", agentMcpListRoute);
orgScoped.route("/agent/mcp-servers/resolve", agentMcpResolveRoute);
orgScoped.route("/agent/mcp-servers/set-enabled", agentMcpSetEnabledRoute);
orgScoped.route("/agent/mcp-servers/delete", agentMcpDeleteRoute);
orgScoped.route("/agent/mcp-registry", agentMcpRegistrySearchRoute);
orgScoped.route(
  "/agent/mcp-servers/authorize/start",
  agentMcpAuthorizeStartRoute,
);
orgScoped.route(
  "/agent/mcp-servers/authorize/complete",
  agentMcpAuthorizeCompleteRoute,
);
orgScoped.route("/agent/mcp-consents/resolve", agentMcpConsentResolveRoute);
orgScoped.route("/agent/mcp-consents", agentMcpConsentListRoute);
orgScoped.route("/agent/memory/recall", agentMemoryRecallRoute);
orgScoped.route("/agent/memory/list", agentMemoryListRoute);
orgScoped.route("/agent/memory/update", agentMemoryUpdateRoute);
orgScoped.route("/agent/memory/delete", agentMemoryDeleteRoute);
orgScoped.route("/agent/memory/remember", agentMemoryRememberRoute);
orgScoped.route("/agent/memory/policy", agentMemoryPolicyReadRoute);
orgScoped.route("/agent/memory/policy", agentMemoryPolicyWriteRoute);
// Bulk import: parse uploaded docs → drafts, commit the confirmed set. Mounted
// before the "/agent/memory" catch-all so the more specific paths win.
orgScoped.route("/agent/memory/import/parse", agentMemoryImportParseRoute);
orgScoped.route("/agent/memory/import/commit", agentMemoryImportCommitRoute);
orgScoped.route("/agent/memory/promote", agentMemoryPromoteRoute);
orgScoped.route("/agent/memory/demote", agentMemoryDemoteRoute);
orgScoped.route(
  "/agent/memory/promotion/candidates",
  agentMemoryPromotionCandidatesRoute,
);
orgScoped.route(
  "/agent/memory/promotion/dismiss",
  agentMemoryPromotionDismissRoute,
);
orgScoped.route(
  "/agent/memory/promotion/rationales",
  agentMemoryPromotionRationalesRoute,
);
orgScoped.route("/agent/memory/cite", agentMemoryCiteRoute);
orgScoped.route(
  "/agent/memory/evidence/attach",
  agentMemoryEvidenceAttachRoute,
);
orgScoped.route("/agent/memory/citations/list", agentMemoryCitationsListRoute);
orgScoped.route("/agent/memory/citations/stats", agentMemoryCitationStatsRoute);
orgScoped.route("/agent/memory", agentMemoryWriteRoute);
orgScoped.route("/agent/approvals/list", agentApprovalListRoute);
orgScoped.route("/agent/approvals/resolved", agentApprovalListResolvedRoute);
orgScoped.route("/agent/approvals/resolve", agentApprovalResolveRoute);
orgScoped.route("/agent/execution/record", agentExecutionRecordRoute);
// Agent run-trace span tree: one execution plus its steps and tool calls. The
// list route backs the Activity index.
orgScoped.route("/agent/executions", agentExecutionListRoute);
orgScoped.route("/agent/trace", agentTraceGetRoute);
orgScoped.route("/agent/debug/trace", agentDebugTraceRoute);
// Fleet-wide error triage overview — clusters ClickHouse error_events by
// fingerprint. Pure SQL (ADR-021 §1), the counterpart to agent/debug/trace's
// single-execution failure frame above.
orgScoped.route("/telemetry/error/cluster", telemetryErrorClusterRoute);
// Provider capability posture matrix — what a BYOK-configured vendor actually
// supports (cache opt-in vs implicit, reasoning control, structured output,
// attachments) before work is routed to it.
orgScoped.route("/model/capabilities", modelCapabilityListRoute);
// Agent lifecycle: definitions, deployment, triggers. The /update and /publish
// sub-paths are mounted before the get route so they are not swallowed by its
// GET /:agentId param match.
orgScoped.route("/agent/definitions/update", agentDefinitionUpdateRoute);
orgScoped.route("/agent/definitions/publish", agentDefinitionPublishRoute);
orgScoped.route("/agent/definitions/suggest", agentDefinitionSuggestRoute);
orgScoped.route("/agent/definitions/revise", agentDefinitionReviseRoute);
orgScoped.route("/agent/definitions/summarize", agentDefinitionSummarizeRoute);
orgScoped.route("/agent/definitions/delete", agentDefinitionDeleteRoute);
orgScoped.route("/agent/definitions", agentDefinitionCreateRoute);
orgScoped.route("/agent/definitions", agentDefinitionListRoute);
orgScoped.route("/agent/definitions", agentDefinitionGetRoute);
// Agent RBAC role assignment (docs/specs/agent-rbac/spec.md §3.2): attach/
// detach/inspect IAM roles on an agent's delegated principal. The /assign,
// /revoke and /get sub-paths are mounted before the base list route so its
// GET / never swallows them.
orgScoped.route("/agent/roles/assign", agentRoleAssignRoute);
orgScoped.route("/agent/roles/revoke", agentRoleRevokeRoute);
orgScoped.route("/agent/roles/get", agentRoleGetRoute);
orgScoped.route("/agent/roles", agentRoleListRoute);
orgScoped.route("/agent/deploy", agentDeployRoute);
// Agent identity (MC spec §6.2, #2956): the identities table, one identity
// with its credentials, roles, hosts and definition of record, the identity
// writes (register, rotate, suspend, retire), the definition commit and the
// computed belt. Session auth; the org role is checked in each write handler.
orgScoped.route("/agents/get", agentGetRoute);
orgScoped.route("/agents/register", agentRegisterRoute);
orgScoped.route("/agents/credential/rotate", agentCredentialRotateRoute);
orgScoped.route("/agents/suspend", agentSuspendRoute);
orgScoped.route("/agents/retire", agentRetireRoute);
orgScoped.route("/agents/definition/commit", agentDefinitionCommitRoute);
// New agent: the definition as a pull request against the main repository, never a row.
orgScoped.route("/agents/propose", agentProposeRoute);
orgScoped.route("/agents/toolbelt", agentToolbeltGetRoute);
orgScoped.route("/agents", agentListRoute);
// Tamper and integrity incidents on the workspace's hosts.
orgScoped.route("/tacho/incidents", tachoIncidentListRoute);
// Verified-Outcome Market Router governance + inspection.
orgScoped.route("/router/policy/set", routerPolicySetRoute);
orgScoped.route("/router/policy", routerPolicyGetRoute);
orgScoped.route("/router/stats", routerStatsListRoute);
orgScoped.route("/router/preview", routerDecisionPreviewRoute);
orgScoped.route("/command/menu/search", commandMenuSearchRoute);
orgScoped.route("/command/menu/suggest", commandMenuSuggestRoute);
orgScoped.route("/reference/search", referenceSearchRoute);
orgScoped.route("/system/install-instructions", systemInstallInstructionsRoute);
orgScoped.route("/org/members", orgMemberAddRoute);
orgScoped.route("/org/members/remove", orgMemberRemoveRoute);
orgScoped.route("/org/members/role", orgMemberRoleChangeRoute);
orgScoped.route("/org/invitations/accept", orgMemberInviteAcceptRoute);
orgScoped.route("/org/invitations/decline", orgMemberInviteDeclineRoute);
orgScoped.route("/org/invitations/revoke", revokeMemberInviteRoute);
orgScoped.route("/org/invitations/resend", resendMemberInviteRoute);
orgScoped.route("/workspace/budget-policy", workspaceBudgetPolicyReadRoute);
orgScoped.route("/workspace/budget-policy", workspaceBudgetPolicyWriteRoute);
// Hard period-to-date spend ceilings (org + workspace, OXA-1079).
orgScoped.route("/billing/budget", billingBudgetGetRoute);
orgScoped.route("/billing/budget", billingBudgetSetRoute);
// Per-(user, workspace) coding-agent defaults (org+workspace scoped).
orgScoped.route(
  "/user/workspace-preferences",
  userWorkspacePreferencesReadRoute,
);
orgScoped.route(
  "/user/workspace-preferences",
  userWorkspacePreferencesWriteRoute,
);
orgScoped.route("/workspace/model-settings", workspaceModelSettingsReadRoute);
orgScoped.route("/workspace/model-settings", workspaceModelSettingsWriteRoute);
orgScoped.route("/workspace/prompt-settings", promptSettingsReadRoute);
orgScoped.route("/workspace/prompt-settings", promptSettingsWriteRoute);
orgScoped.route("/org/settings", orgSettingsReadRoute);
orgScoped.route("/org/data-plane", orgDataPlaneRoute);
orgScoped.route("/org/model-credential", orgModelCredentialRoute);
orgScoped.route("/org/sso", orgSsoRoute);
orgScoped.route("/org/settings", orgSettingsWriteRoute);
orgScoped.route("/run-outcomes/settings", runOutcomesSettingsRoute);
orgScoped.route("/workspace/settings", workspaceSettingsReadRoute);
orgScoped.route("/workspace/settings", workspaceSettingsWriteRoute);
orgScoped.route("/asset/upload", assetUploadRoute);
orgScoped.route("/plugin/registries", pluginRegistryListRoute);
orgScoped.route("/plugin/registries/add", pluginRegistryAddRoute);
orgScoped.route("/plugin/registries/remove", pluginRegistryRemoveRoute);
orgScoped.route("/plugin/catalog/browse", pluginCatalogBrowseRoute);
orgScoped.route("/plugin/catalog/get", pluginCatalogGetRoute);
orgScoped.route("/plugin/catalog/sync", pluginCatalogSyncRoute);
orgScoped.route("/plugin/org/list", pluginOrgListRoute);
orgScoped.route("/plugin/org/install", pluginOrgInstallRoute);
orgScoped.route("/plugin/org/install-bulk", pluginOrgInstallBulkRoute);
orgScoped.route("/plugin/org/uninstall", pluginOrgUninstallRoute);
orgScoped.route("/plugin/set-enabled", pluginSetEnabledRoute);
orgScoped.route(
  "/plugin/credential/set-secret",
  pluginCredentialSetSecretRoute,
);
orgScoped.route("/plugin/credential/reauth", pluginCredentialReauthRoute);
orgScoped.route("/plugin/credential/revoke", pluginCredentialRevokeRoute);
// Environments + credential vault.
orgScoped.route("/environment/create", environmentCreateRoute);
orgScoped.route("/environment/list", environmentListRoute);
orgScoped.route("/environment/get", environmentGetRoute);
orgScoped.route("/environment/update", environmentUpdateRoute);
orgScoped.route("/environment/delete", environmentDeleteRoute);
orgScoped.route("/environment/set-default", environmentSetDefaultRoute);
// Agent ↔ environment bindings.
orgScoped.route("/agent/environment/bind", agentEnvironmentBindRoute);
orgScoped.route("/agent/environment/unbind", agentEnvironmentUnbindRoute);
orgScoped.route("/agent/environment/list", agentEnvironmentListRoute);
orgScoped.route("/secret/key/upsert", secretKeyUpsertRoute);
orgScoped.route("/secret/key/list", secretKeyListRoute);
orgScoped.route("/secret/key/delete", secretKeyDeleteRoute);
orgScoped.route("/secret/value/set", secretValueSetRoute);
orgScoped.route("/secret/value/unset", secretValueUnsetRoute);
orgScoped.route("/secret/import-env", secretImportEnvRoute);
orgScoped.route("/secret/reveal", secretRevealRoute);
orgScoped.route("/secret/export", secretExportRoute);
orgScoped.route("/notifications", notificationsListRoute);
orgScoped.route("/notifications/mark", notificationsMarkRoute);
orgScoped.route(
  "/plugin/settings/auth-alerts",
  pluginSettingsSetAuthAlertsRoute,
);
// GET on the same path reads the setting (separate thin adapter per capability).
orgScoped.route(
  "/plugin/settings/auth-alerts",
  pluginSettingsGetAuthAlertsRoute,
);
// Typed-contract registry reads — the governance catalog's data source.
orgScoped.route("/capability/registry/list", capabilityRegistryListRoute);
orgScoped.route("/capability/registry/get", capabilityRegistryGetRoute);
// IAM roles read (read-only; writes remain provisioning-script-only).
orgScoped.route("/iam/roles/list", iamRoleListRoute);
// The role editor (ADR-063): create, replace grants, delete.
orgScoped.route("/iam/roles", iamRoleCreateRoute);
orgScoped.route("/iam/roles/grants", iamRoleGrantsSetRoute);
orgScoped.route("/iam/roles/delete", iamRoleDeleteRoute);
orgScoped.route("/api-keys", apiKeyCreateRoute);
// GET on the same path lists the keys in scope (separate thin adapter per capability).
orgScoped.route("/api-keys", apiKeyListRoute);
orgScoped.route("/api-keys/revoke", apiKeyRevokeRoute);
orgScoped.route("/api-keys/rotate", apiKeyRotateRoute);
orgScoped.route("/workspace/member/list", listMembersRoute);
orgScoped.route("/workspace/invite/send", workspaceInviteSendRoute);
orgScoped.route("/conversation/chat", conversationChatRoute);
orgScoped.route("/tool/declaration/publish", toolDeclarationPublishRoute);
// Mandates: bounded, expiring authority for a consequence, with a ledger
// (MC spec §6.9 part 3, ADR-059).
orgScoped.route("/mandates/grant", mandateGrantRoute);
orgScoped.route("/mandates/request", mandateRequestRoute);
orgScoped.route("/mandates/list", mandateListRoute);
orgScoped.route("/mandates/get", mandateGetRoute);
orgScoped.route("/mandates/revoke", mandateRevokeRoute);
orgScoped.route("/mandates/limits/update", mandateLimitsUpdateRoute);
orgScoped.route("/approval-rules/list", approvalRuleListRoute);
orgScoped.route("/approval-rules/set", approvalRuleSetRoute);
orgScoped.route("/approval-rules/delete", approvalRuleDeleteRoute);
orgScoped.route("/approval-rules/enabled/set", approvalRuleEnabledSetRoute);
orgScoped.route("/approvals/auto-eligibility", approvalAutoEligibilityGetRoute);
orgScoped.route("/tool/declaration/list", toolDeclarationListRoute);
// Tools lane (#2958): registry, classification, import, the broker's grants, kill switches.
orgScoped.route("/tools/versions", toolVersionListRoute);
orgScoped.route("/tools/versions/classification", toolClassificationSetRoute);
orgScoped.route("/tools/import", toolImportRoute);
orgScoped.route("/credential-grants", credentialGrantListRoute);
orgScoped.route("/kill-switches", killSwitchSetRoute);
orgScoped.route("/kill-switches/list", killSwitchListRoute);
orgScoped.route("/context/record/publish", contextRecordPublishRoute);
orgScoped.route("/context/record/list", contextRecordListRoute);
orgScoped.route("/context/record/promote", contextRecordPromoteRoute);
orgScoped.route("/context/record/revise", contextRecordReviseRoute);
// Steering (ADR-061): published records, proposals, the Context PR.
orgScoped.route("/context/records", contextRecordsListRoute);
orgScoped.route("/context/records/get", contextRecordsGetRoute);
orgScoped.route("/context/records/append", contextRecordsAppendRoute);
orgScoped.route("/context/steering/freshness", contextSteeringFreshnessRoute);
orgScoped.route("/context/steering/deliveries", contextSteeringDeliveriesRoute);
orgScoped.route("/context/proposals", contextProposalListRoute);
orgScoped.route("/context/proposals/create", contextProposalCreateRoute);
orgScoped.route("/context/proposals/dismiss", contextProposalDismissRoute);
orgScoped.route("/context/prs/open", contextPrOpenRoute);
orgScoped.route("/context/prs/get", contextPrGetRoute);
orgScoped.route("/context/prs/merge", contextPrMergeRoute);
orgScoped.route("/privacy/export", privacyDataExportRoute);
orgScoped.route("/privacy/erase", privacyDataEraseRoute);
orgScoped.route("/connections", connectionRoute);
// GitHub App OAuth endpoints (workspace-scoped + auth-required)
orgScoped.route("/connections/github", githubOauthRoute);
orgScoped.route("/graph/node/get", graphNodeGetRoute);
orgScoped.route("/graph/node/search", graphNodeSearchRoute);
orgScoped.route("/graph/search", graphSearchRoute);
orgScoped.route("/repos", repoRoute);
orgScoped.route("/integrations", integrationRoute);
orgScoped.route("/schema", schemaRoute);
orgScoped.route("/plugin-schema", pluginSchemaRoute);
orgScoped.route("/plugin-versions", pluginVersionRoute);
orgScoped.route("/graph/nodes", graphNodeListRoute);
orgScoped.route("/graph/stats", graphStatsRoute);
orgScoped.route("/ontology/query", ontologyQueryRoute);
orgScoped.route("/ontology/neighbors", ontologyNeighborsRoute);
orgScoped.route("/audit/log/query", auditLogQueryRoute);
orgScoped.route("/audit/events/export", auditEventsExportRoute);
// Creating a workspace needs an org and cannot need a workspace: the caller is
// asking for their first one. Mounted only under the workspace-scoped group, the
// REST surface could not take a new account past org creation — every attempt
// 404'd in workspaceMiddleware before the handler ran, so a non-browser client
// had to drive the web UI or write rows by hand (#1203).
//
// The workspace-scoped mount above stays. Creating a workspace while scoped to
// another one is an odd shape, but it is a path clients may already call, and
// this change is about opening the bootstrap route rather than closing that one.
const orgOnlyScoped = new Hono<AppEnv>();
orgOnlyScoped.use("*", authMiddleware, orgMiddleware);
orgOnlyScoped.route("/workspaces", workspaceCreateRoute);
// The onboarding gate for an organization (#2967): its gate row.
orgOnlyScoped.route("/onboarding/state", onboardingStateGetRoute);
// An audit export answers for the whole organization, and the documented path
// is `POST /v1/:org_slug/audit/events/export`. Mounted only on the
// workspace-scoped group above, that URL matched no route and 404'd, leaving
// the advertised REST surface unreachable (#3097).
orgOnlyScoped.route("/audit/events/export", auditEventsExportRoute);
app.route("/v1/:org_slug", orgOnlyScoped);

app.route("/v1/:org_slug/:workspace_slug", orgScoped);

// Public OAuth callback — HMAC-verified state param is the security boundary.
// Must NOT be inside the workspace-scoped group (user has no session when GitHub redirects).
app.route("/oauth/github", githubOauthCallbackRoute);
