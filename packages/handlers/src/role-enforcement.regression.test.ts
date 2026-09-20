import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

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
vi.mock("./lib/onboarding", () => ({
  assertWorkspaceNotProvisional: state.business,
}));
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
import { connectionPreviewHandler } from "./connection.preview";
import { contextRecordPublishHandler } from "./context.record.publish";
import { contextRecordPromoteHandler } from "./context.record.promote";
import { handler as revokeCredential } from "./plugin.credential.revoke";
import { routerPolicySetHandler } from "./router.policy.set";
import { schemaToggleHandler } from "./schema.toggle";
import { schemaVersionPinHandler } from "./schema.version.pin";
import { secretImportEnvHandler } from "./secret.import_env";
import { secretKeyDeleteHandler } from "./secret.key.delete";
import { secretKeyUpsertHandler } from "./secret.key.upsert";
import { agentMcpDeleteHandler } from "@oxagen/agent/handlers/agent.mcp.delete";

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
    name: "publish_context_record",
    handler: contextRecordPublishHandler,
    input: { record_id: "rule", body: "Require approval" },
    workspace: ["Owner", "Admin"],
  },
  {
    name: "promote_context_record",
    handler: contextRecordPromoteHandler,
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

    it.each(["Owner", "Admin", "Viewer"])(
      "matches the contract for workspace %s",
      async (role) => {
        state.workspaceRole = role;
        await expect(entry.handler(entry.input as never, ctx)).rejects.toThrow(
          (entry.workspace as readonly string[]).includes(role)
            ? "authorized business operation"
            : /requires/i,
        );
        expect(state.business).toHaveBeenCalledTimes(
          (entry.workspace as readonly string[]).includes(role) ? 1 : 0,
        );
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
  await expect(routerPolicySetHandler({ scope: "org" }, ctx)).rejects.toThrow(
    /requires/i,
  );
  expect(state.business).not.toHaveBeenCalled();
});
