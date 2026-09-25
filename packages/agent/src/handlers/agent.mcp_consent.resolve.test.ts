/**
 * Unit tests for the resolve_mcp_consent handler (ADR-175).
 *
 * Guards and their negatives:
 *   - role gate: the contract's defaultRoles through assertOrgRole; a Viewer
 *     and a call with no user and no key are refused before any UPDATE; an
 *     API-key call acts as the key's creator
 *   - kind: a row that is not a consent request is refused `conflict` /
 *     `not_a_consent_request`, and the UPDATE also pins `kind = 'consent'`
 *   - run: a call from the run the row records, by its internal or public
 *     id, is refused `forbidden` / `run_cannot_resolve_own_approval`; a call
 *     with no run, or from another run, resolves
 *   - the answer: a grant maps onto the approval vocabulary and records a
 *     per-tool or wildcard consent for the acting user; a denial never widens
 *     to a wildcard; no row answers `expired`
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { schema } from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  recordConsent: vi.fn(),
  notifyResolution: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
// raisedByCallingRun and resolveRunPublicId stay real, against the tx double.
vi.mock("../runtime/approval", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/approval")>()),
  notifyResolution: mocks.notifyResolution,
}));
vi.mock("../runtime/consent", async (importOriginal) => {
  const real = await importOriginal<typeof import("../runtime/consent")>();
  return { ...real, recordConsent: mocks.recordConsent };
});

import { agentMcpConsentResolveHandler } from "./agent.mcp_consent.resolve";
import { CONSENT_WILDCARD, DEFAULT_CONSENT_TTL_MS } from "../runtime/consent";
import { TEST_CTX, makeCTX } from "../test-utils/fixtures";

const SERVER_ID = "1f3b6c22-9d1e-4a55-9d3d-6d1f0c9a2b77";
const ROW_ID = "4b2f7a0e-6c1d-4e8a-9f3b-2d5c7e9a1b3c";
/** A run that raised the request: `agent_runs.id` and its public id. */
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const RUN_PUBLIC_ID = "arun_01k5rt9xq7v3m8n2p4s6t8w0";
const OTHER_RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000b2";

const render = (q: SQL) => new PgDialect().sqlToQuery(q);

type Row = {
  kind: string;
  runPublicId: string | null;
  capabilityName: string;
};

type Tenant = {
  /** The pending row the read finds; null for no match. */
  row: Row | null;
  orgRole: string | null;
  workspaceRole: string | null;
  /** The creator an API key resolves to, or none. */
  keyCreator: string | null;
  /** `agent_runs` in this workspace: internal id → public id. */
  runs: Record<string, string>;
};

type Captured = { set: Record<string, unknown> | null; where: SQL | null };

/** What the UPDATE's RETURNING hands back for the pending row. */
const resolvedRows = (row: Row | null) =>
  row ? [{ id: ROW_ID, capabilityName: row.capabilityName }] : [];

function makeTx(tenant: Tenant, captured: Captured) {
  const roleRows = (where: SQL | null) => {
    const pinsWorkspace = where
      ? /"workspace_id" = \$/.test(render(where).sql)
      : false;
    const name = pinsWorkspace ? tenant.workspaceRole : tenant.orgRole;
    return name ? [{ roleName: name }] : [];
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        let where: SQL | null = null;
        const chain = {
          innerJoin: () => chain,
          where: (cond: SQL) => {
            where = cond;
            return chain;
          },
          limit: async () => {
            if (table === schema.apiKeys) {
              const creator = tenant.keyCreator;
              return creator ? [{ createdById: creator }] : [];
            }
            if (table === schema.principals) return [{ id: "prn_1" }];
            if (table === schema.principalRoleAssignments) {
              return roleRows(where);
            }
            if (table === schema.approvalRequests) {
              return tenant.row ? [tenant.row] : [];
            }
            if (table === schema.agentRuns) {
              const ids = where ? render(where).params : [];
              const hit = Object.entries(tenant.runs).find(([id]) =>
                ids.includes(id),
              );
              return hit ? [{ publicId: hit[1] }] : [];
            }
            throw new Error("unexpected table");
          },
        };
        return chain;
      },
    }),
    update: (table: unknown) => {
      if (table !== schema.approvalRequests)
        throw new Error("unexpected table");
      return {
        set: (values: Record<string, unknown>) => {
          captured.set = values;
          return {
            where: (cond: SQL) => {
              captured.where = cond;
              return { returning: async () => resolvedRows(tenant.row) };
            },
          };
        },
      };
    },
  };
}

