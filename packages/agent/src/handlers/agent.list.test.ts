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
import { identityStatus, wrappedTokenFigures } from "./_agent-identity";
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
  operatorName: "Marcus Bell",
  costCenter: null,
};

const none = {
  tamperIncidents: 0,
  mandates: null,
  host: null,
} as const;

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
      ...none,
      figures: undefined,
    });
    expect(item.tier).toBeNull();
    expect(item.enforcementTier).toBeNull();
    expect(item.host).toBeNull();
    expect(item.beltSize).toBeNull();
    expect(item.proven30d).toBeNull();
    expect(item.mandates).toBeNull();
    expect(item.spend30d).toBeNull();
    expect(item.tokens30d).toBeNull();
    expect(item.tamperIncidentsRecorded).toBe(0);
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
      ...none,
      figures: {
        runs: 4,
        spendMicros: 1_250_000n,
        earliestStartedAt: null,
        latestTier: null,
      },
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
      ...none,
      figures: {
        runs: 4,
        spendMicros: null,
        earliestStartedAt: null,
        latestTier: null,
      },
    });
    expect(unpriced.spend30d).toBeNull();
    expect(unpriced.status).toBe("enrolled");
  });

  it("carries the purpose, the operator's name, the recorded tier, the mandates and the live host", () => {
    const item = toAgentListItem(row, {
      agentKey: "acme.core.release-bot",
      credentials: 1,
      hosts: 1,
      incidents: 3,
      tamperIncidents: 1,
      mandates: 2,
      host: "build-01",
      figures: {
        runs: 1,
        spendMicros: null,
        earliestStartedAt: null,
        latestTier: "gateway",
      },
    });
    expect(item.description).toBeNull();
    expect(item.operatorName).toBe("Marcus Bell");
    expect(item.enforcementTier).toBe("gateway");
    expect(item.mandates).toBe(2);
    expect(item.incidents).toBe(3);
    expect(item.tamperIncidents).toBe(1);
    expect(item.host).toBe("build-01");
    expect(agentList.output.shape.items.element.parse(item)).toEqual(item);
  });

  it("reports a tier off the ladder as no tier, and no operator name without an operator", () => {
    const item = toAgentListItem(
      { ...row, operatorPublicId: null, operatorName: "stale" },
      {
        agentKey: null,
        credentials: 0,
        hosts: 0,
        incidents: 0,
        ...none,
        figures: {
          runs: 0,
          spendMicros: null,
          earliestStartedAt: null,
          latestTier: "enforced",
        },
      },
    );
    expect(item.enforcementTier).toBeNull();
    expect(item.operatorName).toBeNull();
  });
});

