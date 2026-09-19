import { describe, expect, it, vi, beforeEach } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// For scope="org" the handler issues, in order:
//   1. membership lookup → select(role).from(orgUsers).where().limit(1)
//   2. insert export request → insert().values().returning()
// For scope="user" it skips step 1.
const mocks = vi.hoisted(() => ({
  selectResults: [] as Array<() => Promise<unknown>>,
  insertReturning: vi.fn<() => Promise<unknown>>(),
  insertValues: null as Record<string, unknown> | null,
  eventSend: vi.fn<(arg: unknown) => Promise<unknown>>(),
  emitSecurityEvent: vi.fn<(arg: unknown) => void>(),
}));

// ── @oxagen/tenancy mock ─────────────────────────────────────────────────────
// The policy re-check enters a tenant scope before reading IAM, because
// `fetchAuthz` reads org-wide and `runInTenantScope` validates both ids as
// UUIDs. This file's fixtures use opaque ids, so the scope entry is a
// passthrough here; `privacy.data.export.status.test.ts` runs the real one
// against UUID fixtures.
vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
  };
});

// ── @oxagen/iam mock ─────────────────────────────────────────────────────────
// The org branch now asks the IAM resolver whether an explicit rule has
// revoked the capability: the revocation path a membership read cannot see.
// The resolver itself runs for real; only its Postgres read is replaced. The
// default is an organisation with nothing configured, so nothing is revoked
// and these tests exercise the role rules as before.
const authz = vi.hoisted(() => ({
  value: {
    principal: null as unknown,
    grants: [] as unknown[],
    roles: [] as unknown[],
    roleGrants: [] as unknown[],
    policies: [] as unknown[],
  },
}));
vi.mock("@oxagen/iam", () => ({
  emitAudit: () => Promise.resolve(),
  fetchAuthz: () => Promise.resolve(authz.value),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const next = mocks.selectResults.shift();
            return next ? next() : Promise.resolve([]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        mocks.insertValues = vals;
        return { returning: () => mocks.insertReturning() };
      },
    }),
  });
  return {
    ...real,
    withSystemDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: (arg: unknown) => mocks.emitSecurityEvent(arg),
}));

vi.mock("./event-client", () => ({
  eventClient: { send: (arg: unknown) => mocks.eventSend(arg) },
}));

import { privacyDataExportHandler } from "./privacy.data.export";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";

