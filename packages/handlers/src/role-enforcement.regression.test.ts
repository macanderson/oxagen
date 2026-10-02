import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext, CheckedContext } from "@oxagen/oxagen";

const state = vi.hoisted(() => ({
  orgRole: "Member",
  workspaceRole: "Member",
  assignmentReads: 0,
  keyCreator: "creator" as string | null,
  business: vi.fn(() => {
    throw new Error("authorized business operation");
  }),
}));

// Keep both role guards real. Only their stored identities and assignments are
// replaced, so a missing gate reaches the business seam and fails the test.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: async () => {
            if (table === real.schema.orgUsers)
              return [{ role: state.orgRole }];
            if (table === real.schema.workspaceUsers)
              return [{ role: state.workspaceRole }];
            if (table === real.schema.principals) return [{ id: "principal" }];
            if (table === real.schema.apiKeys)
              return [{ createdById: state.keyCreator }];
            if (table === real.schema.principalRoleAssignments) {
              const roleName =
                state.assignmentReads++ === 0
                  ? state.orgRole
                  : state.workspaceRole;
              return [{ roleName }];
            }
            throw new Error("Unexpected authorization table");
          },
        };
        return chain;
      },
    }),
  };
  return {
    ...real,
    withOrgDb: async (fn: (db: typeof tx) => unknown) => fn(tx),
    withSystemDb: async (fn: (db: typeof tx) => unknown) => fn(tx),
    withTenantDb: state.business,
  };
});
vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: vi.fn() }));
vi.mock("@oxagen/plugins", () => ({
  importEnv: state.business,
  deleteSecretKey: state.business,
  upsertSecretKey: state.business,
  deleteWorkspaceSecret: state.business,
}));
vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: state.business,
  pinVersion: state.business,
  isDraftDirty: state.business,
  publishDraft: state.business,
}));
vi.mock("./schema.pinned", () => ({ invalidatePinnedSchemaCache: vi.fn() }));
vi.mock("@oxagen/crypto", () => ({
  resolveIngestionCryptoAdapterForKeyId: state.business,
  decrypt: state.business,
}));
vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: state.business,
}));
vi.mock("@oxagen/agent/runtime/mcp-snapshots", () => ({
  recordServerChange: state.business,
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@oxagen/billing", () => ({
  canAccessACL: (tier: string) => tier === "enterprise",
  resolveOrgTierDetailed: vi.fn(),
}));
vi.mock("@oxagen/iam/fetch-authz", () => ({ fetchAuthz: vi.fn() }));
vi.mock("@oxagen/iam/emit-audit", () => ({
  emitAudit: vi.fn(async () => undefined),
}));
vi.mock("@oxagen/iam/live-agent-run-authorization", () => ({
  evaluateAgentRunAuthorization: vi.fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));

import { checkIAM } from "@oxagen/iam/check-iam";
// Registers every contract, so the role gate can look up the capability the
// context names (#5228).
import "@oxagen/oxagen";
import { connectionPreviewHandler } from "./connection.preview";
import { steeringRecordPublishHandler } from "./steering.record.publish";
import { steeringRecordPromoteHandler } from "./steering.record.promote";
import { handler as revokeCredential } from "./plugin.credential.revoke";
import { routerPolicySetHandler } from "./router.policy.set";
import { schemaToggleHandler } from "./schema.toggle";
import { schemaVersionPinHandler } from "./schema.version.pin";
import { secretImportEnvHandler } from "./secret.import_env";
import { secretKeyDeleteHandler } from "./secret.key.delete";
import { secretKeyUpsertHandler } from "./secret.key.upsert";
import { agentMcpDeleteHandler } from "@oxagen/agent/handlers/agent.mcp.delete";
import { agentMcpRegisterHandler } from "@oxagen/agent/handlers/agent.mcp.register";

const ctx: CapabilityContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: "member",
  apiKeyId: null,
  requestId: "role-regression",
  surface: "api",
  messageId: null,
  planTier: "free",
};
const cases = [
  {
    name: "preview_connection",
    handler: connectionPreviewHandler,
    input: { connectionId: "con_1" },
    workspace: ["Owner"],
    callerGuard: true,
  },
  {
    name: "publish_steering_record",
    handler: steeringRecordPublishHandler,
    input: { record_id: "rule", body: "Require approval" },
    workspace: ["Owner", "Admin"],
  },
  {
    name: "promote_steering_record",
    handler: steeringRecordPromoteHandler,
    input: {},
    workspace: ["Owner", "Admin"],
  },
  {
    name: "revoke_plugin_credential",
    handler: revokeCredential,
    input: { orgListingId: "listing" },
    workspace: [],
    callerGuard: true,
  },
  {
    name: "set_routing_policy",
    handler: routerPolicySetHandler,
    input: {},
    workspace: ["Owner", "Admin"],
  },
  {
    name: "toggle_schema",
    handler: schemaToggleHandler,
    input: {},
    workspace: ["Owner"],
  },
  {
    name: "pin_schema_version",
    handler: schemaVersionPinHandler,
    input: {},
    workspace: ["Owner"],
  },
  {
    name: "import_env_secrets",
    handler: secretImportEnvHandler,
    input: { commit: true },
    workspace: [],
    callerGuard: true,
  },
  {
    name: "delete_secret_key",
    handler: secretKeyDeleteHandler,
    input: {},
    workspace: [],
    callerGuard: true,
  },
  {
    name: "upsert_secret_key",
    handler: secretKeyUpsertHandler,
    input: {},
    workspace: [],
    callerGuard: true,
  },
  {
    name: "delete_mcp_server",
    handler: agentMcpDeleteHandler,
    input: {},
    workspace: ["Owner"],
  },
  // Its handler checked no role until #4180, so any member of an org below
  // Enterprise could add a server. A stdio server skips the network probe,
  // so an admitted caller reaches the insert.
  {
    name: "register_mcp_server",
    handler: agentMcpRegisterHandler,
    input: {
      name: "role-regression",
      transportType: "stdio",
      endpointUrl: "stdio://role-regression",
      authStrategy: "none",
    },
    workspace: ["Owner"],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  state.orgRole = "Member";
  state.workspaceRole = "Member";
  state.assignmentReads = 0;
  state.keyCreator = "creator";
});

