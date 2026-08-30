import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// For scope="org" the handler issues, in order:
//   1. membership lookup → select(role).from(orgUsers).where().limit(1)
//   2. insert export request → insert().values().returning()
// For scope="user" it skips step 1.
const mocks = vi.hoisted(() => ({
  selectResults: [] as Array<() => Promise<unknown>>,
  insertReturning: vi.fn<() => Promise<unknown>>(),
  eventSend: vi.fn<(arg: unknown) => Promise<unknown>>(),
  emitSecurityEvent: vi.fn<(arg: unknown) => void>(),
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
      values: () => ({ returning: () => mocks.insertReturning() }),
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
    mocks.insertReturning.mockResolvedValue([{ id: "exp_1" }]);
    mocks.eventSend.mockResolvedValue(undefined);
  });

  it("queues a user-scope export without a membership check", async () => {
    const result = await privacyDataExportHandler({ scope: "user" }, CTX);
    expect(result).toEqual({ exportId: "exp_1", status: "queued" });
    expect(mocks.eventSend).toHaveBeenCalledTimes(1);
  });

  it("rejects org-scope export when caller is not a member of the target org", async () => {
    // membership lookup returns no row for the foreign org
    queueSelects([]);
    await expect(
      privacyDataExportHandler({ scope: "org", orgId: "org_B" }, CTX),
    ).rejects.toThrow("Forbidden: org export requires Owner or Admin role");
    expect(mocks.insertReturning).not.toHaveBeenCalled();
    expect(mocks.eventSend).not.toHaveBeenCalled();
  });

  it("rejects org-scope export when caller is a non-privileged member", async () => {
    queueSelects([{ role: "member" }]);
    await expect(
      privacyDataExportHandler({ scope: "org", orgId: "org_B" }, CTX),
    ).rejects.toThrow("Forbidden: org export requires Owner or Admin role");
    expect(mocks.insertReturning).not.toHaveBeenCalled();
  });

  it("allows org-scope export for an Owner of the target org", async () => {
    queueSelects([{ role: "owner" }]);
    const result = await privacyDataExportHandler(
      { scope: "org", orgId: "org_B" },
      CTX,
    );
    expect(result).toEqual({ exportId: "exp_1", status: "queued" });
    expect(mocks.eventSend).toHaveBeenCalledTimes(1);
  });

  it("allows org-scope export for an Admin of the target org", async () => {
    queueSelects([{ role: "admin" }]);
    const result = await privacyDataExportHandler(
      { scope: "org", orgId: "org_B" },
      CTX,
    );
    expect(result).toEqual({ exportId: "exp_1", status: "queued" });
  });

  it("throws when org scope is requested without an orgId", async () => {
    await expect(
      privacyDataExportHandler({ scope: "org" } as never, CTX),
    ).rejects.toThrow("orgId is required for org-scope export");
  });
});
