// list_agents handler tests.
//
// The cursor codec, the row mapping and the status derivation are pure and
// run everywhere. The queries are proven against a real Postgres: the
// workspace bound, the credential and host counts, the 30-day window, the
// status per row and the page boundary are properties of the SQL, and a fake
// store would only prove the fake. CI's `test` job migrates Postgres and
// carries DATABASE_URL; a local run without one skips the block. To run it:
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/agent exec vitest run src/handlers/agent.list.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { identityStatus } from "./_agent-identity";
import { decodeCursor, encodeCursor, toAgentListItem } from "./agent.list";

const row = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  publicId: "agt_0123456789abcdefghjkmn",
  slug: "release-bot",
  name: "Release bot",
  description: null,
  harness: "stella",
  status: "draft",
  createdAt: new Date("2026-09-13T10:00:00.000Z"),
  // A draft agent nothing has written since it was registered, which is what
  // the schema's two defaultNow() columns produce on insert.
  updatedAt: new Date("2026-09-13T10:00:00.000Z"),
  principalId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
  principalPublicId: "prn_0123456789abcdefghjkmn",
  principalStatus: "active",
  principalUpdatedAt: new Date("2026-09-13T10:00:00.000Z"),
  operatorPublicId: "usr_0123456789abcdefghjkmn",
  costCenter: null,
};

describe("list_agents cursor", () => {
  it("round-trips a slug and starts over on a cursor it did not mint", () => {
    expect(decodeCursor(encodeCursor("release-bot"))).toBe("release-bot");
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
    expect(decodeCursor("not a cursor!")).toBeUndefined();
    expect(
      decodeCursor(Buffer.from("Release Bot").toString("base64url")),
    ).toBeUndefined();
  });
});

describe("list_agents row", () => {
  it("leaves every figure no store records null, never zero", () => {
    const item = toAgentListItem(row, {
      agentKey: null,
      credentials: 0,
      hosts: 0,
      incidents: 0,
      figures: undefined,
    });
    expect(item.tier).toBeNull();
    expect(item.beltSize).toBeNull();
    expect(item.proven30d).toBeNull();
    expect(item.mandates).toBeNull();
    expect(item.spend30d).toBeNull();
    expect(item.runs30d).toBe(0);
    expect(item.status).toBe("unenrolled");
    expect(agentList.output.shape.items.element.parse(item)).toEqual(item);
  });

  it("prices the 30-day spend as client-attested micros only when a session was priced", () => {
    const priced = toAgentListItem(row, {
      agentKey: "acme.core.release-bot",
      credentials: 1,
      hosts: 0,
      incidents: 2,
      figures: { runs: 4, spendMicros: 1_250_000n, earliestStartedAt: null },
    });
    expect(priced.spend30d).toEqual({
      micros: "1250000",
      currency: "USD",
      basis: "client_attested",
    });
    expect(priced.status).toBe("enrolled");
    const unpriced = toAgentListItem(row, {
      agentKey: "acme.core.release-bot",
      credentials: 0,
      hosts: 1,
      incidents: 0,
      figures: { runs: 4, spendMicros: null, earliestStartedAt: null },
    });
    expect(unpriced.spend30d).toBeNull();
    expect(unpriced.status).toBe("enrolled");
  });
});

