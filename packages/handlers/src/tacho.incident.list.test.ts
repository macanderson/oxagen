// list_incidents handler tests. The cursor codec and the row mapping are pure;
// the workspace bound, the agent narrowing through hosts, the open filter and
// the page boundary are properties of the SQL and are proven against a real
// Postgres where DATABASE_URL is set (CI's `test` job; locally:
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/tacho.incident.list.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import {
  decodeCursor,
  encodeCursor,
  toIncidentItem,
} from "./tacho.incident.list";

describe("list_incidents cursor", () => {
  const row = {
    detectedAt: new Date("2026-09-14T10:05:00.123Z"),
    publicId: "tin_0123456789abcdefghjkmn",
  };

  it("round-trips the last row's detection time and id", () => {
    expect(decodeCursor(encodeCursor(row))).toEqual({
      detectedAt: row.detectedAt,
      id: row.publicId,
    });
  });

  it("starts over on a cursor it did not mint", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
    expect(decodeCursor("nope")).toBeUndefined();
    expect(
      decodeCursor(Buffer.from("yesterday|tin_x").toString("base64url")),
    ).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from("2026-09-14T10:05:00.123Z|").toString("base64url"),
      ),
    ).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from("2026-09-14T10:05:00.123Z|tin_x|more").toString(
          "base64url",
        ),
      ),
    ).toBeUndefined();
  });
});