describe.each(cases)(
  "$name enforces its role below enterprise (#3458)",
  (entry) => {
    it("refuses a Member after the real IAM tier gate allows the call", async () => {
      const decision = await checkIAM({
        capability: entry.name,
        ctx,
        defaultEffect: "deny",
        rawInputJson: "{}",
      });
      expect(decision.result.outcome).toBe("allow");
      expect(decision.result.trace.decidedBy.rule).toBe("tier_gate");
      await expect(entry.handler(entry.input as never, ctx)).rejects.toThrow(
        /requires/i,
      );
      expect(state.business).not.toHaveBeenCalled();
    });

    it.each(["Owner", "Admin"])(
      "admits org %s to the operation",
      async (role) => {
        state.orgRole = role;
        await expect(entry.handler(entry.input as never, ctx)).rejects.toThrow(
          "authorized business operation",
        );
        expect(state.business).toHaveBeenCalledOnce();
      },
    );

    it("matches the contract for a workspace Viewer", async () => {
      state.workspaceRole = "Viewer";
      const granted = (entry.workspace as readonly string[]).includes("Viewer");
      await expect(entry.handler(entry.input as never, ctx)).rejects.toThrow(
        granted ? "authorized business operation" : /requires/i,
      );
      expect(state.business).toHaveBeenCalledTimes(granted ? 1 : 0);
    });

    // Mac decided on 2026-10-02 that a workspace's Owner and Admin do
    // everything in that workspace (#5228). Every operation here reads or
    // writes one workspace's rows: the connection, the plugin credential and
    // the vault keys are each filtered on the call's workspace id. So the
    // workspace Owner and Admin pass the gate whatever the contract names.
    // The kernel stamps the context with the capability it checked, and
    // assertOrgRole reads it; assertCallerRole reads the contract the handler
    // hands it.
    it.each(["Owner", "Admin"])(
      "admits the workspace %s, as the workspace rule does",
      async (role) => {
        state.workspaceRole = role;
        const checked: CheckedContext = { ...ctx, invokedCapability: entry.name };
        await expect(
          entry.handler(entry.input as never, checked),
        ).rejects.toThrow("authorized business operation");
        expect(state.business).toHaveBeenCalledOnce();
      },
    );

    it("refuses a request with no credential", async () => {
      await expect(
        entry.handler(entry.input as never, { ...ctx, userId: null }),
      ).rejects.toThrow(/authenticated|signed-in/i);
      expect(state.business).not.toHaveBeenCalled();
    });

    it("preserves the family's API-key authorization semantics", async () => {
      const machine = { ...ctx, userId: null, apiKeyId: "key" };
      if (entry.callerGuard) {
        // These families delegate machine authorization to the surface key scope.
        await expect(
          entry.handler(entry.input as never, machine),
        ).rejects.toThrow("authorized business operation");
      } else {
        await expect(
          entry.handler(entry.input as never, machine),
        ).rejects.toThrow(/requires/i);
        expect(state.business).not.toHaveBeenCalled();
        state.orgRole = "Owner";
        state.assignmentReads = 0;
        await expect(
          entry.handler(entry.input as never, machine),
        ).rejects.toThrow("authorized business operation");
      }
    });
  },
);

it("does not let a workspace Owner set the organization routing default", async () => {
  state.workspaceRole = "Owner";
  // Stamped as the kernel stamps it, so the workspace rule would apply if
  // the org scope did not ask for its named roles only (#5228).
  const checked: CheckedContext = {
    ...ctx,
    invokedCapability: "set_routing_policy",
  };
  await expect(
    routerPolicySetHandler({ scope: "org" }, checked),
  ).rejects.toThrow(/requires/i);
  expect(state.business).not.toHaveBeenCalled();
});