const consentRow = (overrides: Partial<Row> = {}): Row => ({
  kind: "consent",
  runPublicId: null,
  capabilityName: `mcp.${SERVER_ID}.search.web`,
  ...overrides,
});

function setup(overrides: Partial<Tenant> = {}): Captured {
  const tenant: Tenant = {
    row: consentRow(),
    orgRole: "Owner",
    workspaceRole: null,
    keyCreator: null,
    runs: { [RUN_UUID]: RUN_PUBLIC_ID },
    ...overrides,
  };
  const captured: Captured = { set: null, where: null };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeTx(tenant, captured))),
  );
  return captured;
}

const refused = (code: string, reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === code && e.reason === reason;

const untouched = (captured: Captured) => {
  expect(captured.set).toBeNull();
  expect(mocks.recordConsent).not.toHaveBeenCalled();
  expect(mocks.notifyResolution).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolve_mcp_consent: the answer", () => {
  it("reports `expired` when no pending row matched", async () => {
    const captured = setup({ row: null });

    const out = await agentMcpConsentResolveHandler(
      { approvalId: ROW_ID, decision: "granted" },
      TEST_CTX,
    );

    expect(out).toEqual({ approvalId: ROW_ID, resolution: "expired" });
    untouched(captured);
  });

  it("maps a grant onto the approval vocabulary and records a per-tool consent", async () => {
    const captured = setup();

    const out = await agentMcpConsentResolveHandler(
      { approvalId: ROW_ID, decision: "granted" },
      TEST_CTX,
    );

    expect(captured.set).toMatchObject({
      resolution: "approved",
      resolvedByUserId: "u_1",
      note: null,
    });
    expect(mocks.recordConsent).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: "u_1",
      serverId: SERVER_ID,
      // The tool name keeps its dots. Only the first one after `mcp.` splits.
      toolName: "search.web",
      status: "granted",
      ttlMs: DEFAULT_CONSENT_TTL_MS,
    });
    expect(mocks.notifyResolution).toHaveBeenCalledWith({
      approvalId: ROW_ID,
      resolution: "approved",
      note: null,
    });
    expect(out).toEqual({ approvalId: ROW_ID, resolution: "granted" });
  });

  it("stores a never-expiring wildcard grant when grantAllTools is set", async () => {
    setup({ row: consentRow({ capabilityName: `mcp.${SERVER_ID}.search` }) });

    await agentMcpConsentResolveHandler(
      { approvalId: ROW_ID, decision: "granted", grantAllTools: true },
      TEST_CTX,
    );

    expect(mocks.recordConsent).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: CONSENT_WILDCARD, ttlMs: null }),
    );
  });

  it("never widens a denial to a wildcard: grantAllTools is ignored", async () => {
    const captured = setup({
      row: consentRow({ capabilityName: `mcp.${SERVER_ID}.search` }),
    });

    const out = await agentMcpConsentResolveHandler(
      { approvalId: ROW_ID, decision: "denied", grantAllTools: true },
      TEST_CTX,
    );

    expect(captured.set).toMatchObject({ resolution: "denied" });
    expect(mocks.recordConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "search",
        status: "denied",
        ttlMs: DEFAULT_CONSENT_TTL_MS,
      }),
    );
    expect(out).toEqual({ approvalId: ROW_ID, resolution: "denied" });
  });

  it("skips the durable consent for a malformed synthetic name, and still unblocks the stream", async () => {
    setup({ row: consentRow({ capabilityName: "mcp..tool" }) });

    await agentMcpConsentResolveHandler(
      { approvalId: ROW_ID, decision: "granted" },
      TEST_CTX,
    );

    expect(mocks.recordConsent).not.toHaveBeenCalled();
    expect(mocks.notifyResolution).toHaveBeenCalledTimes(1);
  });

  it("pins the UPDATE to a pending consent row in the caller's org and workspace", async () => {
    const captured = setup();

    await agentMcpConsentResolveHandler(
      { approvalId: ROW_ID, decision: "granted" },
      TEST_CTX,
    );

    const q = render(captured.where!);
    expect(q.sql).toMatch(/"approval_requests"\."id" = \$\d/);
    expect(q.sql).toMatch(/"org_id" = \$\d/);
    expect(q.sql).toMatch(/"workspace_id" = \$\d/);
    expect(q.sql).toMatch(/"expires_at" > now\(\)/);
    expect(q.sql).toMatch(/"resolution" IS NULL/i);
    expect(q.sql).toMatch(/"approval_requests"\."kind" = \$\d/);
    expect(q.params).toContain("consent");
  });
});

