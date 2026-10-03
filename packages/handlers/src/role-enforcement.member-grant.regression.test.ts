// role-enforcement.member-grant.regression.test.ts — #3458's last seven gaps.
//
// Each contract below grants the workspace Member role and declares
// `sensitivity: "high"`, and its handler checked no role, so a workspace
// Viewer could run it on every tier below Enterprise: the kernel's IAM check
// allows the call there (`tier_gate`) before any role is read. Each handler
// now calls `assertContractRole`. The suite keeps that gate real and replaces
// only the role assignments it reads (test-utils/org-role-gate.ts), so a
// handler that loses its gate reaches the business seam and fails here.
//
// role-enforcement.regression.test.ts covers the contracts that withhold the
// workspace Member role. This file is separate because it loads the run
// readers, which need the real billing and telemetry modules that file mocks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckedContext } from "@oxagen/oxagen";

const state = vi.hoisted(() => ({
  business: vi.fn(() => {
    throw new Error("authorized business operation");
  }),
}));

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);
vi.mock("@oxagen/iam/fetch-authz", () => ({ fetchAuthz: vi.fn() }));
vi.mock("@oxagen/iam/emit-audit", () => ({
  emitAudit: vi.fn(async () => undefined),
}));
vi.mock("@oxagen/iam/live-agent-run-authorization", () => ({
  evaluateAgentRunAuthorization: vi.fn(),
}));
// The first step past each gate. Reaching it means the gate admitted the call.
vi.mock("./schema.versioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./schema.versioning")>()),
  getOrCreateRegistry: state.business,
}));
vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: state.business,
}));
vi.mock("./lib/run-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/run-read")>()),
  resolveRun: state.business,
}));

import { checkIAM } from "@oxagen/iam/check-iam";
// Registers every contract, so the workspace rule can look up the capability
// the context names (#5228).
import "@oxagen/oxagen";
import { integrationInstall } from "@oxagen/oxagen/contracts/integration.install";
import { runFrameBodyGet } from "@oxagen/oxagen/contracts/run.frame_body.get";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import { schemaDelete } from "@oxagen/oxagen/contracts/schema.delete";
import { schemaLabelDelete } from "@oxagen/oxagen/contracts/schema.label.delete";
import { schemaPropertyDelete } from "@oxagen/oxagen/contracts/schema.property.delete";
import { schemaRelationshipDelete } from "@oxagen/oxagen/contracts/schema.relationship.delete";
import { integrationInstallHandler } from "./integration.install";
import { runFrameBodyGetHandler } from "./run.frame_body.get";
import { runTranscriptGetHandler } from "./run.transcript.get";
import { schemaDeleteHandler } from "./schema.delete";
import { schemaLabelDeleteHandler } from "./schema.label.delete";
import { schemaPropertyDeleteHandler } from "./schema.property.delete";
import { schemaRelationshipDeleteHandler } from "./schema.relationship.delete";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const ctx: CheckedContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: "member",
  apiKeyId: null,
  requestId: "role-member-grant",
  surface: "api",
  messageId: null,
  planTier: "free",
};

interface Entry {
  name: string;
  run: (ctx: CheckedContext) => Promise<unknown>;
  /** The handler refuses an API key before its role gate. */
  sessionOnly?: boolean;
}

