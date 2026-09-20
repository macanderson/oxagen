// list_resolved_approvals handler tests (#3153).
//
// The cursor codec and the row mapping are pure and run everywhere. The query
// is proven against a real Postgres: the resolved-only predicate, the
// workspace bound and RLS isolation are properties of the SQL, and a fake
// store would only prove the fake. CI's `test` job migrates Postgres and
// carries DATABASE_URL, so the block runs there; a local run without a
// database skips it. To run it locally:
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/agent exec vitest run src/handlers/agent.approval.list_resolved.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeResolvedCursor,
  encodeResolvedCursor,
  toResolvedApprovalListItem,
} from "./agent.approval.list_resolved";

describe("list_resolved_approvals cursor", () => {
  const row = {
    resolvedAt: new Date("2026-09-18T10:05:00.123Z"),
    publicId: "apr_0123456789abcdefghjkmn",
  };

  it("round-trips the last row's resolved-at and public id", () => {
    expect(decodeResolvedCursor(encodeResolvedCursor(row))).toEqual({
      resolvedAt: row.resolvedAt,
      id: row.publicId,
    });
  });

  it("starts over on a cursor it did not mint", () => {
    expect(decodeResolvedCursor(undefined)).toBeUndefined();
    expect(decodeResolvedCursor("")).toBeUndefined();
    expect(decodeResolvedCursor("not-a-cursor")).toBeUndefined();
  });
});

