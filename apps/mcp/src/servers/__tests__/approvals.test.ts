// approvals.test.ts: the key that finds a parked served call's approval, and
// how the approvals under it settle, open, and are used (lane M15, #4666).
// Postgres is not reached here. A fake transaction answers with the rows a
// test sets, drizzle's operators build plain objects the test can read, and
// the digest is plain JSON so the test can read what the key covers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_TTL_MS, postgresApprovals, servedResumeKey } from "../approvals";
import type { ApprovalRequest } from "../types";
import { AGENT, NOW, run } from "./fixtures";

interface Row {
  publicId: string;
  resolution: string | null;
  resolvedByUserId: string | null;
}

const db = vi.hoisted(() => {
  const state = {
    rows: [] as Row[],
    locks: [] as unknown[],
    reads: [] as unknown[],
    inserted: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
    notified: [] as unknown[],
  };
  const tx = {
    execute: (query: unknown) => {
      state.locks.push(query);
      return Promise.resolve();
    },
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          state.reads.push(where);
          return { orderBy: () => Promise.resolve(state.rows) };
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.inserted.push(values);
        return { returning: () => Promise.resolve([{ publicId: "apr_9" }]) };
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          state.updates.push({ set, where });
          const used = state.rows.filter((row) => row.resolution === "approved");
          return { returning: () => Promise.resolve(used.map((row) => ({ publicId: row.publicId }))) };
        },
      }),
    }),
  };
  return { state, tx };
});

vi.mock("@oxagen/database", () => ({
  // Each column reads as its own name, so a predicate names the columns it tests.
  schema: { approvalRequests: new Proxy({}, { get: (_target, key) => String(key) }) },
  withTenantDb: <T>(fn: (tx: unknown) => Promise<T>) => fn(db.tx),
  // The same fake, so a role gate that reads through withOrgDb (ADR-086)
  // never reaches the real one (check:db-mock-seams).
  withOrgDb: <T>(fn: (tx: unknown) => Promise<T>) => fn(db.tx),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: <T>(_scope: unknown, fn: () => Promise<T>) => fn(),
}));
vi.mock("@oxagen/rules/approval-notify", () => ({
  notifyApprovalRequested: (_tx: unknown, notice: unknown) => {
    db.state.notified.push(notice);
    return Promise.resolve();
  },
}));
vi.mock("@oxagen/rules", () => ({ inputDigest: (input: unknown) => JSON.stringify(input) }));
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  gt: (column: unknown, value: unknown) => ({ gt: [column, value] }),
  isNull: (column: unknown) => ({ isNull: column }),
  asc: (column: unknown) => ({ asc: column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?"), values }),
}));

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    run: run(),
    agent: AGENT,
    tool: "billing__create_refund",
    version: 1,
    publication: { repository: "finops-steering", version: 4 },
    server: "billing",
    args: { charge: "ch_1", amount: 100 },
    reasons: ["irreversible.approval"],
    risk: "high",
    ...overrides,
  };
}

describe("servedResumeKey", () => {
  it("covers the run, the machine, the agent, the tool at its version, the publication, and the arguments", () => {
    const key = servedResumeKey(request());
    expect(key.startsWith("served:")).toBe(true);
    expect(JSON.parse(key.slice("served:".length))).toEqual({
      workspaceId: "ws_1",
      machine: "hst_1",
      run: "tse_1",
      agent: AGENT.name,
      tool: "billing__create_refund",
      version: 1,
      publication: { repository: "finops-steering", version: 4 },
      args: { charge: "ch_1", amount: 100 },
    });
  });

  it("finds the same approval for the same call from the same run", () => {
    expect(servedResumeKey(request())).toBe(servedResumeKey(request()));
  });

  it("keeps one run from claiming another run's approval", () => {
    expect(servedResumeKey(request({ run: run({ runPublicId: "tse_2" }) }))).not.toBe(servedResumeKey(request()));
    expect(servedResumeKey(request({ run: run({ machine: "hst_2" }) }))).not.toBe(servedResumeKey(request()));
  });

  it("opens a new approval once a publish changes the tool", () => {
    expect(servedResumeKey(request({ version: 2 }))).not.toBe(servedResumeKey(request()));
  });

  it("opens a new approval after any new publication, even when the tool is unchanged", () => {
    const republished = request({ publication: { repository: "finops-steering", version: 5 } });
    expect(servedResumeKey(republished)).not.toBe(servedResumeKey(request()));
  });
});

function approved(publicId: string, person: string | null): Row {
  return { publicId, resolution: "approved", resolvedByUserId: person };
}

const pending = (publicId: string): Row => ({ publicId, resolution: null, resolvedByUserId: null });

beforeEach(() => {
  db.state.rows = [];
  db.state.locks.length = 0;
  db.state.reads.length = 0;
  db.state.inserted.length = 0;
  db.state.updates.length = 0;
  db.state.notified.length = 0;
});

const approvals = postgresApprovals(() => NOW);

