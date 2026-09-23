// list_approvals handler tests.
//
// The cursor codec and the row mapping are pure and run everywhere. The query
// is proven against a real Postgres: the pending-only predicate, the workspace
// bound, the run filter and the page boundary are properties of the SQL, and a
// fake store would only prove the fake. CI's `test` job migrates Postgres and
// carries DATABASE_URL, so the block runs there; a local run without a
// database skips it (apps/app/ARCHITECTURE.md §6.1, Kernel row). To run it
// locally:
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/agent exec vitest run src/handlers/agent.approval.list.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  toApprovalListItem,
} from "./agent.approval.list";

describe("list_approvals cursor", () => {
  const row = {
    expiresAt: new Date("2026-09-13T10:05:00.123Z"),
    publicId: "apr_0123456789abcdefghjkmn",
  };

  it("round-trips the last row's expiry and public id", () => {
    expect(decodeCursor(encodeCursor(row))).toEqual({
      expiresAt: row.expiresAt,
      id: row.publicId,
    });
  });

  it("starts over on a cursor it did not mint", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
    expect(decodeCursor("not-a-cursor")).toBeUndefined();
    expect(
      decodeCursor(Buffer.from("yesterday|apr_x").toString("base64url")),
    ).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from("2026-09-13T10:05:00.123Z|").toString("base64url"),
      ),
    ).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from("2026-09-13T10:05:00.123Z|apr_x|extra").toString(
          "base64url",
        ),
      ),
    ).toBeUndefined();
  });
});

