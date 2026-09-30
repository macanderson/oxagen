// store.pg.test.ts: the discovery store against a real Postgres (lane M10,
// #4682). It covers the scoped store's writes and reads, the snapshot capture
// that skips unchanged tools, the tools store that Studio reads, and each
// cross-workspace query of the hourly sweep and the push webhook. It runs
// wherever DATABASE_URL points at a migrated database. CI's unit job migrates
// Postgres with Atlas first, and a run without DATABASE_URL skips the file.
//
// mcp.server_discoveries, mcp.tool_snapshots, mcp.mcp_servers, mcp.registries,
// and mcp.catalog_servers carry no foreign keys, so the file writes no
// organization or workspace rows. Each case takes fresh workspace ids, and
// afterAll removes every row the file wrote by its two org ids, and the
// catalog entries of their registries.
import { randomUUID } from "node:crypto";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DiscoveryFinish,
  type DiscoveryRow,
  type DiscoveryStore,
  type DiscoveryTarget,
  type OnChangeTarget,
  postgresDiscoveryClaimStore,
  postgresDiscoveryStore,
  postgresDiscoverySweepStore,
  postgresDiscoveryToolsStore,
  readWithheldTools,
  readWorkspaceWithheldTools,
  type SnapshotDescriptor,
} from "./store";
import type { DiscoveryScope } from "./types";

const enabled = Boolean(process.env.DATABASE_URL);

const store = postgresDiscoveryStore;
const sweep = postgresDiscoverySweepStore;
const toolsStore = postgresDiscoveryToolsStore;

const T0 = new Date("2026-09-28T09:00:00.000Z");
const T1 = new Date("2026-09-28T09:01:00.000Z");
const T2 = new Date("2026-09-28T09:02:00.000Z");
const T3 = new Date("2026-09-28T09:03:00.000Z");

/** base moved by a number of hours; a negative number moves it back. */
const shift = (base: Date, hours: number) =>
  new Date(base.getTime() + hours * 3_600_000);

const PR = {
  number: 42,
  url: "https://github.com/acme/steering/pull/42",
  branch: "oxagen/sync/github",
};

function finished(over: Partial<DiscoveryFinish> = {}): DiscoveryFinish {
  return {
    status: "succeeded",
    outcome: "unchanged",
    error: null,
    toolCount: 2,
    machine: null,
    upstreamDigest: null,
    latestVersion: null,
    pr: null,
    withheld: [],
    ...over,
  };
}

describe("readWithheldTools over a given store", () => {
  const scope: DiscoveryScope = {
    orgId: randomUUID(),
    workspaceId: randomUUID(),
  };
  const row: DiscoveryRow = {
    id: randomUUID(),
    server: "github",
    mcpServerId: null,
    status: "succeeded",
    trigger: "schedule",
    requestedAt: T0,
    requestedBy: null,
    startedAt: T0,
    finishedAt: T1,
    error: null,
    outcome: "pr_opened",
    toolCount: 1,
    machine: null,
    sourceKind: "remote",
    sourceRepo: null,
    sourcePath: null,
    sourceRef: null,
    schedule: "daily",
    upstreamDigest: null,
    latestVersion: null,
    pr: PR,
    withheld: ["github.create_issue"],
  };

  function storeAnswering(answer: DiscoveryRow | null) {
    const asked: Array<{ scope: DiscoveryScope; server: string }> = [];
    const fake: DiscoveryStore = {
      ...postgresDiscoveryStore,
      read: async (readScope, server) => {
        asked.push({ scope: readScope, server });
        return answer;
      },
    };
    return { fake, asked };
  }

  it("returns the withheld names from the store's row", async () => {
    const { fake, asked } = storeAnswering(row);
    expect(await readWithheldTools(scope, "github", fake)).toEqual([
      "github.create_issue",
    ]);
    expect(asked).toEqual([{ scope, server: "github" }]);
  });

  it("returns an empty list when the store has no row", async () => {
    const { fake } = storeAnswering(null);
    expect(await readWithheldTools(scope, "github", fake)).toEqual([]);
  });
});

