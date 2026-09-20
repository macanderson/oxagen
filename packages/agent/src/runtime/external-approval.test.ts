import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inputDigest } from "@oxagen/rules";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
const h = vi.hoisted(() => ({
  messages: [] as Row[],
  conversations: [] as Row[],
  approvals: [] as Row[],
  notify: vi.fn(),
  resolveRun: vi.fn(),
  execute: vi.fn(),
  beforeClaim: undefined as (() => void) | undefined,
}));

// Evaluate the helper's real WHERE clauses; an unscoped query must not get the
// same canned result as a correctly bound request.
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq:
    (key: string, value: unknown): Predicate =>
    (row) =>
      row[key] === value,
  gt:
    (key: string, value: Date): Predicate =>
    (row) =>
      (row[key] as Date) > value,
  isNull:
    (key: string): Predicate =>
    (row) =>
      row[key] == null,
  and:
    (...conditions: Predicate[]): Predicate =>
    (row) =>
      conditions.every((condition) => condition(row)),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));
vi.mock("@oxagen/database", () => {
  const columns = () => new Proxy({}, { get: (_, key) => String(key) });
  const tx = {
    query: {
      messages: {
        findFirst: async ({ where }: { where: Predicate }) =>
          h.messages.find(where),
      },
      conversations: {
        findFirst: async ({ where }: { where: Predicate }) =>
          h.conversations.find(where),
      },
      approvalRequests: {
        findFirst: async ({ where }: { where: Predicate }) => {
          const row = h.approvals.find(where);
          return row && { ...row };
        },
      },
    },
    execute: h.execute,
    update: () => ({
      set: (values: Row) => ({
        where: (where: Predicate) => ({
          returning: async () => {
            h.beforeClaim?.();
            const row = h.approvals.find(where);
            if (!row) return [];
            Object.assign(row, values);
            return [{ id: row.id }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Row) => ({
        returning: async () => {
          const id = `approval-${h.approvals.length + 1}`;
          h.approvals.push({
            id,
            resolution: null,
            tokenUsedAt: null,
            ...values,
          });
          return [{ approvalId: id }];
        },
      }),
    }),
  };
  return {
    schema: {
      messages: columns(),
      conversations: columns(),
      approvalRequests: columns(),
    },
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
});
vi.mock("@oxagen/rules/approval-notify", () => ({
  notifyApprovalRequested: h.notify,
}));
vi.mock("./approval", () => ({ resolveRunPublicId: h.resolveRun }));

import { externalApproval } from "./external-approval";

const args = {
  orgId: "org-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  messageId: "message-1",
  capabilityName: "mcp.server.charge_card",
  input: { amount: 5 },
  approvalDigest: "exact-input-rule-and-principal-digest",
  runId: "run-1",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  h.messages = [
    {
      id: args.messageId,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      conversationId: "conversation-1",
    },
    {
      id: "message-2",
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      conversationId: "conversation-1",
    },
  ];
  h.conversations = [
    {
      id: "conversation-1",
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      userId: args.userId,
    },
  ];
  h.approvals = [];
  h.beforeClaim = undefined;
  h.resolveRun.mockResolvedValue("arun_original");
});
afterEach(() => vi.useRealTimers());

async function approve() {
  const pending = await externalApproval(args);
  h.approvals[0]!.resolution = "approved";
  return pending;
}

describe("parked external approval proof", () => {
  it("records one pending request and recovers it on a later conversation turn", async () => {
    const pending = await externalApproval(args);
    expect(pending.status).toBe("pending");
    expect(await externalApproval({ ...args, messageId: "message-2" })).toEqual(
      pending,
    );
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      messageId: args.messageId,
      capabilityName: args.capabilityName,
      inputDigest: inputDigest(args.input),
      inputPreview: args.input,
      runPublicId: "arun_original",
    });
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        strings: expect.arrayContaining([
          "select pg_advisory_xact_lock(hashtextextended(",
        ]),
      }),
    );
  });

  it("releases an approved exact call to only one concurrent retry", async () => {
    const pending = await approve();
    const outcomes = await Promise.all([
      externalApproval({ ...args, messageId: "message-2" }),
      externalApproval({ ...args, messageId: "message-2" }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "approved",
      "refused",
    ]);
    expect(
      outcomes.every((outcome) => outcome.approvalId === pending.approvalId),
    ).toBe(true);
    expect(h.approvals[0]!.tokenUsedAt).toEqual(new Date());
    expect((await externalApproval(args)).status).toBe("refused");
    expect(h.notify).toHaveBeenCalledOnce();
  });

  it.each(["denied", "expired"])(
    "never releases a %s resolution",
    async (resolution) => {
      await externalApproval(args);
      h.approvals[0]!.resolution = resolution;
      expect((await externalApproval(args)).status).toBe("refused");
      expect(h.approvals[0]!.tokenUsedAt).toBeNull();
      expect(h.approvals).toHaveLength(1);
    },
  );

  it("requires a fresh decision after an approved proof expires", async () => {
    const old = await approve();
    vi.advanceTimersByTime(5 * 60_000);
    const fresh = await externalApproval(args);
    expect(fresh.status).toBe("pending");
    expect(fresh.approvalId).not.toBe(old.approvalId);
    expect(h.approvals[0]!.tokenUsedAt).toBeNull();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it.each(["orgId", "workspaceId", "userId"] as const)(
    "rejects a request from another %s before approval lookup",
    async (key) => {
      await approve();
      await expect(
        externalApproval({ ...args, [key]: "other" }),
      ).rejects.toMatchObject({
        reason: "requester_conversation_missing",
      });
      expect(h.approvals[0]!.tokenUsedAt).toBeNull();
      expect(h.approvals).toHaveLength(1);
    },
  );

  it.each(["orgId", "workspaceId", "userId"] as const)(
    "rejects a conversation whose %s does not match the requester",
    async (key) => {
      await approve();
      h.conversations[0]![key] = "other";
      await expect(externalApproval(args)).rejects.toMatchObject({
        reason: "requester_conversation_missing",
      });
      expect(h.approvals[0]!.tokenUsedAt).toBeNull();
    },
  );

  it("does not transfer approved proof to another conversation owned by the same user", async () => {
    const original = await approve();
    h.conversations.push({ ...h.conversations[0], id: "conversation-2" });
    h.messages.push({
      ...h.messages[0],
      id: "message-other",
      conversationId: "conversation-2",
    });
    const other = await externalApproval({
      ...args,
      messageId: "message-other",
    });
    expect(other.status).toBe("pending");
    expect(other.approvalId).not.toBe(original.approvalId);
    expect(h.approvals[0]!.tokenUsedAt).toBeNull();
  });

  it("does not transfer approved proof to a different exact-call digest", async () => {
    const original = await approve();
    const other = await externalApproval({
      ...args,
      approvalDigest: "changed-input-or-rules",
    });
    expect(other.status).toBe("pending");
    expect(other.approvalId).not.toBe(original.approvalId);
    expect(h.approvals[0]!.tokenUsedAt).toBeNull();
  });

  it.each(["orgId", "workspaceId", "capabilityName"] as const)(
    "ignores a stored approval with mismatched %s even when its resume key matches",
    async (key) => {
      const original = await approve();
      h.approvals[0]![key] = "other";
      const fresh = await externalApproval(args);
      expect(fresh.status).toBe("pending");
      expect(fresh.approvalId).not.toBe(original.approvalId);
      expect(h.approvals[0]!.tokenUsedAt).toBeNull();
    },
  );

  it.each(["resolution", "tokenUsedAt", "orgId"] as const)(
    "fails a claim when %s changes after the initial lookup",
    async (key) => {
      await approve();
      h.beforeClaim = () => {
        h.approvals[0]![key] = key === "tokenUsedAt" ? new Date() : "changed";
      };
      expect((await externalApproval(args)).status).toBe("refused");
    },
  );
});