describe("list_incidents item", () => {
  const stored = {
    publicId: "tin_0123456789abcdefghjkmn",
    kind: "hooks_removed",
    severity: 10,
    detectedAt: new Date("2026-09-14T10:00:00.000Z"),
    detectedBy: "collector",
    hostPublicId: "tch_0123456789abcdefghjkmn",
    agentKey: "acme.core.release-bot",
    sessionPublicId: null,
    evidence: { hook: "PreToolUse" },
    resolvedAt: null,
    resolutionNote: null,
  };

  it("carries the recorded columns and null for what the store did not record", () => {
    const item = toIncidentItem(stored);
    expect(item).toEqual({
      id: stored.publicId,
      kind: "hooks_removed",
      severity: 10,
      detectedAt: "2026-09-14T10:00:00.000Z",
      detectedBy: "collector",
      hostEnrollmentId: stored.hostPublicId,
      sessionId: null,
      agentKey: stored.agentKey,
      evidence: { hook: "PreToolUse" },
      resolvedAt: null,
      resolutionNote: null,
    });
    expect(tachoIncidentList.output.shape.items.element.parse(item)).toEqual(
      item,
    );
  });

  it("refuses a severity outside the CHECK rather than coerce it", () => {
    expect(() => toIncidentItem({ ...stored, severity: 7 })).toThrow(
      RangeError,
    );
  });

  it("an evidence column that is not an object reads as an empty record", () => {
    expect(toIncidentItem({ ...stored, evidence: null }).evidence).toEqual({});
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "list_incidents against Postgres",
  async () => {
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { tachoIncidentListHandler } = await import("./tacho.incident.list");
    const support = await import(
      "@oxagen/agent/handlers/_agent-identity.test-support"
    );

    let tenant: import("@oxagen/agent/handlers/_agent-identity.test-support").SeededTenant;
    let other: import("@oxagen/agent/handlers/_agent-identity.test-support").SeededTenant;
    const orgIds: string[] = [];
    const userIds: string[] = [];
    const ids: Record<string, string> = {};
    let alphaHostPublicId = "";

    const list = (
      t: typeof tenant,
      input: Parameters<typeof tachoIncidentList.input.parse>[0] = {},
    ) =>
      runInTenantScope({ orgId: t.orgId, workspaceId: t.workspaceId }, () =>
        tachoIncidentListHandler(
          tachoIncidentList.input.parse(input),
          support.ctxFor(t, t.userId),
        ),
      );

    beforeAll(async () => {
      tenant = await support.seedTenant();
      other = await support.seedTenant();
      orgIds.push(tenant.orgId, other.orgId);
      userIds.push(tenant.userId, other.userId);
      const at = (minutesAgo: number) =>
        new Date(Date.now() - minutesAgo * 60_000);

      const alpha = await support.seedAgent(tenant, { slug: "alpha" });
      const bravo = await support.seedAgent(tenant, { slug: "bravo" });
      await support.seedAgent(tenant, {
        slug: "keyless",
        workspaceId: crypto.randomUUID(),
      });
      const alphaHost = await support.seedHost(tenant, alpha.agentKey!, {
        hostname: "a",
      });
      alphaHostPublicId = alphaHost.publicId;
      const bravoHost = await support.seedHost(tenant, bravo.agentKey!, {
        hostname: "b",
      });
      const sameInstant = at(5);
      const seeded = [
        [
          "alpha_open_newest",
          { hostId: alphaHost.id, kind: "hooks_removed", detectedAt: at(1) },
        ],
        [
          "alpha_resolved",
          {
            hostId: alphaHost.id,
            kind: "chain_break",
            detectedAt: at(2),
            resolved: true,
          },
        ],
        [
          "bravo_open",
          { hostId: bravoHost.id, kind: "token_replay", detectedAt: at(3) },
        ],
        // Two rows sharing one detection instant: the page boundary must
        // split them by id without a duplicate or a gap.
        [
          "nohost_a",
          {
            kind: "telemetry_gap",
            severity: 3 as const,
            detectedAt: sameInstant,
          },
        ],
        [
          "nohost_b",
          {
            kind: "daemon_down",
            severity: 3 as const,
            detectedAt: sameInstant,
          },
        ],
        [
          "other_ws",
          {
            kind: "hooks_removed",
            detectedAt: at(0),
            workspaceId: crypto.randomUUID(),
          },
        ],
      ] as const;
      for (const [name, over] of seeded) {
        ids[name] = (await support.seedIncident(tenant, over)).publicId;
      }
      ids.other_org = (
        await support.seedIncident(other, {
          kind: "hooks_removed",
          detectedAt: at(0),
        })
      ).publicId;
    });

    afterAll(async () => {
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    /** The two same-instant rows in the order the page boundary uses: id descending. */
    const sameInstantByIdDesc = () =>
      [ids.nohost_a!, ids.nohost_b!].sort().reverse();

    it("lists the workspace's incidents newest first, hosts and agent keys joined, and parses through the contract", async () => {
      const out = tachoIncidentList.output.parse(await list(tenant));
      expect(out.items.map((i) => i.id)).toEqual([
        ids.alpha_open_newest,
        ids.alpha_resolved,
        ids.bravo_open,
        ...sameInstantByIdDesc(),
      ]);
      expect(out.nextCursor).toBeNull();
      const first = out.items[0]!;
      expect(first.hostEnrollmentId).toBe(alphaHostPublicId);
      expect(first.agentKey).toBe(
        `${tenant.orgNamespace}.${tenant.workspaceNamespace}.alpha`,
      );
      expect(first.resolvedAt).toBeNull();
      expect(out.items[1]!.resolvedAt).not.toBeNull();
      const noHost = out.items.find((i) => i.id === ids.nohost_a)!;
      expect(noHost.hostEnrollmentId).toBeNull();
      expect(noHost.agentKey).toBeNull();
    });

    it("narrows to one agent's hosts, and to open rows", async () => {
      const alpha = await list(tenant, { agentId: "alpha" });
      expect(alpha.items.map((i) => i.id)).toEqual([
        ids.alpha_open_newest,
        ids.alpha_resolved,
      ]);
      const alphaOpen = await list(tenant, { agentId: "alpha", open: true });
      expect(alphaOpen.items.map((i) => i.id)).toEqual([ids.alpha_open_newest]);
      const open = await list(tenant, { open: true });
      expect(open.items.map((i) => i.id)).not.toContain(ids.alpha_resolved);
      expect(open.items).toHaveLength(4);
    });

    it("an agent whose key cannot be composed has no incidents; an unknown agent is not_found", async () => {
      await expect(list(tenant, { agentId: "nobody" })).rejects.toSatisfy(
        (err: unknown) =>
          isHandlerError(err) &&
          err.code === "not_found" &&
          err.reason === "agent_not_found",
      );
    });

    it("pages on (detectedAt, id) without a duplicate or a gap across a shared instant", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const out = await list(tenant, { limit: 2, cursor });
        seen.push(...out.items.map((i) => i.id));
        if (!out.nextCursor) break;
        cursor = out.nextCursor;
      }
      expect(seen).toEqual([
        ids.alpha_open_newest,
        ids.alpha_resolved,
        ids.bravo_open,
        ...sameInstantByIdDesc(),
      ]);
    });

    it("another org and the org's other workspace are out of scope", async () => {
      const mine = await list(tenant);
      expect(mine.items.map((i) => i.id)).not.toContain(ids.other_ws);
      expect(mine.items.map((i) => i.id)).not.toContain(ids.other_org);
      const theirs = await list(other);
      expect(theirs.items.map((i) => i.id)).toEqual([ids.other_org]);
    });
  },
);