describe.skipIf(!enabled)("the discovery store against Postgres", () => {
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const USER = randomUUID();
  const OTHER_USER = randomUUID();

  const discoveries = schema.mcpServerDiscoveries;
  const snapshots = schema.mcpToolSnapshots;

  const newScope = (org: string = orgId): DiscoveryScope => ({
    orgId: org,
    workspaceId: randomUUID(),
  });

  async function rawRow(scope: DiscoveryScope, server: string) {
    const [row] = await withSystemDb((tx) =>
      tx
        .select()
        .from(discoveries)
        .where(
          and(
            eq(discoveries.orgId, scope.orgId),
            eq(discoveries.workspaceId, scope.workspaceId),
            eq(discoveries.server, server),
          ),
        ),
    );
    if (!row) throw new Error(`no discovery row for ${server}`);
    return row;
  }

  function snapshotRows(scope: DiscoveryScope, mcpServerId: string) {
    return withSystemDb((tx) =>
      tx
        .select()
        .from(snapshots)
        .where(
          and(
            eq(snapshots.orgId, scope.orgId),
            eq(snapshots.workspaceId, scope.workspaceId),
            eq(snapshots.mcpServerId, mcpServerId),
          ),
        )
        .orderBy(asc(snapshots.capturedAt), asc(snapshots.toolName)),
    );
  }

  /** Write one snapshot row directly, and return its id. */
  async function pin(
    scope: DiscoveryScope,
    mcpServerId: string,
    toolName: string,
    schemaJson: unknown,
    capturedAt: Date,
  ): Promise<string> {
    const id = randomUUID();
    await withSystemDb((tx) =>
      tx.insert(snapshots).values({
        id,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        mcpServerId,
        toolName,
        schemaJson,
        capturedAt,
      }),
    );
    return id;
  }

  afterAll(async () => {
    const orgs = [orgId, otherOrgId];
    await withSystemDb(async (tx) => {
      await tx.delete(discoveries).where(inArray(discoveries.orgId, orgs));
      await tx.delete(snapshots).where(inArray(snapshots.orgId, orgs));
      await tx
        .delete(schema.mcpServers)
        .where(inArray(schema.mcpServers.orgId, orgs));
      const registries = await tx
        .select({ id: schema.mcpRegistries.id })
        .from(schema.mcpRegistries)
        .where(inArray(schema.mcpRegistries.orgId, orgs));
      if (registries.length > 0) {
        await tx.delete(schema.mcpCatalogServers).where(
          inArray(
            schema.mcpCatalogServers.registryId,
            registries.map((registry) => registry.id),
          ),
        );
      }
      await tx
        .delete(schema.mcpRegistries)
        .where(inArray(schema.mcpRegistries.orgId, orgs));
    });
    await closeDatabase();
  });

  describe("a discovery that waits for a machine (#4772)", () => {
    const claims = postgresDiscoveryClaimStore;

    async function waiting(scope: DiscoveryScope, server: string, groups: string[]) {
      await store.request(scope, server, "list_changed", null, T0);
      await store.begin(scope, server, "list_changed", null, T1);
      await store.finish(
        scope,
        server,
        finished({ status: "waiting_for_machine", outcome: null, machineGroups: groups }),
        T2,
      );
    }

    it("records the groups and leaves the discovery unfinished", async () => {
      const scope = newScope();
      await waiting(scope, "files", ["dev-laptops"]);
      const row = await rawRow(scope, "files");
      expect(row).toMatchObject({
        status: "waiting_for_machine",
        machineGroups: ["dev-laptops"],
        finishedAt: null,
      });
      await expect(store.read(scope, "files")).resolves.toMatchObject({
        status: "waiting_for_machine",
      });
    });

    it("claims a waiting discovery once for a machine in its groups, and marks it queued", async () => {
      const scope = newScope();
      await waiting(scope, "files", ["dev-laptops", "ci-runners"]);
      const [first, second] = await Promise.all([
        claims.claimWaiting(scope, ["ci-runners"], T3),
        claims.claimWaiting(scope, ["ci-runners"], T3),
      ]);
      const won = [first, second].filter((claim) => claim !== null);
      expect(won).toEqual([
        { server: "files", trigger: "list_changed", requestedBy: null },
      ]);
      expect((await rawRow(scope, "files")).status).toBe("queued");
      await expect(claims.claimWaiting(scope, ["ci-runners"], T3)).resolves.toBeNull();
    });

    it("claims nothing for a machine in no group the discovery names, or in no group at all", async () => {
      const scope = newScope();
      await waiting(scope, "files", ["dev-laptops"]);
      await expect(claims.claimWaiting(scope, ["ci-runners"], T3)).resolves.toBeNull();
      await expect(claims.claimWaiting(scope, [], T3)).resolves.toBeNull();
      await expect(claims.claimWaiting(newScope(), ["dev-laptops"], T3)).resolves.toBeNull();
      expect((await rawRow(scope, "files")).status).toBe("waiting_for_machine");
    });

    it("clears the groups when the next run finishes", async () => {
      const scope = newScope();
      await waiting(scope, "files", ["dev-laptops"]);
      await store.finish(scope, "files", finished(), T3);
      expect(await rawRow(scope, "files")).toMatchObject({
        status: "succeeded",
        machineGroups: [],
        finishedAt: T3,
      });
    });

    it("is not a stalled discovery for the hourly sweep", async () => {
      const scope = newScope();
      await waiting(scope, "files", ["dev-laptops"]);
      const stalled = await sweep.stalled(shift(T3, 48), 200);
      expect(stalled.filter((target) => target.scope.workspaceId === scope.workspaceId)).toEqual([]);
    });
  });

  describe("the scoped store", () => {
    it("reads no row, no list, and no withheld tools for a new workspace", async () => {
      const scope = newScope();
      expect(await store.read(scope, "github")).toBeNull();
      expect(await store.list(scope)).toEqual([]);
      expect(await readWithheldTools(scope, "github")).toEqual([]);
    });

    it("request writes a queued row with the trigger and the person who asked", async () => {
      const scope = newScope();
      await store.request(scope, "github", "manual", USER, T0);
      expect(await store.read(scope, "github")).toEqual({
        id: expect.any(String),
        server: "github",
        mcpServerId: null,
        status: "queued",
        trigger: "manual",
        requestedAt: T0,
        requestedBy: USER,
        startedAt: null,
        finishedAt: null,
        error: null,
        outcome: null,
        toolCount: null,
        machine: null,
        sourceKind: null,
        sourceRepo: null,
        sourcePath: null,
        sourceRef: null,
        schedule: null,
        upstreamDigest: null,
        latestVersion: null,
        pr: null,
        withheld: [],
      });
      expect(await rawRow(scope, "github")).toMatchObject({
        createdAt: T0,
        updatedAt: T0,
        offered: [],
        withheldUpstream: [],
      });
    });

    it("keeps one id for the server across requests, runs, and finishes", async () => {
      const scope = newScope();
      await store.request(scope, "github", "manual", USER, T0);
      const first = await store.read(scope, "github");
      await store.begin(scope, "github", "manual", USER, T1);
      await store.finish(scope, "github", finished(), T2);
      await store.request(scope, "github", "schedule", null, T3);

      expect(first?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect((await store.read(scope, "github"))?.id).toBe(first?.id);
      expect(await rawRow(scope, "github")).toMatchObject({ id: first?.id });
    });

    it("request stores every trigger the type names", async () => {
      const scope = newScope();
      for (const trigger of schema.MCP_DISCOVERY_TRIGGERS) {
        await store.request(scope, "github", trigger, null, T0);
        expect((await store.read(scope, "github"))?.trigger).toBe(trigger);
      }
    });

    it("a second request replaces the trigger and the asker, and keeps the steering PR and the withheld tools", async () => {
      const scope = newScope();
      await store.request(scope, "github", "manual", USER, T0);
      await store.begin(scope, "github", "manual", null, T1);
      await store.finish(
        scope,
        "github",
        finished({
          outcome: "pr_opened",
          pr: PR,
          withheld: ["github.create_issue"],
        }),
        T2,
      );
      await store.request(scope, "github", "schedule", null, T3);
      expect(await store.read(scope, "github")).toMatchObject({
        status: "queued",
        trigger: "schedule",
        requestedAt: T3,
        requestedBy: null,
        finishedAt: T2,
        outcome: "pr_opened",
        pr: PR,
        withheld: ["github.create_issue"],
      });
      expect(await rawRow(scope, "github")).toMatchObject({
        createdAt: T0,
        updatedAt: T3,
      });
    });

    it("begin on a server with no row returns null and marks the server running", async () => {
      const scope = newScope();
      expect(await store.begin(scope, "github", "push", null, T1)).toBeNull();
      expect(await store.read(scope, "github")).toMatchObject({
        status: "running",
        trigger: "push",
        requestedAt: T1,
        requestedBy: null,
        startedAt: T1,
        finishedAt: null,
        error: null,
      });
    });

    it("begin on a queued row returns that row and keeps who asked and when", async () => {
      const scope = newScope();
      await store.request(scope, "github", "manual", USER, T0);
      const prior = await store.begin(scope, "github", "manual", null, T1);
      expect(prior).toMatchObject({
        status: "queued",
        requestedBy: USER,
        requestedAt: T0,
        startedAt: null,
      });
      expect(await store.read(scope, "github")).toMatchObject({
        status: "running",
        requestedBy: USER,
        requestedAt: T0,
        startedAt: T1,
      });
      expect(await rawRow(scope, "github")).toMatchObject({
        createdAt: T0,
        updatedAt: T1,
      });
    });

    it("begin names its own asker over the queued one", async () => {
      const scope = newScope();
      await store.request(scope, "github", "manual", USER, T0);
      await store.begin(scope, "github", "manual", OTHER_USER, T1);
      expect(await store.read(scope, "github")).toMatchObject({
        requestedBy: OTHER_USER,
        requestedAt: T0,
      });
    });

    it("begin clears the last finish time and error", async () => {
      const scope = newScope();
      await store.begin(scope, "github", "schedule", null, T0);
      await store.finish(
        scope,
        "github",
        finished({
          status: "failed",
          outcome: null,
          error: "The registry answered HTTP 502.",
        }),
        T1,
      );
      await store.begin(scope, "github", "list_changed", null, T2);
      expect(await store.read(scope, "github")).toMatchObject({
        status: "running",
        trigger: "list_changed",
        startedAt: T2,
        finishedAt: null,
        error: null,
      });
    });

    it("recordSource writes the source fields and the server id", async () => {
      const scope = newScope();
      const mcpServerId = randomUUID();
      await store.request(scope, "github", "manual", null, T0);
      await store.recordSource(
        scope,
        "github",
        {
          kind: "openapi",
          repo: `github.com/acme-${tag}/lifecycle`,
          path: "specs/github.yaml",
          ref: "main",
          schedule: "on-change",
          mcpServerId,
          registryName: null,
          version: null,
        },
        T1,
      );
      expect(await store.read(scope, "github")).toMatchObject({
        status: "queued",
        mcpServerId,
        sourceKind: "openapi",
        sourceRepo: `github.com/acme-${tag}/lifecycle`,
        sourcePath: "specs/github.yaml",
        sourceRef: "main",
        schedule: "on-change",
      });
      expect((await rawRow(scope, "github")).updatedAt).toEqual(T1);
    });

    it("recordSource writes a registry server's name and version, and clears them for another kind", async () => {
      const scope = newScope();
      await store.request(scope, "github", "schedule", null, T0);
      await store.recordSource(
        scope,
        "github",
        {
          kind: "registry",
          repo: null,
          path: null,
          ref: null,
          schedule: "daily",
          mcpServerId: null,
          registryName: "io.github.github/github-mcp-server",
          version: "0.18.0",
        },
        T1,
      );
      expect(await rawRow(scope, "github")).toMatchObject({
        sourceKind: "registry",
        sourceRegistryName: "io.github.github/github-mcp-server",
        sourceVersion: "0.18.0",
      });

      await store.recordSource(
        scope,
        "github",
        {
          kind: "remote",
          repo: null,
          path: null,
          ref: null,
          schedule: "daily",
          mcpServerId: null,
          registryName: null,
          version: null,
        },
        T2,
      );
      expect(await rawRow(scope, "github")).toMatchObject({
        sourceKind: "remote",
        sourceRegistryName: null,
        sourceVersion: null,
      });
    });

    it("recordSource and finish write nothing for a server with no row", async () => {
      const scope = newScope();
      await store.recordSource(
        scope,
        "github",
        {
          kind: "remote",
          repo: null,
          path: null,
          ref: null,
          schedule: "daily",
          mcpServerId: randomUUID(),
          registryName: null,
          version: null,
        },
        T0,
      );
      await store.finish(scope, "github", finished(), T1);
      expect(await store.read(scope, "github")).toBeNull();
      expect(await store.list(scope)).toEqual([]);
    });

    it("finish writes a succeeded run with its steering PR", async () => {
      const scope = newScope();
      await store.begin(scope, "github", "manual", USER, T0);
      await store.finish(
        scope,
        "github",
        {
          status: "succeeded",
          outcome: "pr_opened",
          error: null,
          toolCount: 3,
          machine: "tch_laptop",
          upstreamDigest: "sha256:abc",
          latestVersion: "1.4.0",
          pr: PR,
          withheld: ["github.create_issue"],
          offered: ["create_issue", "list_issues", "search"],
          withheldUpstream: ["create_issue"],
        },
        T1,
      );
      expect(await store.read(scope, "github")).toEqual({
        id: expect.any(String),
        server: "github",
        mcpServerId: null,
        status: "succeeded",
        trigger: "manual",
        requestedAt: T0,
        requestedBy: USER,
        startedAt: T0,
        finishedAt: T1,
        error: null,
        outcome: "pr_opened",
        toolCount: 3,
        machine: "tch_laptop",
        sourceKind: null,
        sourceRepo: null,
        sourcePath: null,
        sourceRef: null,
        schedule: null,
        upstreamDigest: "sha256:abc",
        latestVersion: "1.4.0",
        pr: PR,
        withheld: ["github.create_issue"],
      });
      expect(await rawRow(scope, "github")).toMatchObject({
        prNumber: 42,
        prUrl: PR.url,
        prBranch: PR.branch,
        offered: ["create_issue", "list_issues", "search"],
        withheldUpstream: ["create_issue"],
        updatedAt: T1,
      });
    });

    it("finish with no steering PR clears the stored one", async () => {
      const scope = newScope();
      await store.begin(scope, "github", "schedule", null, T0);
      await store.finish(
        scope,
        "github",
        finished({ outcome: "pr_opened", pr: PR }),
        T1,
      );
      await store.begin(scope, "github", "schedule", null, T2);
      await store.finish(
        scope,
        "github",
        finished({
          status: "failed",
          outcome: null,
          error: "The registry answered HTTP 502.",
          toolCount: null,
        }),
        T3,
      );
      expect(await store.read(scope, "github")).toMatchObject({
        status: "failed",
        outcome: null,
        error: "The registry answered HTTP 502.",
        toolCount: null,
        finishedAt: T3,
        pr: null,
        withheld: [],
      });
      expect(await rawRow(scope, "github")).toMatchObject({
        prNumber: null,
        prUrl: null,
        prBranch: null,
      });
    });

    it("finish stores every outcome the type names", async () => {
      const scope = newScope();
      await store.begin(scope, "github", "schedule", null, T0);
      for (const outcome of schema.MCP_DISCOVERY_OUTCOMES) {
        await store.finish(scope, "github", finished({ outcome }), T1);
        expect((await store.read(scope, "github"))?.outcome).toBe(outcome);
      }
    });

    it("finish keeps the offered and withheld upstream names when a run omits them", async () => {
      const scope = newScope();
      await store.begin(scope, "github", "schedule", null, T0);
      await store.finish(
        scope,
        "github",
        finished({
          offered: ["create_issue", "search"],
          withheldUpstream: ["create_issue"],
        }),
        T1,
      );
      expect(await rawRow(scope, "github")).toMatchObject({
        offered: ["create_issue", "search"],
        withheldUpstream: ["create_issue"],
      });

      await store.finish(scope, "github", finished(), T2);
      expect(await rawRow(scope, "github")).toMatchObject({
        offered: ["create_issue", "search"],
        withheldUpstream: ["create_issue"],
        finishedAt: T2,
      });

      await store.finish(
        scope,
        "github",
        finished({ offered: [], withheldUpstream: [] }),
        T3,
      );
      expect(await rawRow(scope, "github")).toMatchObject({
        offered: [],
        withheldUpstream: [],
      });
    });
  });

  describe("workspace scope", () => {
    it("reads and lists only the rows of the scope's workspace, by server name", async () => {
      const a = newScope();
      const b = newScope();
      const c = newScope(otherOrgId);
      const sameWorkspaceOtherOrg: DiscoveryScope = {
        orgId: otherOrgId,
        workspaceId: a.workspaceId,
      };
      for (const server of ["zeta", "alpha", "mid"]) {
        await store.request(a, server, "manual", USER, T0);
      }
      await store.request(b, "alpha", "schedule", null, T1);
      await store.request(b, "beta", "schedule", null, T1);
      await store.request(c, "alpha", "push", null, T1);

      expect((await store.list(a)).map((r) => r.server)).toEqual([
        "alpha",
        "mid",
        "zeta",
      ]);
      expect((await store.list(b)).map((r) => r.server)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(await store.list(sameWorkspaceOtherOrg)).toEqual([]);
      expect(await store.read(a, "alpha")).toMatchObject({
        trigger: "manual",
        requestedBy: USER,
      });
      expect(await store.read(a, "beta")).toBeNull();
      expect(await store.read(sameWorkspaceOtherOrg, "alpha")).toBeNull();
    });

    it("writes to one workspace leave the same server in another alone", async () => {
      const a = newScope();
      const b = newScope();
      await store.request(a, "github", "manual", USER, T0);
      await store.request(b, "github", "manual", USER, T0);
      await store.begin(b, "github", "manual", null, T1);
      await store.recordSource(
        b,
        "github",
        {
          kind: "remote",
          repo: null,
          path: null,
          ref: null,
          schedule: "daily",
          mcpServerId: randomUUID(),
          registryName: null,
          version: null,
        },
        T1,
      );
      await store.finish(
        b,
        "github",
        finished({ pr: PR, withheld: ["github.create_issue"] }),
        T2,
      );
      expect(await store.read(a, "github")).toMatchObject({
        status: "queued",
        mcpServerId: null,
        startedAt: null,
        finishedAt: null,
        sourceKind: null,
        pr: null,
        withheld: [],
      });
      expect(await readWithheldTools(a, "github")).toEqual([]);
      expect(await readWithheldTools(b, "github")).toEqual([
        "github.create_issue",
      ]);
    });

    it("readWorkspaceWithheldTools returns every server's withheld names in the scope's workspace only", async () => {
      const a = newScope();
      const b = newScope();
      const sameWorkspaceOtherOrg: DiscoveryScope = {
        orgId: otherOrgId,
        workspaceId: a.workspaceId,
      };
      const withhold = async (
        scope: DiscoveryScope,
        server: string,
        withheld: string[],
      ) => {
        await store.request(scope, server, "manual", USER, T0);
        await store.finish(scope, server, finished({ pr: PR, withheld }), T1);
      };
      await withhold(a, "billing", [
        "billing__create_refund",
        "billing__list_disputes",
      ]);
      await withhold(a, "github", ["github__create_issue"]);
      await withhold(a, "slack", []);
      await store.request(a, "linear", "manual", USER, T0);
      await withhold(b, "billing", ["billing__void_invoice"]);
      await withhold(sameWorkspaceOtherOrg, "billing", [
        "billing__close_account",
      ]);

      expect([...(await readWorkspaceWithheldTools(a))].sort()).toEqual([
        "billing__create_refund",
        "billing__list_disputes",
        "github__create_issue",
      ]);
      expect([...(await readWorkspaceWithheldTools(b))]).toEqual([
        "billing__void_invoice",
      ]);
      expect(await readWorkspaceWithheldTools(newScope())).toEqual(new Set());
    });
  });

  describe("captureSnapshots", () => {
    const createIssue: SnapshotDescriptor = {
      name: "create_issue",
      description: "Open an issue.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    };
    const listIssues: SnapshotDescriptor = {
      name: "list_issues",
      description: null,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    };

    async function newestOf(
      scope: DiscoveryScope,
      mcpServerId: string,
      toolName: string,
    ) {
      const rows = (await snapshotRows(scope, mcpServerId)).filter(
        (r) => r.toolName === toolName,
      );
      return rows[rows.length - 1];
    }

    it("writes nothing for an empty list", async () => {
      const scope = newScope();
      const id = randomUUID();
      expect(await store.captureSnapshots(scope, id, [])).toBe(0);
      expect(await snapshotRows(scope, id)).toEqual([]);
    });

    it("writes one row per tool on the first capture", async () => {
      const scope = newScope();
      const id = randomUUID();
      expect(
        await store.captureSnapshots(scope, id, [createIssue, listIssues]),
      ).toBe(2);
      const rows = await snapshotRows(scope, id);
      expect(rows.map((r) => r.toolName).sort()).toEqual([
        "create_issue",
        "list_issues",
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          mcpServerId: id,
          createdById: null,
        });
      }
      const json = new Map(
        rows.map((r) => [r.toolName, r.schemaJson] as const),
      );
      // A descriptor with no annotations stores no annotations key.
      expect(json.get("create_issue")).toStrictEqual({
        name: "create_issue",
        description: "Open an issue.",
        inputSchema: createIssue.inputSchema,
      });
      expect(json.get("list_issues")).toStrictEqual({
        name: "list_issues",
        description: null,
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      });
    });

    it("writes nothing when the content is unchanged, whatever the key order", async () => {
      const scope = newScope();
      const id = randomUUID();
      await store.captureSnapshots(scope, id, [createIssue, listIssues]);
      const reordered: SnapshotDescriptor = {
        inputSchema: {
          required: ["title"],
          properties: { title: { type: "string" } },
          type: "object",
        },
        description: "Open an issue.",
        name: "create_issue",
      };
      expect(
        await store.captureSnapshots(scope, id, [listIssues, reordered]),
      ).toBe(0);
      expect(await snapshotRows(scope, id)).toHaveLength(2);
    });

    it("writes a row for a changed description, and the next capture compares with that row", async () => {
      const scope = newScope();
      const id = randomUUID();
      await store.captureSnapshots(scope, id, [createIssue, listIssues]);
      const edited = {
        ...createIssue,
        description: "Open an issue in a repository.",
      };
      expect(
        await store.captureSnapshots(scope, id, [edited, listIssues]),
      ).toBe(1);
      expect(await snapshotRows(scope, id)).toHaveLength(3);
      expect((await newestOf(scope, id, "create_issue"))?.schemaJson).toEqual({
        name: "create_issue",
        description: "Open an issue in a repository.",
        inputSchema: createIssue.inputSchema,
      });
      expect(
        await store.captureSnapshots(scope, id, [edited, listIssues]),
      ).toBe(0);
    });

    it("writes a row for a changed input schema", async () => {
      const scope = newScope();
      const id = randomUUID();
      await store.captureSnapshots(scope, id, [createIssue, listIssues]);
      const edited = {
        ...createIssue,
        inputSchema: { ...createIssue.inputSchema, required: [] },
      };
      expect(
        await store.captureSnapshots(scope, id, [edited, listIssues]),
      ).toBe(1);
      expect(
        (await newestOf(scope, id, "create_issue"))?.schemaJson,
      ).toMatchObject({ inputSchema: { required: [] } });
    });

    it("writes a row for a changed annotation", async () => {
      const scope = newScope();
      const id = randomUUID();
      await store.captureSnapshots(scope, id, [createIssue, listIssues]);
      const edited = { ...listIssues, annotations: { readOnlyHint: false } };
      expect(
        await store.captureSnapshots(scope, id, [createIssue, edited]),
      ).toBe(1);
      expect(
        (await newestOf(scope, id, "list_issues"))?.schemaJson,
      ).toMatchObject({ annotations: { readOnlyHint: false } });
    });

    it("writes a row when annotations appear and again when they go away", async () => {
      const scope = newScope();
      const id = randomUUID();
      const hinted = {
        ...createIssue,
        annotations: { destructiveHint: false },
      };
      expect(await store.captureSnapshots(scope, id, [createIssue])).toBe(1);
      expect(await store.captureSnapshots(scope, id, [hinted])).toBe(1);
      expect(await store.captureSnapshots(scope, id, [createIssue])).toBe(1);
      expect(await snapshotRows(scope, id)).toHaveLength(3);
    });

    it("reads a stored row with a null or missing field as the same content", async () => {
      const scope = newScope();
      const id = randomUUID();
      // Rows the registration path wrote before annotations existed, one with
      // an explicit null and one with no description or input schema.
      await pin(
        scope,
        id,
        "list_issues",
        {
          name: "list_issues",
          inputSchema: { type: "object" },
          annotations: null,
        },
        T0,
      );
      await pin(scope, id, "ping", { name: "ping" }, T0);
      expect(
        await store.captureSnapshots(scope, id, [
          {
            name: "list_issues",
            description: null,
            inputSchema: { type: "object" },
          },
          { name: "ping", description: null, inputSchema: {} },
        ]),
      ).toBe(0);
      expect(await snapshotRows(scope, id)).toHaveLength(2);
    });

    it("writes only the new tool when the source adds one", async () => {
      const scope = newScope();
      const id = randomUUID();
      expect(await store.captureSnapshots(scope, id, [createIssue])).toBe(1);
      expect(
        await store.captureSnapshots(scope, id, [createIssue, listIssues]),
      ).toBe(1);
      expect(
        (await snapshotRows(scope, id)).map((r) => r.toolName).sort(),
      ).toEqual(["create_issue", "list_issues"]);
    });

    it("keeps each workspace's snapshots apart for the same server id", async () => {
      const a = newScope();
      const b = newScope();
      const id = randomUUID();
      expect(
        await store.captureSnapshots(a, id, [createIssue, listIssues]),
      ).toBe(2);
      expect(
        await store.captureSnapshots(b, id, [createIssue, listIssues]),
      ).toBe(2);
      expect(await snapshotRows(a, id)).toHaveLength(2);
      expect(await snapshotRows(b, id)).toHaveLength(2);
    });
  });

  describe("the tools store", () => {
    const C1 = new Date("2026-09-01T00:00:00.000Z");
    const C2 = new Date("2026-09-02T00:00:00.000Z");
    const C3 = new Date("2026-09-03T00:00:00.000Z");
    const C4 = new Date("2026-09-04T00:00:00.000Z");

    /** Leave a finished row that offered these names from this server id. */
    async function offer(
      scope: DiscoveryScope,
      server: string,
      mcpServerId: string | null,
      offered: string[],
      withheldUpstream: string[] = [],
    ): Promise<void> {
      await store.request(scope, server, "manual", null, T0);
      if (mcpServerId !== null) {
        await store.recordSource(
          scope,
          server,
          {
            kind: "remote",
            repo: null,
            path: null,
            ref: null,
            schedule: "daily",
            mcpServerId,
            registryName: null,
            version: null,
          },
          T1,
        );
      }
      await store.finish(
        scope,
        server,
        finished({
          offered,
          withheldUpstream,
          withheld: withheldUpstream.map((name) => `${server}.${name}`),
        }),
        T2,
      );
    }

    it("returns no tools for a server with no row", async () => {
      expect(await toolsStore.read(newScope(), "github")).toEqual({
        withheldUpstream: [],
        tools: [],
      });
    });

    it("returns the withheld names and no tools while the row names no server id", async () => {
      const scope = newScope();
      await offer(scope, "github", null, ["create_issue"], ["create_issue"]);
      expect(await toolsStore.read(scope, "github")).toEqual({
        withheldUpstream: ["create_issue"],
        tools: [],
      });
    });

    it("returns no tools when the last read offered none", async () => {
      const scope = newScope();
      const id = randomUUID();
      await pin(
        scope,
        id,
        "create_issue",
        {
          name: "create_issue",
          description: "Open an issue.",
          inputSchema: {},
        },
        C1,
      );
      await offer(scope, "github", id, []);
      expect(await toolsStore.read(scope, "github")).toEqual({
        withheldUpstream: [],
        tools: [],
      });
    });

    it("returns the newest snapshot of each offered tool, sorted by name", async () => {
      const scope = newScope();
      const other = newScope();
      const id = randomUUID();
      await pin(
        scope,
        id,
        "create_issue",
        { name: "create_issue", description: "Old.", inputSchema: {} },
        C1,
      );
      const created = await pin(
        scope,
        id,
        "create_issue",
        {
          name: "create_issue",
          description: "Open an issue.",
          inputSchema: { type: "object", required: ["title"] },
          annotations: { destructiveHint: false },
        },
        C3,
      );
      const listed = await pin(
        scope,
        id,
        "list_issues",
        {
          name: "list_issues",
          description: null,
          inputSchema: { type: "object" },
        },
        C2,
      );
      const searched = await pin(
        scope,
        id,
        "search",
        {
          name: "search",
          description: "Search code.",
          inputSchema: { type: "object" },
        },
        C1,
      );
      // The source dropped delete_repo, so the offered list leaves it out.
      await pin(
        scope,
        id,
        "delete_repo",
        { name: "delete_repo", description: "Delete.", inputSchema: {} },
        C3,
      );
      // Newer rows in another workspace and for another server stay out.
      await pin(
        other,
        id,
        "create_issue",
        {
          name: "create_issue",
          description: "Other workspace.",
          inputSchema: {},
        },
        C4,
      );
      await pin(
        scope,
        randomUUID(),
        "create_issue",
        { name: "create_issue", description: "Other server.", inputSchema: {} },
        C4,
      );
      await offer(
        scope,
        "github",
        id,
        ["search", "list_issues", "never_pinned", "create_issue"],
        ["create_issue"],
      );

      expect(await toolsStore.read(scope, "github")).toEqual({
        withheldUpstream: ["create_issue"],
        tools: [
          {
            name: "create_issue",
            description: "Open an issue.",
            inputSchema: { type: "object", required: ["title"] },
            annotations: { destructiveHint: false },
            snapshotId: created,
            capturedAt: C3,
          },
          {
            name: "list_issues",
            description: null,
            inputSchema: { type: "object" },
            annotations: null,
            snapshotId: listed,
            capturedAt: C2,
          },
          {
            name: "search",
            description: "Search code.",
            inputSchema: { type: "object" },
            annotations: null,
            snapshotId: searched,
            capturedAt: C1,
          },
        ],
      });
      expect(await toolsStore.read(other, "github")).toEqual({
        withheldUpstream: [],
        tools: [],
      });
    });

    it("reads a malformed snapshot as a tool with no description, schema, or annotations", async () => {
      const scope = newScope();
      const id = randomUUID();
      const odd = await pin(
        scope,
        id,
        "odd",
        { description: 42, inputSchema: "an object", annotations: ["hint"] },
        C1,
      );
      const listed = await pin(
        scope,
        id,
        "listed",
        ["not", "an", "object"],
        C1,
      );
      await offer(scope, "github", id, ["odd", "listed"]);
      expect((await toolsStore.read(scope, "github")).tools).toEqual([
        {
          name: "listed",
          description: null,
          inputSchema: {},
          annotations: null,
          snapshotId: listed,
          capturedAt: C1,
        },
        {
          name: "odd",
          description: null,
          inputSchema: {},
          annotations: null,
          snapshotId: odd,
          capturedAt: C1,
        },
      ]);
    });

    it("shows what captureSnapshots wrote, annotations included", async () => {
      const scope = newScope();
      const id = randomUUID();
      await store.captureSnapshots(scope, id, [
        {
          name: "list_issues",
          description: null,
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "create_issue",
          description: "Open an issue.",
          inputSchema: { type: "object" },
        },
      ]);
      await offer(scope, "github", id, ["list_issues", "create_issue"]);
      const rows = await snapshotRows(scope, id);
      const { tools } = await toolsStore.read(scope, "github");
      expect(tools.map(({ snapshotId, capturedAt, ...tool }) => tool)).toEqual([
        {
          name: "create_issue",
          description: "Open an issue.",
          inputSchema: { type: "object" },
          annotations: null,
        },
        {
          name: "list_issues",
          description: null,
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ]);
      expect(tools.map((tool) => tool.snapshotId).sort()).toEqual(
        rows.map((r) => r.id).sort(),
      );
    });
  });

  describe("steeringServerId and the sweep store", () => {
    const A = newScope();
    const B = newScope();
    const C = newScope(otherOrgId);
    const REPO = `github.com/acme-${tag}/defs`;
    const BEFORE = new Date("2026-09-28T12:00:00.000Z");
    // The stalled cutoff sits before any row a test inserts at the clock's
    // now, so only the rows seeded older than it can stall.
    const STALE = new Date("2026-09-01T00:00:00.000Z");
    const ids = {
      fresh: randomUUID(),
      found: randomUUID(),
      retired: randomUUID(),
      legacy: randomUUID(),
      proposed: randomUUID(),
      revivedOld: randomUUID(),
      revived: randomUUID(),
      bFresh: randomUUID(),
      cFresh: randomUUID(),
      stranded: randomUUID(),
      strandedFailed: randomUUID(),
      strandedRunning: randomUUID(),
    };

    // The sweep reads every workspace, so each check keeps only the targets
    // in this block's three workspaces and names them A, B, and C.
    const labels = new Map<string, string>([
      [`${A.orgId}/${A.workspaceId}`, "A"],
      [`${B.orgId}/${B.workspaceId}`, "B"],
      [`${C.orgId}/${C.workspaceId}`, "C"],
    ]);
    const labelOf = (target: DiscoveryTarget) =>
      labels.get(`${target.scope.orgId}/${target.scope.workspaceId}`);
    const ours = (targets: readonly DiscoveryTarget[]): string[] =>
      targets.flatMap((target) => {
        const label = labelOf(target);
        return label === undefined ? [] : [`${label}/${target.server}`];
      });
    const oursWithSource = (targets: readonly OnChangeTarget[]): string[] =>
      targets.flatMap((target) => {
        const label = labelOf(target);
        return label === undefined
          ? []
          : [`${label}/${target.server} ${target.path}@${target.ref}`];
      });

    const serverRow = (
      id: string,
      scope: DiscoveryScope,
      steeringName: string,
      origin: "steering" | "legacy" | "proposed" = "steering",
      deletedAt: Date | null = null,
    ): typeof schema.mcpServers.$inferInsert => ({
      id,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      name: `${steeringName}-${tag}`,
      transportType: "streamable-http",
      endpointUrl: `https://${steeringName}.example.test/mcp`,
      authStrategy: "none",
      healthStatus: "unknown",
      origin,
      steeringName,
      deletedAt,
    });

    const discoveryRow = (
      scope: DiscoveryScope,
      server: string,
      over: Partial<typeof discoveries.$inferInsert> = {},
    ): typeof discoveries.$inferInsert => ({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      server,
      trigger: "schedule",
      status: "succeeded",
      ...over,
    });

    const prOf = (n: number) => ({
      prNumber: n,
      prUrl: `https://github.com/acme/steering/pull/${n}`,
      prBranch: `oxagen/sync/p${n}`,
    });

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .insert(schema.mcpServers)
          .values([
            serverRow(ids.fresh, A, "fresh"),
            serverRow(ids.found, A, "found"),
            serverRow(ids.retired, A, "retired", "steering", T0),
            serverRow(ids.legacy, A, "legacy", "legacy"),
            serverRow(ids.proposed, A, "proposed", "proposed"),
            serverRow(ids.revivedOld, A, "revived", "steering", T0),
            serverRow(ids.revived, A, "revived"),
            serverRow(ids.bFresh, B, "fresh"),
            serverRow(ids.cFresh, C, "fresh"),
            serverRow(ids.stranded, A, "stranded"),
            serverRow(ids.strandedFailed, A, "stranded_failed"),
            serverRow(ids.strandedRunning, A, "stranded_running"),
          ]);
        const daily = { schedule: "daily" };
        await tx.insert(discoveries).values([
          discoveryRow(A, "found", { mcpServerId: ids.found }),
          // undiscovered: runs that finished before the server's
          // mcp.servers row existed, so no snapshot was written.
          discoveryRow(A, "stranded", { finishedAt: shift(BEFORE, -2) }),
          discoveryRow(A, "stranded_failed", {
            status: "failed",
            finishedAt: shift(BEFORE, -5),
          }),
          // undiscovered: a run in flight is left to the stalled sweep.
          discoveryRow(A, "stranded_running", {
            status: "running",
            requestedAt: shift(STALE, 1),
            startedAt: shift(STALE, 1),
          }),
          // dueDaily: due rows.
          discoveryRow(A, "d_old", { ...daily, finishedAt: shift(BEFORE, -2) }),
          discoveryRow(A, "d_older", {
            ...daily,
            status: "failed",
            finishedAt: shift(BEFORE, -5),
          }),
          discoveryRow(A, "d_never", { ...daily, finishedAt: null }),
          discoveryRow(B, "d_other", {
            ...daily,
            finishedAt: shift(BEFORE, -3),
          }),
          discoveryRow(C, "d_far", {
            ...daily,
            status: "failed",
            finishedAt: shift(BEFORE, -4),
          }),
          // dueDaily: rows that are not due.
          discoveryRow(A, "d_recent", {
            ...daily,
            finishedAt: shift(BEFORE, 1),
          }),
          discoveryRow(A, "d_exact", { ...daily, finishedAt: BEFORE }),
          discoveryRow(A, "d_manual", {
            schedule: "manual",
            finishedAt: shift(BEFORE, -6),
          }),
          discoveryRow(A, "d_on_change", {
            schedule: "on-change",
            finishedAt: shift(BEFORE, -6),
          }),
          discoveryRow(A, "d_running", {
            ...daily,
            status: "running",
            finishedAt: shift(BEFORE, -6),
          }),
          discoveryRow(A, "d_queued", {
            ...daily,
            status: "queued",
            finishedAt: shift(BEFORE, -6),
          }),
          // openPullRequests.
          discoveryRow(A, "p_open", {
            ...prOf(11),
            updatedAt: shift(BEFORE, -3),
          }),
          discoveryRow(A, "p_failed", {
            ...prOf(12),
            status: "failed",
            updatedAt: shift(BEFORE, -1),
          }),
          discoveryRow(B, "p_other", {
            ...prOf(13),
            updatedAt: shift(BEFORE, -2),
          }),
          discoveryRow(A, "p_running", { ...prOf(14), status: "running" }),
          discoveryRow(A, "p_queued", { ...prOf(15), status: "queued" }),
          discoveryRow(A, "p_none"),
          // onChangeByRepo.
          discoveryRow(A, "o_spec", {
            schedule: "on-change",
            sourceRepo: REPO,
            sourcePath: "specs/a.yaml",
            sourceRef: "main",
          }),
          discoveryRow(A, "o_no_path", {
            schedule: "on-change",
            sourceRepo: REPO,
            sourcePath: null,
            sourceRef: "main",
          }),
          discoveryRow(A, "o_no_ref", {
            schedule: "on-change",
            sourceRepo: REPO,
            sourcePath: "specs/c.yaml",
            sourceRef: null,
          }),
          discoveryRow(A, "o_daily", {
            ...daily,
            status: "queued",
            sourceRepo: REPO,
            sourcePath: "specs/d.yaml",
            sourceRef: "main",
          }),
          discoveryRow(A, "o_elsewhere", {
            schedule: "on-change",
            sourceRepo: `github.com/acme-${tag}/other`,
            sourcePath: "specs/e.yaml",
            sourceRef: "main",
          }),
          discoveryRow(B, "o_spec", {
            schedule: "on-change",
            sourceRepo: REPO,
            sourcePath: "specs/b.yaml",
            sourceRef: "v2",
          }),
          discoveryRow(C, "o_spec", {
            schedule: "on-change",
            sourceRepo: REPO,
            sourcePath: "specs/c.yaml",
            sourceRef: "main",
          }),
          // stalled: rows that stalled.
          discoveryRow(A, "s_queued", {
            trigger: "push",
            status: "queued",
            requestedAt: shift(STALE, -3),
          }),
          discoveryRow(B, "s_running", {
            trigger: "manual",
            status: "running",
            requestedAt: shift(STALE, -5),
            startedAt: shift(STALE, -2),
          }),
          discoveryRow(C, "s_unstarted", {
            trigger: "list_changed",
            status: "running",
            requestedAt: shift(STALE, -1),
            startedAt: null,
          }),
          // stalled: rows that did not.
          discoveryRow(A, "s_queued_recent", {
            status: "queued",
            requestedAt: shift(STALE, 1),
          }),
          discoveryRow(A, "s_started_recent", {
            status: "running",
            requestedAt: shift(STALE, -6),
            startedAt: shift(STALE, 1),
          }),
          discoveryRow(A, "s_succeeded", {
            requestedAt: shift(STALE, -6),
            startedAt: shift(STALE, -6),
          }),
          discoveryRow(A, "s_failed", {
            status: "failed",
            requestedAt: shift(STALE, -6),
            startedAt: shift(STALE, -6),
          }),
        ]);
      });
    });

    it("steeringServerId finds the live steering row of a folder in each workspace", async () => {
      expect(await store.steeringServerId(A, "fresh")).toBe(ids.fresh);
      expect(await store.steeringServerId(B, "fresh")).toBe(ids.bFresh);
      expect(await store.steeringServerId(C, "fresh")).toBe(ids.cFresh);
      // A retired row shares the name, and the live row wins.
      expect(await store.steeringServerId(A, "revived")).toBe(ids.revived);
    });

    it("steeringServerId returns null for a retired, legacy, proposed, or missing folder", async () => {
      for (const name of ["retired", "legacy", "proposed", "missing"]) {
        expect(await store.steeringServerId(A, name)).toBeNull();
      }
      expect(
        await store.steeringServerId(
          { orgId: otherOrgId, workspaceId: A.workspaceId },
          "fresh",
        ),
      ).toBeNull();
    });

    it("undiscovered lists live steering servers with no discovery row, across workspaces and orgs", async () => {
      expect(ours(await sweep.undiscovered(10_000)).sort()).toEqual([
        "A/fresh",
        "A/revived",
        "A/stranded",
        "A/stranded_failed",
        "B/fresh",
        "C/fresh",
      ]);
      expect(
        (await sweep.undiscovered(10_000)).find(
          (target) => labelOf(target) === "C",
        ),
      ).toEqual({ scope: C, server: "fresh" });

      // A discovery row in A leaves the same folder in B and C listed.
      await store.request(A, "fresh", "schedule", null, T0);
      expect(ours(await sweep.undiscovered(10_000)).sort()).toEqual([
        "A/revived",
        "A/stranded",
        "A/stranded_failed",
        "B/fresh",
        "C/fresh",
      ]);
    });

    it("undiscovered lists servers with no row before stranded rows, and the stranded rows oldest finish first", async () => {
      const listed = ours(await sweep.undiscovered(10_000));
      const stranded = listed.filter((one) => one.startsWith("A/stranded"));

      expect(stranded).toEqual(["A/stranded_failed", "A/stranded"]);
      expect(listed.indexOf("A/stranded_failed")).toBe(
        listed.length - stranded.length,
      );
    });

    it("undiscovered drops a stranded server once a run stamps its mcpServerId", async () => {
      await store.recordSource(
        A,
        "stranded",
        {
          kind: "remote",
          repo: null,
          path: null,
          ref: null,
          schedule: "on-change",
          mcpServerId: ids.stranded,
          registryName: null,
          version: null,
        },
        T0,
      );

      expect(ours(await sweep.undiscovered(10_000))).not.toContain(
        "A/stranded",
      );
      expect(ours(await sweep.undiscovered(10_000))).toContain(
        "A/stranded_failed",
      );
    });

    it("dueDaily lists finished daily servers older than the cutoff, oldest first and never-finished last", async () => {
      expect(ours(await sweep.dueDaily(BEFORE, 10_000))).toEqual([
        "A/d_older",
        "C/d_far",
        "B/d_other",
        "A/d_old",
        "A/d_never",
      ]);
    });

    it("openPullRequests lists finished servers with a steering PR, least recently updated first", async () => {
      expect(ours(await sweep.openPullRequests(10_000))).toEqual([
        "A/p_open",
        "B/p_other",
        "A/p_failed",
      ]);
    });

    it("onChangeByRepo lists on-change servers of that repository with a path and a ref", async () => {
      expect(oursWithSource(await sweep.onChangeByRepo(REPO)).sort()).toEqual([
        "A/o_spec specs/a.yaml@main",
        "B/o_spec specs/b.yaml@v2",
        "C/o_spec specs/c.yaml@main",
      ]);
      const inC = (await sweep.onChangeByRepo(REPO)).find(
        (target) => labelOf(target) === "C",
      );
      expect(inC).toEqual({
        scope: C,
        server: "o_spec",
        path: "specs/c.yaml",
        ref: "main",
      });
      expect(await sweep.onChangeByRepo(`github.com/acme-${tag}/none`)).toEqual(
        [],
      );
    });

    it("stalled lists queued and running rows older than the cutoff, oldest request first", async () => {
      const stalled = await sweep.stalled(STALE, 10_000);
      expect(ours(stalled)).toEqual(["B/s_running", "A/s_queued", "C/s_unstarted"]);
      expect(stalled.find((target) => labelOf(target) === "A")).toEqual({
        scope: A,
        server: "s_queued",
        trigger: "push",
      });
      expect(
        stalled
          .filter((target) => labelOf(target) !== undefined)
          .map((target) => target.trigger),
      ).toEqual(["manual", "push", "list_changed"]);
    });

    it("each capped query returns no more rows than its limit", async () => {
      expect(await sweep.undiscovered(1)).toHaveLength(1);
      expect(await sweep.dueDaily(BEFORE, 1)).toHaveLength(1);
      expect(await sweep.openPullRequests(1)).toHaveLength(1);
      expect(await sweep.stalled(STALE, 1)).toHaveLength(1);
    });
  });

  describe("registryMoved", () => {
    // The block's own workspaces, so its daily rows stay out of the sweep
    // block's exact lists.
    const A = newScope();
    const B = newScope();
    const C = newScope(otherOrgId);
    // Catalog sync wrote every entry at SYNCED. A registry_version discovery
    // that finished at or after it already asked about the entry.
    const SYNCED = new Date("2026-09-28T06:00:00.000Z");
    const registryIds = {
      a: randomUUID(),
      aOff: randomUUID(),
      b: randomUUID(),
      c: randomUUID(),
    };

    const labels = new Map<string, string>([
      [`${A.orgId}/${A.workspaceId}`, "A"],
      [`${B.orgId}/${B.workspaceId}`, "B"],
      [`${C.orgId}/${C.workspaceId}`, "C"],
    ]);
    const ours = (targets: readonly DiscoveryTarget[]): string[] =>
      targets.flatMap((target) => {
        const label = labels.get(
          `${target.scope.orgId}/${target.scope.workspaceId}`,
        );
        return label === undefined ? [] : [`${label}/${target.server}`];
      });

    const registryRow = (
      id: string,
      scope: DiscoveryScope,
      slug: string,
      enabled = true,
    ): typeof schema.mcpRegistries.$inferInsert => ({
      id,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      name: `registry ${slug}`,
      baseUrl: `https://registry-${tag}.example.test/${slug}`,
      enabled,
    });

    const entry = (
      registryId: string,
      name: string,
      version: string,
      over: Partial<typeof schema.mcpCatalogServers.$inferInsert> = {},
    ): typeof schema.mcpCatalogServers.$inferInsert => ({
      registryId,
      name,
      version,
      isLatest: true,
      description: `${name} ${version}`,
      syncedAt: SYNCED,
      ...over,
    });

    /** A finished daily discovery of a registry server. */
    const registryServer = (
      scope: DiscoveryScope,
      server: string,
      registryName: string | null,
      over: Partial<typeof discoveries.$inferInsert> = {},
    ): typeof discoveries.$inferInsert => ({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      server,
      trigger: "schedule",
      status: "succeeded",
      schedule: "daily",
      sourceKind: "registry",
      sourceRegistryName: registryName,
      finishedAt: shift(SYNCED, -12),
      ...over,
    });

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .insert(schema.mcpRegistries)
          .values([
            registryRow(registryIds.a, A, "a"),
            registryRow(registryIds.aOff, A, "a-off", false),
            registryRow(registryIds.b, B, "b"),
            registryRow(registryIds.c, C, "c"),
          ]);
        await tx.insert(schema.mcpCatalogServers).values([
          entry(registryIds.a, "io.acme/moved", "1.1.0"),
          entry(registryIds.a, "io.acme/moved", "1.0.0", { isLatest: false }),
          entry(registryIds.a, "io.acme/same", "1.1.0"),
          entry(registryIds.a, "io.acme/source-only", "2.1.0"),
          // Two entries keep is_latest, and the newest published one decides.
          entry(registryIds.a, "io.acme/stale", "3.0.0", {
            publishedAt: shift(SYNCED, -48),
          }),
          entry(registryIds.a, "io.acme/stale", "3.1.0", {
            publishedAt: shift(SYNCED, -24),
          }),
          // A deleted entry never decides, even when it is the newest.
          entry(registryIds.a, "io.acme/deleted", "4.0.0", {
            publishedAt: shift(SYNCED, -48),
          }),
          entry(registryIds.a, "io.acme/deleted", "4.1.0", {
            status: "deleted",
            publishedAt: shift(SYNCED, -24),
          }),
          entry(registryIds.a, "io.acme/asked", "5.1.0"),
          // An entry without is_latest never decides, even when it is the newest.
          entry(registryIds.a, "io.acme/not-latest", "6.0.0", {
            publishedAt: shift(SYNCED, -48),
          }),
          entry(registryIds.a, "io.acme/not-latest", "6.1.0", {
            isLatest: false,
            publishedAt: shift(SYNCED, -24),
          }),
          entry(registryIds.aOff, "io.acme/disabled", "7.1.0"),
          entry(registryIds.b, "io.acme/elsewhere", "8.1.0"),
          entry(registryIds.c, "io.acme/elsewhere", "8.1.0"),
          entry(registryIds.b, "io.acme/other", "9.1.0"),
          entry(registryIds.c, "io.acme/far", "10.1.0"),
        ]);
        const askedBefore = {
          trigger: "registry_version",
          status: "failed",
          sourceVersion: "5.0.0",
        };
        await tx.insert(discoveries).values([
          // The rows the sweep asks about.
          registryServer(A, "r_moved", "io.acme/moved", {
            sourceVersion: "1.0.0",
            latestVersion: "1.0.0",
            finishedAt: shift(SYNCED, -5),
          }),
          // No catalog read yet, so source_version stands in.
          registryServer(A, "r_source_only", "io.acme/source-only", {
            schedule: "on-change",
            status: "failed",
            sourceVersion: "2.0.0",
            finishedAt: shift(SYNCED, -3),
          }),
          registryServer(A, "r_newest_unseen", "io.acme/stale", {
            latestVersion: "3.0.0",
            finishedAt: shift(SYNCED, -2),
          }),
          // The last ask finished before the entry synced.
          registryServer(A, "r_asked_before", "io.acme/asked", {
            ...askedBefore,
            finishedAt: shift(SYNCED, -1),
          }),
          registryServer(B, "r_other", "io.acme/other", {
            latestVersion: "9.0.0",
            finishedAt: shift(SYNCED, -4),
          }),
          registryServer(C, "r_far", "io.acme/far", {
            latestVersion: "10.0.0",
            finishedAt: shift(SYNCED, -6),
          }),
          // The rows it leaves alone.
          registryServer(A, "r_same", "io.acme/same", {
            latestVersion: "1.1.0",
          }),
          registryServer(A, "r_source_same", "io.acme/source-only", {
            sourceVersion: "2.1.0",
          }),
          // latest_version wins over source_version, so a sync steering PR
          // that waits for review asks nothing more.
          registryServer(A, "r_pr_waiting", "io.acme/moved", {
            sourceVersion: "1.0.0",
            latestVersion: "1.1.0",
          }),
          registryServer(A, "r_manual", "io.acme/moved", {
            schedule: "manual",
            latestVersion: "1.0.0",
          }),
          registryServer(A, "r_queued", "io.acme/moved", {
            status: "queued",
            latestVersion: "1.0.0",
          }),
          registryServer(A, "r_running", "io.acme/moved", {
            status: "running",
            latestVersion: "1.0.0",
          }),
          registryServer(A, "r_remote", "io.acme/moved", {
            sourceKind: "remote",
            latestVersion: "1.0.0",
          }),
          registryServer(A, "r_unnamed", null, { latestVersion: "1.0.0" }),
          registryServer(A, "r_newest_seen", "io.acme/stale", {
            latestVersion: "3.1.0",
          }),
          registryServer(A, "r_deleted", "io.acme/deleted", {
            latestVersion: "4.0.0",
          }),
          registryServer(A, "r_not_latest", "io.acme/not-latest", {
            latestVersion: "6.0.0",
          }),
          registryServer(A, "r_disabled", "io.acme/disabled", {
            latestVersion: "7.0.0",
          }),
          // Listed only by registries in workspace B and in the other org.
          registryServer(A, "r_elsewhere", "io.acme/elsewhere", {
            latestVersion: "8.0.0",
          }),
          // One catalog entry asks once, even when the ask failed.
          registryServer(A, "r_asked", "io.acme/asked", {
            ...askedBefore,
            finishedAt: shift(SYNCED, 1),
          }),
          registryServer(A, "r_asked_exact", "io.acme/asked", {
            ...askedBefore,
            finishedAt: SYNCED,
          }),
        ]);
      });
    });

    it("lists registry servers whose catalog names a version discovery has not seen, oldest finish first", async () => {
      expect(ours(await sweep.registryMoved(10_000))).toEqual([
        "C/r_far",
        "A/r_moved",
        "B/r_other",
        "A/r_source_only",
        "A/r_newest_unseen",
        "A/r_asked_before",
      ]);
    });

    it("returns each server with its own org and workspace", async () => {
      const inC = (await sweep.registryMoved(10_000)).filter(
        (target) =>
          target.scope.orgId === C.orgId &&
          target.scope.workspaceId === C.workspaceId,
      );
      expect(inC).toEqual([{ scope: C, server: "r_far" }]);
    });

    it("returns no more rows than its limit", async () => {
      expect(await sweep.registryMoved(1)).toHaveLength(1);
    });
  });
});