const CTX: CapabilityContext = {
  orgId: "org_A",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

function queueSelects(...results: unknown[]): void {
  mocks.selectResults.length = 0;
  for (const r of results) mocks.selectResults.push(() => Promise.resolve(r));
}

describe("privacyDataExportHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.insertValues = null;
    mocks.insertReturning.mockResolvedValue([{ id: "exp_1" }]);
    authz.value = {
      principal: null,
      grants: [],
      roles: [],
      roleGrants: [],
      policies: [],
    };
    mocks.eventSend.mockResolvedValue(undefined);
  });

  it("queues a user-scope export without a membership check", async () => {
    const result = await privacyDataExportHandler({ scope: "user" }, CTX);
    expect(result).toEqual({ exportId: "exp_1", status: "queued" });
    expect(mocks.eventSend).toHaveBeenCalledTimes(1);
    // The workspace that governed the queue is on the row, so the status
    // recheck can bind to it when the archive is later read elsewhere.
    expect(mocks.insertValues).toMatchObject({
      workspaceId: "ws_1",
      orgId: "org_A",
      scope: "user",
    });
  });

  it("rejects org-scope export when the caller is not a member of the org", async () => {
    // membership lookup returns no row
    queueSelects([]);
    await expect(
      privacyDataExportHandler({ scope: "org", orgId: "org_A" }, CTX),
    ).rejects.toThrow(
      "An organization export requires the Owner or Admin role",
    );
    expect(mocks.insertReturning).not.toHaveBeenCalled();
    expect(mocks.eventSend).not.toHaveBeenCalled();
  });

  it("rejects org-scope export when caller is a non-privileged member", async () => {
    queueSelects([{ role: "member" }]);
    await expect(
      privacyDataExportHandler({ scope: "org", orgId: "org_A" }, CTX),
    ).rejects.toThrow(
      "An organization export requires the Owner or Admin role",
    );
    expect(mocks.insertReturning).not.toHaveBeenCalled();
  });

  // Reachable since the contract started admitting every org role: a normal API
  // key resolves with `userId: null`, so a machine principal now reaches the
  // handler instead of being stopped at IAM. Uncoded, that read as a runtime
  // error and a 500 rather than an authorization refusal.
  it("refuses a machine principal with a coded forbidden", async () => {
    const err = await privacyDataExportHandler({ scope: "user" }, {
      ...CTX,
      userId: null,
    } as typeof CTX).catch((e: unknown) => e);
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "export_requires_a_person",
    });
    expect(mocks.insertReturning).not.toHaveBeenCalled();
    expect(mocks.eventSend).not.toHaveBeenCalled();
  });

  it("refuses with a coded forbidden, so the surfaces read it as a denial", async () => {
    queueSelects([{ role: "member" }]);
    const err = await privacyDataExportHandler(
      { scope: "org", orgId: "org_A" },
      CTX,
    ).catch((e: unknown) => e);
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "org_export_requires_admin",
    });
  });

  it("allows org-scope export for an Owner of the org", async () => {
    queueSelects([{ role: "owner" }]);
    const result = await privacyDataExportHandler(
      { scope: "org", orgId: "org_A" },
      CTX,
    );
    expect(result).toEqual({ exportId: "exp_1", status: "queued" });
    expect(mocks.eventSend).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).toMatchObject({
      workspaceId: "ws_1",
      scope: "org",
    });
  });

  // The org-only sentinel is not a workspace a deny can be written in. Storing
  // it would make the download recheck treat a sentinel as an origin.
  it("stores null when the queue names the org-only sentinel", async () => {
    const result = await privacyDataExportHandler(
      { scope: "user" },
      { ...CTX, workspaceId: ORG_ONLY_WORKSPACE_ID },
    );
    expect(result).toEqual({ exportId: "exp_1", status: "queued" });
    expect(mocks.insertValues).toMatchObject({ workspaceId: null });
  });

  it("allows org-scope export for an Admin of the org", async () => {
    queueSelects([{ role: "admin" }]);
    const result = await privacyDataExportHandler(
      { scope: "org", orgId: "org_A" },
      CTX,
    );
    expect(result).toEqual({ exportId: "exp_1", status: "queued" });
  });

  // `invoke()` resolves IAM against ctx.orgId, so an export whose target is a
  // DIFFERENT org would have the decision made in one tenant and the data read
  // from another: the target's own grants, including an explicit deny, never
  // consulted. A membership read cannot substitute: it cannot see a deny grant
  // at all. So the two must name the same org.
  it("refuses an export whose target is not the org the kernel governed", async () => {
    const err = await privacyDataExportHandler(
      { scope: "org", orgId: "org_B" },
      CTX,
    ).catch((e: unknown) => e);
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "org_export_outside_governed_scope",
    });
    // Refused before the membership read, so an Owner of org_B cannot reach
    // the export by invoking through another membership.
    expect(mocks.insertReturning).not.toHaveBeenCalled();
    expect(mocks.eventSend).not.toHaveBeenCalled();
  });

  it("throws when org scope is requested without an orgId", async () => {
    await expect(
      privacyDataExportHandler({ scope: "org" } as never, CTX),
    ).rejects.toThrow("orgId is required for org-scope export");
  });

  // An administrator can revoke the mandate without touching a single role, by
  // writing an explicit `deny` against `export_data`. `org_users.role` cannot
  // see that row, and below the enterprise tier neither can the kernel: its
  // gate answers `tier_gate → allow` before any policy is read. So the queue
  // asks the resolver directly.
  it("refuses an Owner while an explicit export_data deny stands", async () => {
    queueSelects([{ role: "owner" }]);
    authz.value = {
      principal: {
        id: "p_1",
        kind: "human",
        orgId: "org_A",
        workspaceId: null,
      },
      grants: [],
      roles: [
        {
          id: "r_1",
          name: "Owner",
          scopeKind: "org",
          orgId: "org_A",
          principalIds: ["p_1"],
          isSystemDefault: true,
        },
      ],
      roleGrants: [
        { roleId: "r_1", capabilityId: "export_data", effect: "deny" },
      ],
      policies: [],
    };
    const err = await privacyDataExportHandler(
      { scope: "org", orgId: "org_A" },
      CTX,
    ).catch((e: unknown) => e);
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "org_export_not_permitted",
    });
    // Nothing queued, so no archive is ever assembled to be downloaded.
    expect(mocks.insertReturning).not.toHaveBeenCalled();
    expect(mocks.eventSend).not.toHaveBeenCalled();
  });
});