describe("postgresApprovals.settle", () => {
  it("opens a pending approval and tells its approvers when no approval answers for the call", async () => {
    await expect(approvals.settle(request())).resolves.toEqual({ state: "pending", id: "apr_9" });
    expect(db.state.inserted).toEqual([
      expect.objectContaining({
        capabilityName: "billing__create_refund",
        kind: "approval",
        riskLevel: "high",
        ruleIds: ["irreversible.approval"],
        resumeKey: servedResumeKey(request()),
        runPublicId: "tse_1",
        expiresAt: new Date(NOW + APPROVAL_TTL_MS),
      }),
    ]);
    expect(db.state.notified).toHaveLength(1);
  });

  it("holds the lock on the call's key and reads only unused, unexpired approvals under it", async () => {
    await approvals.settle(request());
    expect(db.state.locks).toEqual([expect.objectContaining({ values: [servedResumeKey(request())] })]);
    expect(db.state.reads).toEqual([
      {
        and: [
          { eq: ["orgId", "org_1"] },
          { eq: ["workspaceId", "ws_1"] },
          { eq: ["capabilityName", "billing__create_refund"] },
          { eq: ["resumeKey", servedResumeKey(request())] },
          { gt: ["expiresAt", new Date(NOW)] },
          { isNull: "tokenUsedAt" },
        ],
      },
    ]);
  });

  it("counts the distinct people who approved the call", async () => {
    db.state.rows = [approved("apr_1", "usr_a"), approved("apr_2", "usr_a"), approved("apr_3", "usr_b")];
    await expect(approvals.settle(request())).resolves.toEqual({ state: "approved", id: "apr_1", approvers: 2 });
  });

  it("counts no person for an approval an automatic rule resolved", async () => {
    db.state.rows = [approved("apr_1", null)];
    await expect(approvals.settle(request())).resolves.toEqual({ state: "approved", id: "apr_1", approvers: 0 });
  });

  it("uses no approval when it settles", async () => {
    db.state.rows = [approved("apr_1", "usr_a")];
    await approvals.settle(request());
    expect(db.state.updates).toEqual([]);
    expect(db.state.inserted).toEqual([]);
  });

  it("reports a pending approval over the approved ones", async () => {
    db.state.rows = [approved("apr_1", "usr_a"), pending("apr_2")];
    await expect(approvals.settle(request())).resolves.toEqual({ state: "pending", id: "apr_2" });
    expect(db.state.inserted).toEqual([]);
  });

  it("reports a refusal over every other approval", async () => {
    db.state.rows = [approved("apr_1", "usr_a"), pending("apr_2"), { publicId: "apr_3", resolution: "denied", resolvedByUserId: "usr_b" }];
    await expect(approvals.settle(request())).resolves.toEqual({ state: "refused", id: "apr_3" });
  });
});

describe("postgresApprovals.requestAnother", () => {
  it("opens one more approval beside the approved ones", async () => {
    db.state.rows = [approved("apr_1", "usr_a")];
    await expect(approvals.requestAnother(request({ reasons: ["payments.two-approvers"] }))).resolves.toEqual({ id: "apr_9" });
    expect(db.state.inserted).toEqual([expect.objectContaining({ ruleIds: ["payments.two-approvers"] })]);
    expect(db.state.notified).toHaveLength(1);
  });

  it("answers with the approval already pending instead of opening a second", async () => {
    db.state.rows = [approved("apr_1", "usr_a"), pending("apr_2")];
    await expect(approvals.requestAnother(request())).resolves.toEqual({ id: "apr_2" });
    expect(db.state.inserted).toEqual([]);
  });

  it("holds the lock on the call's key", async () => {
    db.state.rows = [approved("apr_1", "usr_a")];
    await approvals.requestAnother(request());
    expect(db.state.locks).toEqual([expect.objectContaining({ values: [servedResumeKey(request())] })]);
  });
});

describe("postgresApprovals.claim", () => {
  it("marks every approval under the call's key used when enough people approved", async () => {
    db.state.rows = [approved("apr_1", "usr_a"), approved("apr_2", "usr_b")];
    await expect(approvals.claim(request(), 2)).resolves.toBe(true);
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0]?.set).toEqual({ tokenUsedAt: new Date(NOW) });
    // The predicate names the key and the resolution, never one row's id.
    expect(db.state.updates[0]?.where).toEqual({
      and: [db.state.reads[0], { eq: ["resolution", "approved"] }],
    });
  });

  it("holds the lock on the call's key", async () => {
    db.state.rows = [approved("apr_1", "usr_a")];
    await approvals.claim(request(), 1);
    expect(db.state.locks).toEqual([expect.objectContaining({ values: [servedResumeKey(request())] })]);
  });

  it("marks the approvals it counted at the instant it counted them, even as the clock moves", async () => {
    // Each read of this clock is one second later than the last.
    let tick = 0;
    const ticking = postgresApprovals(() => NOW + tick++ * 1000);
    db.state.rows = [approved("apr_1", "usr_a"), approved("apr_2", "usr_b")];
    await expect(ticking.claim(request(), 2)).resolves.toBe(true);
    expect(db.state.updates[0]?.set).toEqual({ tokenUsedAt: new Date(NOW) });
    expect(db.state.updates[0]?.where).toEqual({
      and: [db.state.reads[0], { eq: ["resolution", "approved"] }],
    });
  });

  it("uses nothing when fewer people answer for the call than it needs", async () => {
    db.state.rows = [approved("apr_1", "usr_a"), approved("apr_2", "usr_a")];
    await expect(approvals.claim(request(), 2)).resolves.toBe(false);
    expect(db.state.updates).toEqual([]);
  });

  it("uses nothing once another call used the approvals", async () => {
    await expect(approvals.claim(request(), 1)).resolves.toBe(false);
    expect(db.state.updates).toEqual([]);
  });

  it("uses nothing when an approval under the key waits or was refused", async () => {
    db.state.rows = [approved("apr_1", "usr_a"), pending("apr_2")];
    await expect(approvals.claim(request(), 1)).resolves.toBe(false);
    db.state.rows = [approved("apr_1", "usr_a"), { publicId: "apr_3", resolution: "expired", resolvedByUserId: null }];
    await expect(approvals.claim(request(), 1)).resolves.toBe(false);
    expect(db.state.updates).toEqual([]);
  });
});