describe("list_resolved_approvals item", () => {
  it("carries the auto-approval rule and the policy approver, the receipt a rule's release leaves (#3153)", () => {
    expect(
      toResolvedApprovalListItem({
        publicId: "apr_0123456789abcdefghjkmn",
        capabilityName: "stripe__create_payment",
        createdAt: new Date("2026-09-18T10:00:00.000Z"),
        expiresAt: new Date("2026-09-18T10:05:00.000Z"),
        resolvedAt: new Date("2026-09-18T10:00:01.000Z"),
        resolution: "approved",
        requesterPublicId: null,
        resolvedByUserPublicId: null,
        resolvedByPolicy: "policy:small-vendor-payments",
        mandatePublicId: null,
        runPublicId: null,
        ruleIds: [],
        autoRuleId: "small-vendor-payments",
        resolvedReasons: [],
      }),
    ).toEqual({
      id: "apr_0123456789abcdefghjkmn",
      runId: null,
      tool: "stripe__create_payment",
      requester: null,
      createdAt: "2026-09-18T10:00:00.000Z",
      expiresAt: "2026-09-18T10:05:00.000Z",
      resolvedAt: "2026-09-18T10:00:01.000Z",
      resolution: "approved",
      resolvedBy: "policy:small-vendor-payments",
      autoRuleId: "small-vendor-payments",
      autoEligibility: {
        ruleId: "small-vendor-payments",
        ok: true,
        reasons: [],
        floor: false,
      },
      mandateId: null,
      chain: { agentKey: null, rule: null },
    });
  });

  it("carries the person's id when a person resolved the row, never both", () => {
    const item = toResolvedApprovalListItem({
      publicId: "apr_0123456789abcdefghjkmn",
      capabilityName: "delete_workspace",
      createdAt: new Date("2026-09-18T10:00:00.000Z"),
      expiresAt: new Date("2026-09-18T10:05:00.000Z"),
      resolvedAt: new Date("2026-09-18T10:00:30.000Z"),
      resolution: "denied",
      requesterPublicId: "usr_0123456789abcdefghjkmn",
      resolvedByUserPublicId: "usr_9876543210zyxwvutsrqp",
      resolvedByPolicy: null,
      mandatePublicId: null,
      runPublicId: null,
      ruleIds: [],
      autoRuleId: null,
      resolvedReasons: [],
    });
    expect(item.resolvedBy).toBe("user:usr_9876543210zyxwvutsrqp");
    expect(item.autoRuleId).toBeNull();
    expect(item.autoEligibility).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "list_resolved_approvals against Postgres",
  async () => {
    const { schema, withSystemDb } = await import("@oxagen/database");
    const { policyApprover } = await import(
      "@oxagen/oxagen/approval-rules/schemas"
    );
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq, inArray } = await import("drizzle-orm");
    const { agentApprovalListResolvedHandler } = await import(
      "./agent.approval.list_resolved"
    );
    const { agentApprovalListResolved } = await import(
      "@oxagen/oxagen/contracts/agent.approval.list_resolved"
    );

    const tag = Date.now().toString(36).slice(-6);
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const wsA1 = crypto.randomUUID();
    const wsB1 = crypto.randomUUID();
    const NOW = Date.now();
    const inMinutes = (n: number) => new Date(NOW + n * 60_000);
    const ids: Record<string, string> = {};

    const ctx = (orgId: string, workspaceId: string) => ({
      orgId,
      workspaceId,
      userId: null,
      apiKeyId: null,
      requestId: `req_${tag}`,
      surface: "api" as const,
      messageId: null,
    });

    const list = (
      orgId: string,
      workspaceId: string,
      input: Parameters<typeof agentApprovalListResolved.input.parse>[0] = {},
    ) =>
      runInTenantScope({ orgId, workspaceId }, () =>
        agentApprovalListResolvedHandler(
          agentApprovalListResolved.input.parse(input),
          ctx(orgId, workspaceId),
        ),
      );

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        const rows = await tx
          .insert(schema.approvalRequests)
          .values([
            // Auto-approved: no person looked. This is the row #3153 exists
            // for: `autoApprovePath`'s own write shape.
            {
              orgId: orgA,
              workspaceId: wsA1,
              capabilityName: "stripe__create_payment",
              inputPreview: {},
              riskLevel: "low",
              ruleIds: ["mandate:mnd_x:always_human_for:moves_money"],
              inputDigest: "sha256:deadbeef",
              autoRuleId: "small-vendor-payments",
              resolvedReasons: [],
              resolution: "approved",
              resolvedAt: inMinutes(-5),
              resolvedByPolicy: policyApprover("small-vendor-payments"),
              tokenUsedAt: inMinutes(-5),
              expiresAt: inMinutes(5),
            },
            // The expiry job persists this shape for a non-mandate timeout.
            {
              orgId: orgA,
              workspaceId: wsA1,
              capabilityName: "ordinary_timeout",
              inputPreview: {},
              riskLevel: "high",
              resolution: "expired",
              resolvedAt: inMinutes(-1),
              expiresAt: inMinutes(-1),
            },
            {
              orgId: orgA,
              workspaceId: wsA1,
              capabilityName: "resumed_failure",
              inputPreview: {},
              riskLevel: "high",
              resolution: "approved",
              resolvedAt: inMinutes(-2),
              expiresAt: inMinutes(5),
              resumeStatus: "failed",
              resumeRunPublicId: "run_resume_fixture",
              resumeError: "execution_refused",
            },
            // Still pending: the resolved listing must not show it.
            {
              orgId: orgA,
              workspaceId: wsA1,
              capabilityName: "create_workspace",
              inputPreview: {},
              riskLevel: "high",
              expiresAt: inMinutes(5),
            },
            // Resolved in another org: RLS must hide it.
            {
              orgId: orgB,
              workspaceId: wsB1,
              capabilityName: "other_org",
              inputPreview: {},
              riskLevel: "low",
              resolution: "approved",
              resolvedAt: inMinutes(-1),
              resolvedByPolicy: policyApprover("some-rule"),
              expiresAt: inMinutes(5),
            },
          ])
          .returning({
            publicId: schema.approvalRequests.publicId,
            capabilityName: schema.approvalRequests.capabilityName,
          });
        for (const row of rows) ids[row.capabilityName] = row.publicId;
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.approvalRequests)
          .where(inArray(schema.approvalRequests.orgId, [orgA, orgB]));
      });
    });

    it("returns the auto-approved row, with the rule and the id it discarded on write", async () => {
      const out = agentApprovalListResolved.output.parse(
        await list(orgA, wsA1),
      );
      const item = out.items.find((i) => i.tool === "stripe__create_payment");
      expect(item).toBeDefined();
      expect(item!.id).toBe(ids["stripe__create_payment"]);
      expect(item!.resolution).toBe("approved");
      expect(item!.resolvedBy).toBe("policy:small-vendor-payments");
      expect(item!.autoRuleId).toBe("small-vendor-payments");
    });

    it("returns an ordinary timeout with its stable expiry time and no invented approver", async () => {
      const out = await list(orgA, wsA1);
      expect(
        out.items.find((item) => item.tool === "ordinary_timeout"),
      ).toMatchObject({
        resolution: "expired",
        resolvedAt: inMinutes(-1).toISOString(),
        expiresAt: inMinutes(-1).toISOString(),
        resolvedBy: null,
        mandateId: null,
      });
    });

    it("reads execution status, run and failure reason from the stored projection", async () => {
      const out = agentApprovalListResolved.output.parse(
        await list(orgA, wsA1),
      );
      expect(
        out.items.find((item) => item.tool === "resumed_failure")?.execution,
      ).toEqual({
        status: "failed",
        runId: "run_resume_fixture",
        reason: "execution_refused",
      });
      expect(
        out.items.find((item) => item.tool === "ordinary_timeout"),
      ).not.toHaveProperty("execution");
    });

    it("does not return the still-pending row (negative)", async () => {
      const out = await list(orgA, wsA1);
      expect(out.items.map((i) => i.tool)).not.toContain("create_workspace");
    });

    it("hides another org's resolved row under RLS (negative)", async () => {
      const own = await list(orgA, wsA1);
      expect(own.items.map((i) => i.tool)).not.toContain("other_org");
      const foreign = await list(orgB, wsB1);
      expect(foreign.items.map((i) => i.tool)).toEqual(["other_org"]);
    });

    it("hands back an id get_auto_eligibility can resolve, with the rule attribution intact (#3153)", async () => {
      // get_auto_eligibility (packages/handlers/src/approval.auto_eligibility.get.ts)
      // takes exactly this id shape and reads exactly these columns; this
      // proves the id `autoApprovePath` used to throw away is now reachable
      // and still carries what it wrote.
      const out = await list(orgA, wsA1);
      const item = out.items.find((i) => i.tool === "stripe__create_payment")!;
      const row = await withSystemDb((tx) =>
        tx.query.approvalRequests.findFirst({
          where: eq(schema.approvalRequests.publicId, item.id),
          columns: {
            autoRuleId: true,
            resolvedReasons: true,
            resolvedByPolicy: true,
          },
        }),
      );
      expect(row?.autoRuleId).toBe("small-vendor-payments");
      expect(row?.resolvedByPolicy).toBe("policy:small-vendor-payments");
      expect(row?.resolvedReasons).toEqual([]);
    });
  },
);