describe("identity status", () => {
  it("retired wins over suspended, suspended over enrolled, and enrollment needs a credential or a host", () => {
    const held = { credentials: 1, hosts: 1 };
    expect(
      identityStatus(
        { status: "archived", principalStatus: "suspended" },
        held,
      ),
    ).toBe("retired");
    expect(
      identityStatus({ status: "active", principalStatus: "suspended" }, held),
    ).toBe("suspended");
    expect(
      identityStatus({ status: "active", principalStatus: "active" }, held),
    ).toBe("enrolled");
    expect(
      identityStatus(
        { status: "active", principalStatus: "active" },
        { credentials: 0, hosts: 0 },
      ),
    ).toBe("unenrolled");
    expect(
      identityStatus(
        { status: "draft", principalStatus: null },
        { credentials: 0, hosts: 1 },
      ),
    ).toBe("enrolled");
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "list_agents against Postgres",
  async () => {
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { agentListHandler } = await import("./agent.list");
    const support = await import("./_agent-identity.test-support");

    const DAY_MS = 24 * 60 * 60 * 1000;
    let tenant: import("./_agent-identity.test-support").SeededTenant;
    let other: import("./_agent-identity.test-support").SeededTenant;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    const list = (
      t: typeof tenant,
      input: Parameters<typeof agentList.input.parse>[0] = {},
    ) =>
      runInTenantScope({ orgId: t.orgId, workspaceId: t.workspaceId }, () =>
        agentListHandler(
          agentList.input.parse(input),
          support.ctxFor(t, t.userId),
        ),
      );

    beforeAll(async () => {
      tenant = await support.seedTenant();
      other = await support.seedTenant();
      orgIds.push(tenant.orgId, other.orgId);
      userIds.push(tenant.userId, other.userId);
      const now = Date.now();

      // alpha: enrolled by an active credential; two runs in the window (one
      // priced, one unpriced), one older than 30 days, one child session;
      // one open incident and one resolved.
      const alpha = await support.seedAgent(tenant, {
        slug: "alpha",
        harness: "claude-code",
        status: "active",
      });
      await support.seedCredential(tenant, alpha);
      await support.seedCredential(tenant, alpha, { expired: true });
      await support.seedCredential(tenant, alpha, { revoked: true });
      const host = await support.seedHost(tenant, alpha.agentKey!);
      await support.seedSession(tenant, alpha.agentKey!, {
        startedAt: new Date(now - 2 * DAY_MS),
        costMicros: 700_000,
        costBasis: "list",
      });
      await support.seedSession(tenant, alpha.agentKey!, {
        startedAt: new Date(now - 3 * DAY_MS),
        costMicros: 50,
        costBasis: "list",
        hasUnknownModelCost: true,
      });
      await support.seedSession(tenant, alpha.agentKey!, {
        startedAt: new Date(now - 40 * DAY_MS),
        costMicros: 9_000_000,
        costBasis: "list",
      });
      await support.seedSession(tenant, alpha.agentKey!, {
        startedAt: new Date(now - DAY_MS),
        child: true,
      });
      await support.seedLedgerRun(tenant, alpha, new Date(now - DAY_MS));
      await support.seedIncident(tenant, {
        hostId: host.id,
        kind: "hooks_removed",
      });
      await support.seedIncident(tenant, {
        hostId: host.id,
        kind: "chain_break",
        resolved: true,
      });
      // A control-plane notice with no host: counts as a workspace tamper
      // incident only if its kind is a tamper kind (telemetry_gap is not).
      await support.seedIncident(tenant, {
        kind: "telemetry_gap",
        severity: 3,
      });

      // bravo: enrolled by a paused host only; no credential; no runs.
      const bravo = await support.seedAgent(tenant, { slug: "bravo" });
      await support.seedHost(tenant, bravo.agentKey!, { status: "paused" });
      // charlie: nothing held, an unpriced session in the window.
      const charlie = await support.seedAgent(tenant, { slug: "charlie" });
      await support.seedSession(tenant, charlie.agentKey!, {
        startedAt: new Date(now - DAY_MS),
      });
      // delta: suspended principal, holds a credential.
      const delta = await support.seedAgent(tenant, {
        slug: "delta",
        principalStatus: "suspended",
      });
      await support.seedCredential(tenant, delta);
      // echo: retired.
      const echo = await support.seedAgent(tenant, {
        slug: "echo",
        status: "archived",
        principalStatus: "suspended",
      });
      await support.seedHost(tenant, echo.agentKey!, { status: "revoked" });
      // foxtrot: soft-deleted; never listed.
      await support.seedAgent(tenant, {
        slug: "foxtrot",
        deletedAt: new Date(),
      });
      // The org's other workspace and another org: out of scope.
      await support.seedAgent(tenant, {
        slug: "zulu",
        workspaceId: crypto.randomUUID(),
      });
      await support.seedAgent(other, { slug: "alpha" });
    });

    afterAll(async () => {
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    it("lists the workspace's live agents by slug with the figures the stores record", async () => {
      const out = agentList.output.parse(await list(tenant));
      expect(out.items.map((i) => i.slug)).toEqual([
        "alpha",
        "bravo",
        "charlie",
        "delta",
        "echo",
      ]);
      const alpha = out.items[0]!;
      expect(alpha.harness).toBe("claude-code");
      expect(alpha.agentKey).toBe(
        `${tenant.orgNamespace}.${tenant.workspaceNamespace}.alpha`,
      );
      // The registering user, through the agent's OWN delegated principal —
      // which is `kind = 'agent'`, so the operator seam's `kind = 'human'`
      // filter would match nothing and blank this field for every agent
      // (discussion_r4051925928). This assertion predates that defect and did
      // not catch it, because the block is skipped without DATABASE_URL;
      // `_agent-identity.join.test.ts` asserts the same property off the
      // rendered SQL so it holds on every run.
      expect(alpha.operatorId).toBe(tenant.userPublicId);
      expect(alpha.status).toBe("enrolled");
      expect(alpha.credentials).toBe(1);
      expect(alpha.hosts).toBe(1);
      expect(alpha.incidents).toBe(1);
      // Two root sessions in the window plus one ledger run; the child and
      // the 40-day-old session are outside the count.
      expect(alpha.runs30d).toBe(3);
      // The unknown-model-cost session is unpriced; the 40-day-old one is
      // outside the window.
      expect(alpha.spend30d).toEqual({
        micros: "700000",
        currency: "USD",
        basis: "client_attested",
      });
      expect(alpha.tier).toBeNull();
      expect(alpha.mandates).toBeNull();
    });

    it("derives each status from what the row holds", async () => {
      const out = await list(tenant);
      const status = Object.fromEntries(
        out.items.map((i) => [i.slug, i.status]),
      );
      expect(status).toEqual({
        alpha: "enrolled",
        bravo: "enrolled",
        charlie: "unenrolled",
        delta: "suspended",
        echo: "retired",
      });
      const charlie = out.items.find((i) => i.slug === "charlie")!;
      expect(charlie.runs30d).toBe(1);
      expect(charlie.spend30d).toBeNull();
    });

    it("counts the tiles over the whole workspace and leaves the mandate tile null", async () => {
      const out = await list(tenant, { limit: 2 });
      expect(out.items).toHaveLength(2);
      expect(out.totals).toEqual({
        identities: 5,
        enrolled: 2,
        holdingMandate: null,
        tamperIncidents: 1,
      });
    });

    it("pages by slug without a duplicate or a gap", async () => {
      const first = await list(tenant, { limit: 2 });
      expect(first.items.map((i) => i.slug)).toEqual(["alpha", "bravo"]);
      expect(first.nextCursor).not.toBeNull();
      const second = await list(tenant, {
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(second.items.map((i) => i.slug)).toEqual(["charlie", "delta"]);
      const third = await list(tenant, {
        limit: 2,
        cursor: second.nextCursor!,
      });
      expect(third.items.map((i) => i.slug)).toEqual(["echo"]);
      expect(third.nextCursor).toBeNull();
    });

    it("another org sees only its own agents", async () => {
      const out = await list(other);
      expect(out.items.map((i) => i.slug)).toEqual(["alpha"]);
      expect(out.items[0]!.status).toBe("unenrolled");
      expect(out.totals.identities).toBe(1);
    });
  },
);