const cases: Entry[] = [
  {
    name: "delete_schema",
    run: (c) =>
      schemaDeleteHandler(schemaDelete.input.parse({ schemaName: "crm" }), c),
  },
  {
    name: "delete_schema_label",
    run: (c) =>
      schemaLabelDeleteHandler(
        schemaLabelDelete.input.parse({ schemaName: "crm", name: "Account" }),
        c,
      ),
  },
  {
    name: "delete_schema_property",
    run: (c) =>
      schemaPropertyDeleteHandler(
        schemaPropertyDelete.input.parse({
          ownerKind: "node",
          ownerName: "Account",
          key: "email",
        }),
        c,
      ),
  },
  {
    name: "delete_schema_relationship",
    run: (c) =>
      schemaRelationshipDeleteHandler(
        schemaRelationshipDelete.input.parse({ schemaName: "crm", name: "OWNS" }),
        c,
      ),
  },
  {
    name: "install_integration",
    run: (c) =>
      integrationInstallHandler(
        integrationInstall.input.parse({
          pluginId: "github",
          config: {},
          displayName: "GitHub",
        }),
        c,
      ),
    sessionOnly: true,
  },
  {
    name: "get_run_frame_body",
    run: (c) =>
      runFrameBodyGetHandler(
        runFrameBodyGet.input.parse({ runId: "arun_role1", seq: "1" }),
        c,
      ),
  },
  {
    name: "get_run_transcript",
    run: (c) =>
      runTranscriptGetHandler(
        runTranscriptGet.input.parse({ runId: "arun_role1", zoom: "turns" }),
        c,
      ),
  },
];

/** The gate let the call through: it reached the business seam once. */
async function expectAdmitted(entry: Entry, c: CheckedContext) {
  await expect(entry.run(c)).rejects.toThrow();
  expect(state.business).toHaveBeenCalledOnce();
}

/** The gate refused the call before the business seam. */
async function expectRefused(entry: Entry, c: CheckedContext) {
  await expect(entry.run(c)).rejects.toMatchObject({
    code: "forbidden",
    reason: "org_role_required",
  });
  expect(state.business).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
});

describe.each(cases)(
  "$name enforces its contract's roles below Enterprise (#3458)",
  (entry) => {
    it("refuses a workspace Viewer after the real IAM tier gate allows the call", async () => {
      const decision = await checkIAM({
        capability: entry.name,
        ctx,
        defaultEffect: "deny",
        rawInputJson: "{}",
      });
      expect(decision.result.outcome).toBe("allow");
      expect(decision.result.trace.decidedBy.rule).toBe("tier_gate");
      roleGate.roles = { org: null, workspace: "Viewer" };
      await expectRefused(entry, ctx);
    });

    it("refuses a user with an org role the contract does not grant", async () => {
      roleGate.roles = { org: "Billing", workspace: null };
      await expectRefused(entry, ctx);
    });

    it.each(["Owner", "Admin"])("admits org %s", async (role) => {
      roleGate.roles = { org: role };
      await expectAdmitted(entry, ctx);
    });

    it("admits a workspace Member, as the contract grants", async () => {
      roleGate.roles = { org: null, workspace: "Member" };
      await expectAdmitted(entry, ctx);
    });

    // Mac decided on 2026-10-02 that a workspace's Owner and Admin do
    // everything in that workspace (#5228). Each capability here acts inside
    // the call's workspace, so the kernel's stamp of the capability name is
    // enough for the gate to admit them.
    it.each(["Owner", "Admin"])(
      "admits the workspace %s, as the workspace rule does",
      async (role) => {
        roleGate.roles = { org: null, workspace: role };
        await expectAdmitted(entry, { ...ctx, invokedCapability: entry.name });
      },
    );

    it("refuses a request with no credential", async () => {
      await expect(
        entry.run({ ...ctx, userId: null, apiKeyId: null }),
      ).rejects.toThrow(/authenticated|signed-in/i);
      expect(state.business).not.toHaveBeenCalled();
    });

    it("judges an API key by its creator's roles", async () => {
      const machine: CheckedContext = { ...ctx, userId: null, apiKeyId: "key" };
      if (entry.sessionOnly) {
        await expect(entry.run(machine)).rejects.toThrow(/authenticated/i);
        expect(state.business).not.toHaveBeenCalled();
        return;
      }
      roleGate.roles = { org: null, workspace: "Viewer", keyCreator: "creator" };
      await expectRefused(entry, machine);
      roleGate.roles = { org: "Owner", keyCreator: "creator" };
      await expectAdmitted(entry, machine);
    });
  },
);
