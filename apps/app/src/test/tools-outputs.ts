// Contract-parsed outputs of the three #2958 reads, for the tests of the Tools
// port and the Tools page. Each record goes through its contract's own output
// schema, so a fixture that drifts from the contract fails here rather than in
// the view.
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";

type ToolVersionListOutput = ReturnType<typeof toolVersionList.output.parse>;
type CredentialGrantListOutput = ReturnType<
  typeof credentialGrantList.output.parse
>;
type KillSwitchListOutput = ReturnType<typeof killSwitchList.output.parse>;

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
          dataClasses: ["payment"],
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
        target: {
          kind: "workspace",
          id: "7b000000-0000-4000-8000-000000000001",
        },
        scope: "workspace",
        on: false,
        reason: "Rotation confirmed; the security owner signed off.",
        flippedBy: null,
        flippedAt: "2026-09-02T08:30:00.000Z",
        clearedAt: "2026-09-03T08:30:00.000Z",
        clearedBy: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      },
    ],
    ...over,
  });
}