describe("list_approvals item", () => {
  it("carries the recorded columns and null for what the store does not record", () => {
    expect(
      toApprovalListItem({
        publicId: "apr_0123456789abcdefghjkmn",
        capabilityName: "create_workspace",
        createdAt: new Date("2026-09-13T10:00:00.000Z"),
        expiresAt: new Date("2026-09-13T10:05:00.000Z"),
        requesterPublicId: "usr_0123456789abcdefghjkmn",
        mandatePublicId: null,
        runPublicId: null,
        ruleIds: [],
        autoRuleId: null,
        resolvedReasons: [],
      }),
    ).toEqual({
      id: "apr_0123456789abcdefghjkmn",
      runId: null,
      tool: "create_workspace",
      requester: "usr_0123456789abcdefghjkmn",
      createdAt: "2026-09-13T10:00:00.000Z",
      expiresAt: "2026-09-13T10:05:00.000Z",
      mandateId: null,
      autoEligibility: null,
      chain: { agentKey: null, rule: null },
    });
  });

  it("carries the mandate hop and the first rule id on a row the mandate gate parked", () => {
    const item = toApprovalListItem({
      publicId: "apr_0123456789abcdefghjkmn",
      capabilityName: "stripe__create_payment",
      createdAt: new Date("2026-09-13T10:00:00.000Z"),
      expiresAt: new Date("2026-09-14T10:00:00.000Z"),
      requesterPublicId: null,
      mandatePublicId: "mnd_0123456789abcdefghjkmn",
      runPublicId: "arun_0123456789abcdefghjkmn",
      ruleIds: [
        "mandate:mnd_0123456789abcdefghjkmn:human_above:amount",
        "mandate:mnd_0123456789abcdefghjkmn:always_human_for:moves_money",
      ],
      autoRuleId: "small-vendor-payments",
      resolvedReasons: ["measure_above_ceiling:amount"],
    });
    expect(item.mandateId).toBe("mnd_0123456789abcdefghjkmn");
    expect(item.autoEligibility).toEqual({
      ruleId: "small-vendor-payments",
      ok: false,
      reasons: ["measure_above_ceiling:amount"],
      floor: false,
    });
    expect(item.chain.rule).toBe(
      "mandate:mnd_0123456789abcdefghjkmn:human_above:amount",
    );
    expect(item.requester).toBeNull();
    // The run the call was parked in (#3286): the Run page's Policy tab reads
    // this to list one run's own approvals.
    expect(item.runId).toBe("arun_0123456789abcdefghjkmn");
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "list_approvals against Postgres",
  async () => {
    const { schema, withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq, inArray } = await import("drizzle-orm");
    const { agentApprovalListHandler } = await import("./agent.approval.list");
    const { agentApprovalList } = await import(
      "@oxagen/oxagen/contracts/agent.approval.list"
    );

    const tag = Date.now().toString(36).slice(-6);
    const RUN_ID = "arun_0123456789abcdefghjkmn";
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const wsA1 = crypto.randomUUID();
    const wsA2 = crypto.randomUUID();
    const wsB1 = crypto.randomUUID();
    const requesterId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const orphanMessageId = crypto.randomUUID();
    const NOW = Date.now();
    const inMinutes = (n: number) => new Date(NOW + n * 60_000);
    let requesterPublicId = "";
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

    /** The two rows that share an expiry, in the id order the page boundary uses. */
    const sameExpiryById = () =>
      [ids["budget.turn.continue"]!, ids["mcp:github:create_release"]!].sort();

    const list = (
      orgId: string,
      workspaceId: string,
      input: Parameters<typeof agentApprovalList.input.parse>[0] = {},
    ) =>
      runInTenantScope({ orgId, workspaceId }, () =>
        agentApprovalListHandler(
          agentApprovalList.input.parse(input),
          ctx(orgId, workspaceId),
        ),
      );

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        const [user] = await tx
          .insert(schema.users)
          .values({
            id: requesterId,
            email: `approvals-${tag}@list.test`,
            status: "active",
          })
          .returning({ publicId: schema.users.publicId });
        requesterPublicId = user!.publicId;
        await tx.insert(schema.conversations).values({
          id: conversationId,
          orgId: orgA,
          workspaceId: wsA1,
          userId: requesterId,
          status: "active",
        });
        await tx.insert(schema.messages).values({
          id: messageId,
          orgId: orgA,
          workspaceId: wsA1,
          conversationId,
          role: "assistant",
          content: "",
          contentBlocks: [],
        });
        const sameExpiry = inMinutes(10);
        const rows = await tx
          .insert(schema.approvalRequests)
          .values([
            // Pending, soonest expiry; parked by the requester's conversation.
            {
              orgId: orgA,
              workspaceId: wsA1,
              messageId,
              capabilityName: "create_workspace",
              inputPreview: {},
              riskLevel: "high",
              expiresAt: inMinutes(5),
            },
            // Two pending rows sharing one expiry: the page boundary must
            // split them by id without a duplicate or a gap.
            {
              orgId: orgA,
              workspaceId: wsA1,
              messageId: orphanMessageId,
              capabilityName: "budget.turn.continue",
              inputPreview: {},
              riskLevel: "low",
              expiresAt: sameExpiry,
            },
            {
              orgId: orgA,
              workspaceId: wsA1,
              messageId: orphanMessageId,
              capabilityName: "mcp:github:create_release",
              inputPreview: {},
              riskLevel: "medium",
              expiresAt: sameExpiry,
            },
            // Resolved: not pending.
            {
              orgId: orgA,
              workspaceId: wsA1,
              messageId,
              capabilityName: "delete_workspace",
              inputPreview: {},
              riskLevel: "high",
              resolution: "approved",
              resolvedAt: new Date(NOW),
              expiresAt: inMinutes(5),
            },
            // Unresolved but past its expiry: not pending.
            {
              orgId: orgA,
              workspaceId: wsA1,
              messageId,
              capabilityName: "send_message",
              inputPreview: {},
              riskLevel: "low",
              expiresAt: inMinutes(-1),
            },
            // Pending, and recorded on a run: the Run page's Policy tab reads
            // one run's own parked calls (#3286).
            {
              orgId: orgA,
              workspaceId: wsA1,
              messageId,
              capabilityName: "run_scoped_call",
              inputPreview: {},
              riskLevel: "medium",
              runPublicId: RUN_ID,
              expiresAt: inMinutes(20),
            },
            // Pending in the org's other workspace.
            {
              orgId: orgA,
              workspaceId: wsA2,
              messageId,
              capabilityName: "other_workspace",
              inputPreview: {},
              riskLevel: "low",
              expiresAt: inMinutes(1),
            },
            // Pending in another org.
            {
              orgId: orgB,
              workspaceId: wsB1,
              messageId,
              capabilityName: "other_org",
              inputPreview: {},
              riskLevel: "low",
              expiresAt: inMinutes(1),
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
        await tx
          .delete(schema.messages)
          .where(eq(schema.messages.id, messageId));
        await tx
          .delete(schema.conversations)
          .where(eq(schema.conversations.id, conversationId));
        await tx.delete(schema.users).where(eq(schema.users.id, requesterId));
      });
    });

    it("lists the workspace's pending approvals only, soonest expiry first, and parses through the contract", async () => {
      const out = agentApprovalList.output.parse(await list(orgA, wsA1));
      expect(out.items.map((i) => i.id)).toEqual([
        ids["create_workspace"],
        ...sameExpiryById(),
        ids["run_scoped_call"],
      ]);
      expect(out.nextCursor).toBeNull();
      expect(out.total).toBe(4);
      for (const item of out.items) {
        expect(item.id).toMatch(/^apr_[0-9a-z]{22}$/);
        expect(item.chain).toEqual({ agentKey: null, rule: null });
        expect(Date.parse(item.expiresAt)).toBeGreaterThan(NOW);
      }
      // A row parked outside any run records none; a null is "not recorded".
      expect(out.items.filter((i) => i.runId === null)).toHaveLength(3);
    });

    it("names the requester through the message the call parked on, and null when that chain is not readable", async () => {
      const out = await list(orgA, wsA1);
      const byTool = new Map(out.items.map((i) => [i.tool, i]));
      expect(byTool.get("create_workspace")!.requester).toBe(requesterPublicId);
      expect(byTool.get("budget.turn.continue")!.requester).toBeNull();
    });

    it("excludes the org's other workspaces and other orgs", async () => {
      const own = await list(orgA, wsA1);
      expect(own.items.map((i) => i.tool)).not.toContain("other_workspace");
      expect(own.items.map((i) => i.tool)).not.toContain("other_org");
      const sibling = await list(orgA, wsA2);
      expect(sibling.items.map((i) => i.tool)).toEqual(["other_workspace"]);
      expect(sibling.total).toBe(1);
      const foreign = await list(orgB, wsB1);
      expect(foreign.items.map((i) => i.tool)).toEqual(["other_org"]);
    });

    it("pages by cursor with no duplicate and no gap across a shared expiry", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list(orgA, wsA1, { limit: 1, cursor });
        expect(page.items).toHaveLength(1);
        seen.push(page.items[0]!.id);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(4);
      expect(new Set(seen).size).toBe(4);
      expect(seen).toEqual([
        ids["create_workspace"],
        ...sameExpiryById(),
        ids["run_scoped_call"],
      ]);
      const two = await list(orgA, wsA1, { limit: 2 });
      expect(two.items.map((i) => i.id)).toEqual(seen.slice(0, 2));
      expect(two.nextCursor).not.toBeNull();
      // #3521: the count is the whole queue on every page, not the page's rows.
      expect(two.total).toBe(4);
      const rest = await list(orgA, wsA1, {
        limit: 2,
        cursor: two.nextCursor!,
      });
      expect(rest.items.map((i) => i.id)).toEqual(seen.slice(2));
      expect(rest.nextCursor).toBeNull();
      expect(rest.total).toBe(4);
    });

    it("narrows to one run's own parked calls, and answers each with the run it names", async () => {
      const out = await list(orgA, wsA1, { runId: RUN_ID });
      expect(out.items.map((i) => i.tool)).toEqual(["run_scoped_call"]);
      expect(out.items[0]!.runId).toBe(RUN_ID);
      expect(out.nextCursor).toBeNull();
      expect(out.total).toBe(1);
    });

    it("answers an empty page for a run with nothing parked (negative)", async () => {
      const out = await list(orgA, wsA1, {
        runId: "tse_0123456789abcdefghjkmn",
      });
      expect(out).toEqual({ items: [], nextCursor: null, total: 0 });
    });

    it("does not leak another workspace's run-scoped approval (negative)", async () => {
      const out = await list(orgA, wsA2, { runId: RUN_ID });
      expect(out.items).toEqual([]);
      expect(out.total).toBe(0);
    });
  },
);
