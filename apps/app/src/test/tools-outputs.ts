// Contract-parsed outputs of the three #2958 reads, `list_approval_rules` and
// the three connection and server reads,
// for the tests of the Tools port and the Tools page. Each record goes through
// its contract's own output schema, so a fixture that drifts from the contract
// fails here rather than in the view.
import { agentMcpList } from "@oxagen/oxagen/contracts/agent.mcp.list";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { connectionGet } from "@oxagen/oxagen/contracts/connection.get";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";

type ToolVersionListOutput = ReturnType<typeof toolVersionList.output.parse>;
type CredentialGrantListOutput = ReturnType<
  typeof credentialGrantList.output.parse
>;
type KillSwitchListOutput = ReturnType<typeof killSwitchList.output.parse>;
type ApprovalRuleListOutput = ReturnType<typeof approvalRuleList.output.parse>;
type ConnectionListOutput = ReturnType<typeof connectionList.output.parse>;
type ConnectionGetOutput = ReturnType<typeof connectionGet.output.parse>;
type McpServerListOutput = ReturnType<typeof agentMcpList.output.parse>;

export function toolVersionListOutput(
  over: Partial<ToolVersionListOutput> = {},
): ToolVersionListOutput {
  return toolVersionList.output.parse({
    items: [
      {
        id: "tlv_01k5a1",
        toolId: "tol_01k5a1",
        slug: "stripe__create_payment",
        name: "Create payment",
        description: "Charges a customer.",
        version: 4,
        source: "mcp",
        serverId: "mcs_01k5s1",
        capabilityId: "mcp.stripe.create_payment",
        readOnly: false,
        riskGrade: "critical",
        classification: {
          sideEffect: "irreversible",
          egress: "third_party",
          consequenceTags: ["moves_money"],
          measures: {
            amount: {
              path: "$.amount",
              type: "money",
              currencyPath: "$.currency",
            },
          },
          // Free text, and deliberately multiword: a data class is not a
          // token, and a form that splits on whitespace destroys this one.
          dataClasses: ["customer financial data", "payment"],
        },
        classifiedAt: "2026-09-01T09:00:00.000Z",
        schemaOrigin: "imported",
        schemaDigest: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        enabled: true,
        gate: { kind: "killed_class", switchId: "emd_01k5c1" },
        calls30d: 1204,
        updatedAt: "2026-09-10T09:00:00.000Z",
      },
      {
        id: "tlv_01k5a2",
        toolId: "tol_01k5a2",
        slug: "github__get_file_contents",
        name: "Get file contents",
        description: null,
        version: 3,
        source: "mcp",
        serverId: "mcs_01k5s2",
        capabilityId: "mcp.github.get_file_contents",
        readOnly: true,
        riskGrade: "low",
        classification: null,
        classifiedAt: null,
        schemaOrigin: "declared",
        schemaDigest: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        enabled: true,
        gate: { kind: "open", switchId: null },
        calls30d: null,
        updatedAt: "2026-09-09T09:00:00.000Z",
      },
    ],
    nextCursor: null,
    ...over,
  });
}

export function credentialGrantListOutput(
  over: Partial<CredentialGrantListOutput> = {},
): CredentialGrantListOutput {
  return credentialGrantList.output.parse({
    items: [
      {
        id: "mcgr_01k5g1",
        connectionId: "mcrd_01k5c9",
        serverId: "mcs_01k5s2",
        serverName: "github",
        runId: "arun_01k5r7",
        scope: {
          endpointUrl: "https://api.github.com",
          authKind: "oauth",
          downscope: "token_exchange",
        },
        providerTokenId: null,
        issuedAt: "2026-09-11T09:14:09.000Z",
        expiresAt: "2026-09-11T09:19:09.000Z",
        revokedAt: null,
        status: "expired",
      },
      {
        id: "mcgr_01k5g2",
        connectionId: "mcrd_01k5ca",
        serverId: "mcs_01k5s1",
        serverName: "stripe",
        runId: null,
        scope: {
          endpointUrl: "https://api.stripe.com",
          authKind: "secret",
          downscope: "none",
        },
        providerTokenId: null,
        issuedAt: "2026-09-11T08:40:19.000Z",
        expiresAt: "2026-09-11T08:50:19.000Z",
        revokedAt: "2026-09-11T08:42:00.000Z",
        status: "revoked",
      },
    ],
    nextCursor: null,
    ...over,
  });
}

export function killSwitchListOutput(
  over: Partial<KillSwitchListOutput> = {},
): KillSwitchListOutput {
  return killSwitchList.output.parse({
    denyGeneration: { org: 12, workspace: 4 },
    switches: [
      {
        id: "emd_01k5c1",
        target: { kind: "class", id: "moves_money" },
        scope: "org",
        on: true,
        reason: "Suspected compromise of the Stripe restricted key.",
        flippedBy: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        flippedAt: "2026-09-11T15:02:00.000Z",
        clearedAt: null,
        clearedBy: null,
      },
      {
        id: "emd_01k5c2",
        // A workspace switch reaches past the workspace it was flipped in, so
        // the record writes it org-wide — `switchWorkspaceOf`,
        // packages/handlers/src/kill_switch.set.ts. Its scope is "org" for the
        // same reason a class switch's is.
        target: {
          kind: "workspace",
          id: "7b000000-0000-4000-8000-000000000001",
        },
        scope: "org",
        on: false,
        reason: "Rotation confirmed; the security owner signed off.",
        flippedBy: null,
        flippedAt: "2026-09-02T08:30:00.000Z",
        clearedAt: "2026-09-03T08:30:00.000Z",
        clearedBy: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      },
      {
        // A tool-server switch is one of the four written under the caller's
        // workspace, so it is the workspace generation that names when it
        // takes effect.
        id: "emd_01k5c3",
        target: { kind: "tool_server", id: "mcs_01k5s1" },
        scope: "workspace",
        on: false,
        reason: "The vendor rotated the manifest without a pin.",
        flippedBy: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        flippedAt: "2026-08-20T11:00:00.000Z",
        clearedAt: "2026-08-21T11:00:00.000Z",
        clearedBy: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      },
    ],
    ...over,
  });
}