describe("resolve_mcp_consent: who answers", () => {
  it("refuses a Viewer before any UPDATE", async () => {
    const captured = setup({ orgRole: "Viewer", workspaceRole: "Viewer" });

    await expect(
      agentMcpConsentResolveHandler(
        { approvalId: ROW_ID, decision: "granted" },
        TEST_CTX,
      ),
    ).rejects.toSatisfy(refused("forbidden", "org_role_required"));
    untouched(captured);
  });

  it("refuses a call with no user and no API key before any query", async () => {
    const captured = setup();

    await expect(
      agentMcpConsentResolveHandler(
        { approvalId: ROW_ID, decision: "granted" },
        makeCTX({ userId: null, apiKeyId: null }),
      ),
    ).rejects.toSatisfy(refused("forbidden", "no_principal"));
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    untouched(captured);
  });

  it("lets a workspace Member answer when the org role is Viewer", async () => {
    setup({ orgRole: "Viewer", workspaceRole: "Member" });

    await expect(
      agentMcpConsentResolveHandler(
        { approvalId: ROW_ID, decision: "denied" },
        TEST_CTX,
      ),
    ).resolves.toEqual({ approvalId: ROW_ID, resolution: "denied" });
  });

  it("acts as the API key's creator, recorded as the resolver and the consent's subject", async () => {
    const captured = setup({ keyCreator: "u_creator" });

    await agentMcpConsentResolveHandler(
      { approvalId: ROW_ID, decision: "granted" },
      makeCTX({ userId: null, apiKeyId: "aky_1" }),
    );

    expect(captured.set?.resolvedByUserId).toBe("u_creator");
    expect(mocks.recordConsent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_creator" }),
    );
  });
});

describe("resolve_mcp_consent: what it answers", () => {
  it("refuses an approval that is not a consent request: a parked write stays pending", async () => {
    const captured = setup({
      row: consentRow({ kind: "approval", capabilityName: "revoke_api_key" }),
    });

    const err = await agentMcpConsentResolveHandler(
      { approvalId: ROW_ID, decision: "granted" },
      TEST_CTX,
    ).catch((e: unknown) => e);

    expect(err).toSatisfy(refused("conflict", "not_a_consent_request"));
    expect((err as Error).message).toBe(
      "This approval is not a consent request. Approve or deny it on Fleet.",
    );
    untouched(captured);
  });

  it("refuses an external tool's rule-driven approval that carries an MCP tool name", async () => {
    const captured = setup({ row: consentRow({ kind: "approval" }) });

    await expect(
      agentMcpConsentResolveHandler(
        { approvalId: ROW_ID, decision: "granted" },
        TEST_CTX,
      ),
    ).rejects.toSatisfy(refused("conflict", "not_a_consent_request"));
    untouched(captured);
  });

  it.each([
    ["its internal id", RUN_UUID],
    ["its public id", RUN_PUBLIC_ID],
  ])(
    "refuses a call from the run that raised the request, by %s",
    async (_how, runId) => {
      const captured = setup({
        row: consentRow({ runPublicId: RUN_PUBLIC_ID }),
      });

      await expect(
        agentMcpConsentResolveHandler(
          { approvalId: ROW_ID, decision: "granted" },
          { ...TEST_CTX, runId },
        ),
      ).rejects.toSatisfy(
        refused("forbidden", "run_cannot_resolve_own_approval"),
      );
      untouched(captured);
    },
  );

  it.each([
    ["carries no run", undefined],
    ["comes from another run", OTHER_RUN_UUID],
  ])(
    "resolves a request its run raised when the call %s (negative)",
    async (_why, runId) => {
      setup({ row: consentRow({ runPublicId: RUN_PUBLIC_ID }) });

      await expect(
        agentMcpConsentResolveHandler(
          { approvalId: ROW_ID, decision: "granted" },
          { ...TEST_CTX, runId },
        ),
      ).resolves.toEqual({ approvalId: ROW_ID, resolution: "granted" });
    },
  );
});