describe("wrapped-session tokens", () => {
  it("counts cached input as input, adds the output, and rates cache read over input", () => {
    expect(
      wrappedTokenFigures({
        sessions: 2,
        input: 100,
        output: 50,
        cacheRead: 700,
        cacheCreation: 200,
      }),
    ).toEqual({
      total: 1050,
      input: 1000,
      cacheRead: 700,
      cacheReadRate: 0.7,
      sessions: 2,
    });
  });

  it("reports nothing when no session reported a token, and no rate without input", () => {
    expect(
      wrappedTokenFigures({
        sessions: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      }),
    ).toBeNull();
    expect(
      wrappedTokenFigures({
        sessions: 1,
        input: 0,
        output: 40,
        cacheRead: 0,
        cacheCreation: 0,
      })?.cacheReadRate,
    ).toBeNull();
  });

  it("maps the rollup onto the row and the recorded tamper count beside the open one", () => {
    const tokens = wrappedTokenFigures({
      sessions: 1,
      input: 10,
      output: 5,
      cacheRead: 30,
      cacheCreation: 0,
    });
    const item = toAgentListItem(row, {
      agentKey: "acme.core.release-bot",
      credentials: 1,
      hosts: 1,
      incidents: 1,
      tamperIncidents: 1,
      tamperIncidentsRecorded: 3,
      mandates: 0,
      host: null,
      figures: {
        runs: 1,
        spendMicros: null,
        earliestStartedAt: null,
        latestTier: null,
        tokens,
      },
    });
    expect(item.tokens30d).toEqual(tokens);
    expect(item.tamperIncidents).toBe(1);
    expect(item.tamperIncidentsRecorded).toBe(3);
    expect(agentList.output.shape.items.element.parse(item)).toEqual(item);
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
        tokens: { input: 100, output: 400, cacheRead: 600, cacheCreation: 300 },
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
        tokens: { input: 9_000, output: 9_000 },
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
        detectedAt: new Date(now - 5 * DAY_MS),
      });
      // A control-plane notice with no host: counts as a workspace tamper
      // incident only if its kind is a tamper kind (telemetry_gap is not).
      await support.seedIncident(tenant, {
        kind: "telemetry_gap",
        severity: 3,
      });

      // bravo: enrolled by a paused host only; no credential; no runs; one
      // active mandate, and a draft and an expired one that count for nothing.
      const bravo = await support.seedAgent(tenant, { slug: "bravo" });
      await support.seedMandate(tenant, bravo);
      await support.seedMandate(tenant, bravo, { status: "draft" });
      await support.seedMandate(tenant, bravo, { expired: true });
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
      // echo is retired, so a read that does not ask for it never sees it.
      expect(out.items.map((i) => i.slug)).toEqual([
        "alpha",
        "bravo",
        "charlie",
        "delta",
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
      expect(alpha.tamperIncidents).toBe(1);
      // The open hooks_removed and the resolved chain_break.
      expect(alpha.tamperIncidentsRecorded).toBe(2);
      // The one in-window session that reported usage; the 40-day-old one is
      // outside the window.
      expect(alpha.tokens30d).toEqual({
        total: 1400,
        input: 1000,
        cacheRead: 600,
        cacheReadRate: 0.6,
        sessions: 1,
      });
      expect(alpha.host).toBe("build-1");
      expect(alpha.mandates).toBe(0);
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
      // Every seeded session takes the column default, `observe`.
      expect(alpha.enforcementTier).toBe("observe");
      const bravo = out.items.find((i) => i.slug === "bravo")!;
      expect(bravo.mandates).toBe(1);
      expect(bravo.enforcementTier).toBeNull();
    });

    it("lists a retired agent only when the caller asks for it", async () => {
      const shown = await list(tenant, { includeRetired: true });
      expect(shown.items.map((i) => i.slug)).toEqual([
        "alpha",
        "bravo",
        "charlie",
        "delta",
        "echo",
      ]);
      const hidden = await list(tenant, { includeRetired: false });
      expect(hidden.items.map((i) => i.slug)).not.toContain("echo");
      // The tiles count live agents whichever the page asked for.
      expect(shown.totals).toEqual(hidden.totals);
    });

    it("derives each status from what the row holds", async () => {
      const out = await list(tenant, { includeRetired: true });
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
      // A session that reported no usage is not a session that used none.
      expect(charlie.tokens30d).toBeNull();
    });

    it("counts the tiles over the whole workspace, the mandate tile included", async () => {
      const out = await list(tenant, { limit: 2 });
      expect(out.items).toHaveLength(2);
      // The tamper figures are sums over the agents' own records: alpha's
      // two, of which one is open, and the newest is the open one. The
      // hostless telemetry_gap notice belongs to no agent.
      expect(out.totals).toEqual({
        // echo is retired, so it is counted in `retired` and nowhere else.
        identities: 4,
        retired: 1,
        enrolled: 2,
        // charlie alone: delta is suspended, so it is not waiting to enroll.
        unenrolled: 1,
        holdingMandate: 1,
        mandateHolders: [
          `${tenant.orgNamespace}.${tenant.workspaceNamespace}.bravo`,
        ],
        tamperIncidents: 1,
        tamper: {
          recorded: 2,
          open: 1,
          newest: {
            agentKey: `${tenant.orgNamespace}.${tenant.workspaceNamespace}.alpha`,
            kind: "hooks_removed",
            detectedAt: expect.any(String),
          },
        },
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
      // echo is retired, so the live walk ends at delta.
      expect(second.nextCursor).toBeNull();
    });

    it("pages retired agents in slug order when the caller asks for them", async () => {
      const first = await list(tenant, { limit: 4, includeRetired: true });
      expect(first.items.map((i) => i.slug)).toEqual([
        "alpha",
        "bravo",
        "charlie",
        "delta",
      ]);
      const second = await list(tenant, {
        limit: 4,
        cursor: first.nextCursor!,
        includeRetired: true,
      });
      expect(second.items.map((i) => i.slug)).toEqual(["echo"]);
      expect(second.nextCursor).toBeNull();
    });

    it("another org sees only its own agents", async () => {
      const out = await list(other);
      expect(out.items.map((i) => i.slug)).toEqual(["alpha"]);
      expect(out.items[0]!.status).toBe("unenrolled");
      expect(out.totals.identities).toBe(1);
      expect(out.totals.retired).toBe(0);
    });
  },
);