export function approvalRuleListOutput(
  over: Partial<ApprovalRuleListOutput> = {},
): ApprovalRuleListOutput {
  return approvalRuleList.output.parse({
    items: [
      {
        id: "small-refunds",
        name: "Small refunds to known customers",
        tools: ["stripe__create_refund@*"],
        enabled: true,
        maxMeasures: { amount: "50000000" },
        allowTargets: { counterparty: ["cus_*", "vendor:aws"] },
        standingWindowMs: null,
        businessHours: {
          timezone: "Europe/London",
          days: [1, 2, 3, 4, 5],
          start: "09:00",
          end: "17:00",
        },
        createdBy: "usr_01k5a1",
        createdAt: "2026-09-12T10:00:00.000Z",
        authoredConsequences: ["moves_money"],
        hits30d: 212,
        skipped30d: 9,
      },
      {
        // Off, with a standing window and nothing else, written by no person,
        // and carrying no stamp: the row that says it releases nothing.
        id: "repeat-deploys",
        name: "Repeat deploys to staging",
        tools: ["deploy__release"],
        enabled: false,
        maxMeasures: {},
        allowTargets: {},
        standingWindowMs: 3_600_000,
        businessHours: null,
        createdBy: null,
        createdAt: "2026-09-01T08:00:00.000Z",
        hits30d: 0,
        skipped30d: 4,
      },
    ],
    windowDays: 30,
    ...over,
  });
}

export function connectionListOutput(
  over: Partial<ConnectionListOutput> = {},
): ConnectionListOutput {
  return connectionList.output.parse({
    connections: [
      {
        id: "7c000000-0000-4000-8000-0000000000c1",
        publicId: "con_01k5n1",
        connectorId: "github",
        displayName: "Acme GitHub",
        authScheme: "bearer_token",
        deliveryMethod: "webhook",
        status: "connected",
        entityCount: 482,
        lastSyncAt: "2026-09-18T09:00:00.000Z",
        healthStatus: "healthy",
        lastPollAt: "2026-09-18T09:00:00.000Z",
        nextPollAt: "2026-09-19T09:00:00.000Z",
        createdAt: "2026-08-01T09:00:00.000Z",
      },
      {
        // Never polled, never synced: every instant the record may leave out.
        id: "7c000000-0000-4000-8000-0000000000c2",
        publicId: "con_01k5n2",
        connectorId: "stripe",
        displayName: "Acme Stripe",
        authScheme: "api_key",
        deliveryMethod: "poll",
        status: "pending_setup",
        entityCount: 0,
        lastSyncAt: null,
        healthStatus: "degraded",
        lastPollAt: null,
        nextPollAt: null,
        createdAt: "2026-09-18T09:00:00.000Z",
      },
    ],
    ...over,
  });
}

export function connectionGetOutput(
  over: Partial<ConnectionGetOutput> = {},
): ConnectionGetOutput {
  return connectionGet.output.parse({
    id: "7c000000-0000-4000-8000-0000000000c1",
    publicId: "con_01k5n1",
    connectorId: "github",
    displayName: "Acme GitHub",
    authScheme: "bearer_token",
    deliveryMethod: "webhook",
    deliveryConfig: { installationId: "42" },
    status: "connected",
    entityCount: 482,
    lastSyncAt: "2026-09-18T09:00:00.000Z",
    errorMessage: null,
    healthStatus: "healthy",
    consecutiveFailureCount: 0,
    lastPollAt: "2026-09-18T09:00:00.000Z",
    nextPollAt: "2026-09-19T09:00:00.000Z",
    lastErrorAt: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-09-18T09:00:00.000Z",
    ...over,
  });
}

export function mcpServerListOutput(
  over: Partial<McpServerListOutput> = {},
): McpServerListOutput {
  return agentMcpList.output.parse({
    servers: [
      {
        publicId: "mcs_01k5s1",
        name: "Stripe",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.stripe.example/v1",
        healthStatus: "healthy",
        lastHealthcheckAt: "2026-09-18T09:00:00.000Z",
        toolCount: 12,
      },
      {
        // The plugin-install shape: transport `sse`, health `unknown`, no
        // health check to date.
        publicId: "mcs_01k5s2",
        name: "GitHub",
        transportType: "sse",
        endpointUrl: "https://mcp.github.example/sse",
        healthStatus: "unknown",
        lastHealthcheckAt: null,
        toolCount: 0,
      },
    ],
    ...over,
  });
}
