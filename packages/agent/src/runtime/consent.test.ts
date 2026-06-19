import { describe, expect, it, vi, beforeEach } from "vitest";

// ── @oxagen/database mock ────────────────────────────────────────────────────
// Chainable fake db: select→from→where(→orderBy) resolves to `selectRows`;
// insert→values→onConflictDoUpdate→returning resolves to `returningRows`.
const state = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  returningRows: [{ id: "mcons_1" }] as unknown[],
  insertedValues: [] as unknown[],
  conflictArg: undefined as unknown,
}));

const returningMock = vi.fn(async () => state.returningRows);
const onConflictMock = vi.fn((arg: unknown) => {
  state.conflictArg = arg;
  return { returning: returningMock };
});
const valuesMock = vi.fn((v: unknown) => {
  state.insertedValues.push(v);
  return { onConflictDoUpdate: onConflictMock };
});
const insertMock = vi.fn(() => ({ values: valuesMock }));

const orderByMock = vi.fn(async () => state.selectRows);
// where() is awaited directly in checkConsent, but is chained with orderBy in
// listConsents. Return a thenable that ALSO exposes orderBy.
const whereMock = vi.fn(() => {
  const p = Promise.resolve(state.selectRows) as Promise<unknown[]> & {
    orderBy: typeof orderByMock;
  };
  p.orderBy = orderByMock;
  return p;
});
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

const fakeDb = { insert: insertMock, select: selectMock };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) => fn(fakeDb),
    schema: {
      mcpConsents: {
        orgId: "c.orgId",
        workspaceId: "c.workspaceId",
        userId: "c.userId",
        mcpServerId: "c.mcpServerId",
        toolName: "c.toolName",
        status: "c.status",
        grantedAt: "c.grantedAt",
        deniedAt: "c.deniedAt",
        expiresAt: "c.expiresAt",
        publicId: "c.publicId",
        createdAt: "c.createdAt",
        id: "c.id",
        updatedAt: "c.updatedAt",
      },
    },
  };
});

import {
  checkConsent,
  recordConsent,
  listConsents,
  ConsentRequiredError,
  CONSENT_WILDCARD,
  DEFAULT_CONSENT_TTL_MS,
} from "./consent";
import type { CapabilityContext } from "../types";

const CTX: CapabilityContext = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner",
  messageId: "msg_1",
};

describe("consent runtime — checkConsent", () => {
  beforeEach(() => {
    state.selectRows = [];
    state.returningRows = [{ id: "mcons_1" }];
    state.insertedValues.length = 0;
    state.conflictArg = undefined;
    selectMock.mockClear();
    valuesMock.mockClear();
    onConflictMock.mockClear();
    returningMock.mockClear();
    orderByMock.mockClear();
  });

  it("returns null when no grant row exists (must solicit consent)", async () => {
    state.selectRows = [];
    const res = await checkConsent(CTX, "u_1", "srv_1", "list_prs");
    expect(res).toBeNull();
  });

  it("returns the exact per-tool grant over a wildcard", async () => {
    state.selectRows = [
      { toolName: CONSENT_WILDCARD, status: "denied", expiresAt: null },
      { toolName: "list_prs", status: "granted", expiresAt: null },
    ];
    const res = await checkConsent(CTX, "u_1", "srv_1", "list_prs");
    expect(res).toEqual({ status: "granted", active: true });
  });

  it("honours a wildcard pre-grant when no exact row exists", async () => {
    state.selectRows = [{ toolName: CONSENT_WILDCARD, status: "granted", expiresAt: null }];
    const res = await checkConsent(CTX, "u_1", "srv_1", "any_tool");
    expect(res).toEqual({ status: "granted", active: true });
  });

  it("surfaces a denied grant so the caller short-circuits without re-prompting", async () => {
    state.selectRows = [{ toolName: "list_prs", status: "denied", expiresAt: null }];
    const res = await checkConsent(CTX, "u_1", "srv_1", "list_prs");
    expect(res).toEqual({ status: "denied", active: true });
  });
});

describe("consent runtime — recordConsent", () => {
  beforeEach(() => {
    state.insertedValues.length = 0;
    state.conflictArg = undefined;
    valuesMock.mockClear();
    onConflictMock.mockClear();
    returningMock.mockClear();
  });

  it("writes a granted row with grantedAt set and a default-TTL expiry", async () => {
    const before = Date.now();
    const res = await recordConsent({
      orgId: "ten_1",
      workspaceId: "ws_1",
      userId: "u_1",
      serverId: "srv_1",
      toolName: "list_prs",
      status: "granted",
    });
    expect(res.consentId).toBe("mcons_1");
    const v = state.insertedValues[0] as {
      status: string;
      grantedAt: Date | null;
      deniedAt: Date | null;
      expiresAt: Date | null;
    };
    expect(v.status).toBe("granted");
    expect(v.grantedAt).toBeInstanceOf(Date);
    expect(v.deniedAt).toBeNull();
    expect(v.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_CONSENT_TTL_MS - 1000);
  });

  it("writes a non-expiring wildcard pre-grant when ttlMs is null", async () => {
    await recordConsent({
      orgId: "ten_1",
      workspaceId: "ws_1",
      userId: "u_1",
      serverId: "srv_1",
      toolName: CONSENT_WILDCARD,
      status: "granted",
      ttlMs: null,
    });
    const v = state.insertedValues[0] as { expiresAt: Date | null; toolName: string };
    expect(v.expiresAt).toBeNull();
    expect(v.toolName).toBe("*");
  });

  it("records a denial with deniedAt set and grantedAt null", async () => {
    await recordConsent({
      orgId: "ten_1",
      workspaceId: "ws_1",
      userId: "u_1",
      serverId: "srv_1",
      toolName: "list_prs",
      status: "denied",
    });
    const v = state.insertedValues[0] as { grantedAt: Date | null; deniedAt: Date | null };
    expect(v.grantedAt).toBeNull();
    expect(v.deniedAt).toBeInstanceOf(Date);
  });
});

describe("consent runtime — listConsents", () => {
  beforeEach(() => {
    state.selectRows = [];
    orderByMock.mockClear();
  });

  it("maps rows to ISO date strings", async () => {
    const granted = new Date("2026-06-19T00:00:00.000Z");
    state.selectRows = [
      {
        publicId: "mcons_1",
        userId: "u_1",
        mcpServerId: "srv_1",
        toolName: "list_prs",
        status: "granted",
        grantedAt: granted,
        deniedAt: null,
        expiresAt: null,
      },
    ];
    const rows = await listConsents({ orgId: "ten_1", workspaceId: "ws_1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grantedAt).toBe("2026-06-19T00:00:00.000Z");
    expect(rows[0]!.expiresAt).toBeNull();
    expect(orderByMock).toHaveBeenCalledTimes(1);
  });
});

describe("ConsentRequiredError", () => {
  it("carries serverId, toolName, and prompt", () => {
    const err = new ConsentRequiredError("srv_1", "list_prs", "Allow GitHub to list PRs?");
    expect(err.name).toBe("ConsentRequiredError");
    expect(err.serverId).toBe("srv_1");
    expect(err.toolName).toBe("list_prs");
    expect(err.prompt).toBe("Allow GitHub to list PRs?");
  });
});
