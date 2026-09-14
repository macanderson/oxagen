import { getScope } from "@oxagen/tenancy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Read } from "@/data/not-backed";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import type { ToolContract } from "@/server/invoke";
import type {
  HostSummary,
  IncidentRow,
  PrincipalFacts,
} from "./mappers/agents";

// Today's Agents view models refuse the nulls the stores hold (see
// mappers/agents.test.ts). Here they are relaxed to the promote proposal, so
// every method runs end to end: this is the shape the page gets once c1
// promotes those fields, and it proves LIVE_READINESS flips with no adapter
// change.
vi.mock("@/data/contracts", async (importOriginal) => {
  const c = await importOriginal<typeof import("@/data/contracts")>();
  const { z } = await import("zod");
  const AgentRow = c.AgentRow.extend({
    name: z.string().nullable(),
    description: z.string().nullable(),
    harness: c.Harness.nullable(),
    harnessVersion: z.string().nullable(),
    operatorId: c.PublicId.nullable(),
    tier: c.EnforcementTier.nullable(),
    nativeTier: c.EnforcementTier.nullable(),
    beltSize: c.Count.nullable(),
    beltMode: z.enum(["full", "searchable"]).nullable(),
    runs30d: c.Count.nullable(),
    spend30d: c.Money.nullable(),
    modelTier: c.ModelTier.nullable(),
  });
  const AgentDetail = AgentRow.extend({
    identity: c.AgentDetail.shape.identity.extend({
      principalId: c.PublicId.nullable(),
      host: z.string().nullable(),
      collectorVersion: z.string().nullable(),
      deviceKey: z.string().nullable(),
      firstFrameAt: c.Instant.nullable(),
    }),
    credential: c.AgentDetail.shape.credential
      .extend({
        lastUsedAt: c.Instant.nullable(),
        activeRunTokens: c.Count.nullable(),
      })
      .nullable(),
    definition: c.AgentDetail.shape.definition,
    budget: c.AgentDetail.shape.budget.nullable(),
    roles: z
      .array(z.object({ role: z.string(), resource: z.string().nullable() }))
      .nullable(),
  });
  const Toolbelt = c.Toolbelt.extend({
    mode: z.enum(["full", "searchable"]).nullable(),
    entries: z.array(
      c.ToolbeltEntry.extend({
        tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(@[0-9][0-9.]*)?$/),
        description: z.string().nullable(),
        pinned: z.boolean().nullable(),
      }),
    ),
    outside: c.Toolbelt.shape.outside.nullable(),
    registryVersions: c.Count.nullable(),
    fullBeltLimit: c.Count.nullable(),
  });
  const Incident = c.Incident.extend({
    kind: z.string().regex(/^[a-z_]+$/),
    title: z.string().nullable(),
    detail: z.string().nullable(),
    resolution: z.string().nullable(),
  });
  return { ...c, AgentRow, AgentDetail, Toolbelt, Incident };
});

const kernel = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(
      readonly capability: string,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    CapabilityError,
    invoke:
      vi.fn<
        (name: string, input: unknown, ctx: Record<string, unknown>) => unknown
      >(),
    getCapability:
      vi.fn<(name: string) => { description: string } | undefined>(),
    getSession: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    registered: [] as string[],
  };
});

vi.mock("@oxagen/oxagen", () => ({
  CapabilityError: kernel.CapabilityError,
  invoke: kernel.invoke,
  getCapability: kernel.getCapability,
}));
vi.mock("@oxagen/handlers/register", () => {
  kernel.registered.push("handlers");
  return {};
});
vi.mock("@oxagen/agent/register", () => {
  kernel.registered.push("agent");
  return {};
});
vi.mock("@/server/session", () => ({ getSession: kernel.getSession }));

// A drizzle transaction stand-in: every builder call chains, awaiting the chain
// pops the next scripted result, and `from` records the table read. Each
// statement (a chain started on `tx`, subqueries and UNION arms included) also
// records the tables it reads (`from`, `innerJoin`) and its `where` arguments,
// so a test can check the tenant predicates each read keeps.
const db = vi.hoisted(() => {
  type Statement = { tables: unknown[]; wheres: unknown[] };
  const queue: unknown[][] = [];
  const tables: unknown[] = [];
  const scopes: unknown[] = [];
  const statements: Statement[] = [];
  const chain = (statement: Statement | null): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === "then")
          return (
            resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown,
          ) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
        return (...args: unknown[]) => {
          let current = statement;
          if (!current) {
            current = { tables: [], wheres: [] };
            statements.push(current);
          }
          if (prop === "from") {
            tables.push(args[0]);
            current.tables.push(args[0]);
          }
          if (prop === "innerJoin") current.tables.push(args[0]);
          if (prop === "where") current.wheres.push(args[0]);
          return chain(current);
        };
      },
    });
  return { queue, tables, scopes, statements, tx: chain(null) };
});

vi.mock("@oxagen/database", async () => {
  const { getScope: scopeNow } = await import("@oxagen/tenancy");
  return {
    schema: await vi.importActual("@oxagen/database/schema"),
    withTenantDb: (fn: (tx: unknown) => unknown) => {
      db.scopes.push(scopeNow());
      return fn(db.tx);
    },
  };
});

import * as schema from "@oxagen/database/schema";
import {
  and,
  Column,
  eq,
  getTableColumns,
  getTableName,
  is,
  Param,
  SQL,
  StringChunk,
  type Table,
} from "drizzle-orm";
import {
  type AgentStores,
  createLiveAgents,
  LIVE_READINESS,
  liveAgentStores,
  liveAgents,
} from "./agents";

const SCOPE = {
  orgId: "34852085-ede6-428d-9e3d-a7aa2eb82a02",
  workspaceId: "f0db905d-48a0-47e2-a6fe-6f19658849ff",
};
const ORG_SCOPE = { orgId: SCOPE.orgId, workspaceId: ORG_ONLY_WORKSPACE_ID };
const KEY = "e2eavg.defaul.e2e-mt6jsb9g";
const HOST_KEY = "e2eavg.defaul.release-manager";
// list_agent_defs returns the public id as agentId.
const AGENT_ID = "agt_gmfc7dehp2p0mrgn1dks9w";

// Real rows from the local stack: list_agent_defs / get_agent_def /
// list_agent_roles output for "Grid Proof Agent", and list_iam_roles grants
// seeded for the Agent Contributor role.
const DEF = {
  agentId: AGENT_ID,
  publicId: "agt_gmfc7dehp2p0mrgn1dks9w",
  slug: "e2e-mt6jsb9g",
  agentKey: KEY,
  name: "Grid Proof Agent",
  description: null,
  avatarUrl: 'avatar:v1:{"emoji":"😀","bg":"#f97316","mode":"mono-light"}',
  summary: null,
  agentType: "custom",
  status: "draft",
  deploymentStatus: "inactive",
  latestVersion: 1,
  managed: false,
  toolRefs: [],
};
const CONFIG = {
  graph: {
    mode: "read",
    budget: { maxHops: 2, maxNodes: 40 },
    retrieval: { strategy: "hybrid" },
    ontologyId: "",
  },
  agentTools: [],
};
const ROLE_ID = "rol_781349a15fcd455e0b2743";
const ASSIGNMENTS = {
  agentId: DEF.publicId,
  total: 1,
  roles: [
    {
      assignmentId: "pra_3pb7whjgdscp26005pstma",
      roleId: ROLE_ID,
      roleName: "Agent Contributor",
      scopeKind: "workspace",
      isSystemDefault: true,
      assignedAt: "2026-08-24T01:18:48.970Z",
      assignedBy: null,
      expiresAt: null,
      workspaceId: SCOPE.workspaceId,
    },
  ],
};
const role = (
  id: string,
  grants: Array<{ capability: string; effect: string }>,
) => ({
  id,
  name: "Agent Contributor",
  description: null,
  scopeKind: "workspace",
  isSystemDefault: true,
  version: "1",
  memberCount: 32,
  grants,
});
const HOST: HostSummary = {
  hostEnrollmentId: "tch_3pb7whjgdscp26005pstmb",
  agentKey: HOST_KEY,
  hostname: "mbell-mbp-16",
  platform: "darwin",
  osUser: "mbell",
  status: "active",
  mode: "enforce",
  harnesses: ["claude-code"],
  claudeVersionAtEnroll: "2.1.4",
  wrapperVersion: "1.6.2",
  managed: false,
  lastSeenAt: null,
  lastIngestAt: null,
  hooksOk: true,
  otelOk: true,
  spoolDepth: 0,
  sessionsCount: 212,
  unobservedSessionsCount: 0,
  incidentsOpen: 1,
  expiresAt: "2027-07-14T09:02:00.000Z",
  revokedAt: null,
  createdAt: "2026-07-14T09:02:00.000Z",
};
const PRINCIPAL: PrincipalFacts = {
  publicId: "prn_cv6302ky39te607290f12d",
  status: "active",
  operatorPublicId: "usr_t8wwe2gvak6m36gayph0pq",
};
const INCIDENT: IncidentRow = {
  publicId: "tin_5k2m9q4r7t1w3y6z8a0c2e",
  kind: "daemon_down",
  severity: 3,
  detectedAt: new Date("2026-09-11T08:40:00.000Z"),
  detectedBy: "control_plane",
  resolvedAt: null,
  resolutionNote: null,
  hostname: "mbell-mbp-16",
  sessionPublicId: null,
  resolvedByPublicId: null,
};

type Tools = Record<string, unknown[]>;

/** Fake stores: each agent tool answers from a queue of scripted reads. */
function fakeStores(tools: Tools, over: Partial<AgentStores> = {}) {
  const calls: Array<{ tool: string; input: unknown }> = [];
  const stores: AgentStores = {
    readTool: <O>(
      _s: unknown,
      contract: ToolContract<unknown, O>,
      input: unknown,
    ) => {
      calls.push({ tool: contract.name, input });
      const next = tools[contract.name]?.shift();
      if (next === undefined) throw new Error(`unscripted ${contract.name}`);
      return Promise.resolve(
        (next as { ok?: boolean }).ok === false
          ? (next as Read<O>)
          : { ok: true as const, value: next as O },
      );
    },
    describeTool: (name) => (name === "list_agent_defs" ? "List agents" : null),
    workspaceSlug: () => Promise.resolve("default"),
    principals: () => Promise.resolve(new Map([[AGENT_ID, PRINCIPAL]])),
    latestTiers: () =>
      Promise.resolve(new Map([[HOST_KEY, "harness" as const]])),
    openIncidents: () => Promise.resolve(new Map([[HOST_KEY, 1]])),
    hostFacts: () =>
      Promise.resolve({
        deviceKeyFingerprint: "ed25519:8c41f02b70",
        apiKey: {
          keyPrefix: "ox_tWtJtsloV",
          createdAt: new Date("2026-08-24T01:34:40.560Z"),
          lastUsedAt: null,
        },
        firstSessionAt: new Date("2026-03-02T14:22:07.000Z"),
      }),
    incidents: () => Promise.resolve([INCIDENT]),
    ...over,
  };
  return { stores, calls };
}

const listing = (extra: Tools = {}): Tools => ({
  list_agent_defs: [{ agents: [DEF] }],
  list_tacho_hosts: [{ hosts: [HOST], nextCursor: null }],
  ...extra,
});

const READY = {
  listAgents: true,
  getAgent: true,
  toolbelt: true,
  incidents: true,
};
const CLOSED = {
  listAgents: false,
  getAgent: false,
  toolbelt: false,
  incidents: false,
};
const DENIED = {
  ok: false,
  reason: "denied",
  permission: "agent.read",
} as const;
const NOT_BACKED_M0 = {
  ok: false,
  reason: "not_backed",
  milestone: "M0",
  gap: "G0",
};

beforeEach(() => {
  db.queue.length = 0;
  db.tables.length = 0;
  db.scopes.length = 0;
  db.statements.length = 0;
});

describe("LIVE_READINESS", () => {
  it("turns every served method live once the view models carry recorded nulls", () => {
    // Except the toolbelt: a string scope cannot show an unread or
    // resource-scoped grant, and null would claim no narrowing.
    expect(LIVE_READINESS).toEqual({ ...READY, toolbelt: false });
  });
});

describe("createLiveAgents: gates", () => {
  it.each(["listAgents", "getAgent", "toolbelt", "incidents"] as const)(
    "%s stays not-backed and reads nothing while its view model cannot carry the stores",
    async (method) => {
      const { stores, calls } = fakeStores({});
      const incidents = vi.spyOn(stores, "incidents");
      const port = createLiveAgents(stores, CLOSED);
      await expect(port[method](SCOPE, KEY)).resolves.toEqual(NOT_BACKED_M0);
      expect(calls).toEqual([]);
      expect(incidents).not.toHaveBeenCalled();
    },
  );

  it.each([
    "listAgents",
    "getAgent",
    "toolbelt",
    "definition",
    "incidents",
  ] as const)(
    "%s refuses an organization scope: agents are workspace principals",
    async (method) => {
      const { stores, calls } = fakeStores({});
      await expect(
        createLiveAgents(stores, READY)[method](ORG_SCOPE, KEY),
      ).resolves.toEqual({
        ok: false,
        reason: "error",
        code: "workspace_scope_required",
        status: 400,
      });
      expect(calls).toEqual([]);
    },
  );

  it("names the gaps behind scores (G11) and mandates (G1)", async () => {
    const port = createLiveAgents(fakeStores({}).stores, READY);
    await expect(port.scores(SCOPE, KEY)).resolves.toMatchObject({
      reason: "not_backed",
      milestone: "spec-decision",
      gap: "G11",
    });
    await expect(port.mandates(SCOPE, KEY)).resolves.toMatchObject({
      milestone: "M2",
      gap: "G1",
    });
    await expect(port.getMandate(SCOPE, "mnd_1")).resolves.toMatchObject({
      milestone: "M2",
      gap: "G1",
    });
  });
});

describe("createLiveAgents.listAgents", () => {
  it("joins definitions and enrollments by key, parsed through AgentRow", async () => {
    const { stores } = fakeStores(listing());
    const res = await createLiveAgents(stores, READY).listAgents(SCOPE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((r) => [r.key, r.status, r.harness, r.tier])).toEqual([
      [KEY, "unenrolled", null, null],
      [HOST_KEY, "active", "claude-code", "harness"],
    ]);
    expect(res.value[0]).toMatchObject({
      name: "Grid Proof Agent",
      operatorId: "usr_t8wwe2gvak6m36gayph0pq",
      workspaceSlug: "default",
      spend30d: null,
      openIncidents: 0,
    });
    expect(res.value[1]).toMatchObject({
      name: null,
      operatorId: null,
      openIncidents: 1,
    });
  });

  it("counts open incidents for every key it lists, whatever the host row says", async () => {
    const openIncidents = vi.fn(() => Promise.resolve(new Map([[KEY, 2]])));
    const { stores } = fakeStores(listing(), { openIncidents });
    const res = await createLiveAgents(stores, READY).listAgents(SCOPE);
    expect(openIncidents).toHaveBeenCalledWith(SCOPE, [KEY, HOST_KEY]);
    expect(res.ok && res.value.map((r) => [r.key, r.openIncidents])).toEqual([
      [KEY, 2],
      [HOST_KEY, 0],
    ]);
  });

  it("merges a definition and its enrollment into one agent", async () => {
    const { stores } = fakeStores(
      listing({
        list_tacho_hosts: [
          { hosts: [{ ...HOST, agentKey: KEY }], nextCursor: null },
        ],
      }),
    );
    const res = await createLiveAgents(stores, READY).listAgents(SCOPE);
    expect(res.ok && res.value).toEqual([
      expect.objectContaining({
        key: KEY,
        name: "Grid Proof Agent",
        status: "active",
      }),
    ]);
  });

  it("follows the host cursor to the last page", async () => {
    const { stores, calls } = fakeStores(
      listing({
        list_tacho_hosts: [
          { hosts: [HOST], nextCursor: "c2" },
          {
            hosts: [{ ...HOST, agentKey: "e2eavg.defaul.second" }],
            nextCursor: null,
          },
        ],
      }),
    );
    const res = await createLiveAgents(stores, READY).listAgents(SCOPE);
    expect(res.ok && res.value).toHaveLength(3);
    expect(
      calls.filter((c) => c.tool === "list_tacho_hosts").map((c) => c.input),
    ).toEqual([{ limit: 200 }, { limit: 200, cursor: "c2" }]);
  });

  it("returns the denial IAM gave on either agent tool", async () => {
    const defsDenied = fakeStores(listing({ list_agent_defs: [DENIED] }));
    await expect(
      createLiveAgents(defsDenied.stores, READY).listAgents(SCOPE),
    ).resolves.toEqual(DENIED);
    const hostsDenied = fakeStores(listing({ list_tacho_hosts: [DENIED] }));
    await expect(
      createLiveAgents(hostsDenied.stores, READY).listAgents(SCOPE),
    ).resolves.toEqual(DENIED);
  });

  it("refuses definitions from before agent keys were backfilled", async () => {
    const { stores } = fakeStores(
      listing({ list_agent_defs: [{ agents: [{ ...DEF, agentKey: null }] }] }),
    );
    await expect(
      createLiveAgents(stores, READY).listAgents(SCOPE),
    ).resolves.toMatchObject({
      code: "agent_key_unbackfilled",
      status: 503,
    });
  });

  it("reports a workspace the tenant cannot see", async () => {
    const { stores } = fakeStores(listing(), {
      workspaceSlug: () => Promise.resolve(null),
    });
    await expect(
      createLiveAgents(stores, READY).listAgents(SCOPE),
    ).resolves.toMatchObject({
      code: "workspace_not_found",
      status: 404,
    });
  });

  it("never hands the page a row its view model rejects", async () => {
    const { stores } = fakeStores(listing(), {
      workspaceSlug: () => Promise.resolve("Not A Slug"),
    });
    await expect(
      createLiveAgents(stores, READY).listAgents(SCOPE),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "contract_output_mismatch",
      status: 502,
    });
  });
});

describe("createLiveAgents.getAgent", () => {
  it("adds identity, credential and roles for a defined, enrolled agent", async () => {
    const { stores } = fakeStores(
      listing({
        list_tacho_hosts: [
          { hosts: [{ ...HOST, agentKey: KEY }], nextCursor: null },
        ],
        list_agent_roles: [ASSIGNMENTS],
      }),
    );
    const res = await createLiveAgents(stores, READY).getAgent(SCOPE, KEY);
    expect(res.ok && res.value).toMatchObject({
      key: KEY,
      identity: {
        principalId: PRINCIPAL.publicId,
        host: "mbell-mbp-16",
        enrolled: true,
      },
      credential: { prefix: "ox_tWtJtsloV", activeRunTokens: null },
      budget: null,
      definition: null,
      roles: [{ role: "Agent Contributor", resource: null }],
    });
  });

  it("reads no host facts for an unenrolled agent and no roles for an enrolled-only one", async () => {
    const hostFacts = vi.fn();
    const { stores, calls } = fakeStores(
      listing({ list_agent_roles: [ASSIGNMENTS] }),
      { hostFacts },
    );
    const port = createLiveAgents(stores, READY);
    const unenrolled = await port.getAgent(SCOPE, KEY);
    expect(unenrolled.ok && unenrolled.value.credential).toBeNull();
    expect(hostFacts).not.toHaveBeenCalled();

    const again = fakeStores(listing());
    const hostOnly = await createLiveAgents(again.stores, READY).getAgent(
      SCOPE,
      HOST_KEY,
    );
    expect(hostOnly.ok && hostOnly.value.roles).toBeNull();
    expect(again.calls.some((c) => c.tool === "list_agent_roles")).toBe(false);
    expect(calls.filter((c) => c.tool === "list_agent_roles")).toHaveLength(1);
  });

  it("is not found for a key in no store, and passes a roles denial through", async () => {
    const { stores } = fakeStores(listing());
    await expect(
      createLiveAgents(stores, READY).getAgent(SCOPE, "a.b.nope"),
    ).resolves.toMatchObject({
      code: "agent_not_found",
      status: 404,
    });
    const denied = fakeStores(listing({ list_agent_roles: [DENIED] }));
    await expect(
      createLiveAgents(denied.stores, READY).getAgent(SCOPE, KEY),
    ).resolves.toEqual(DENIED);
    const listDenied = fakeStores(listing({ list_agent_defs: [DENIED] }));
    await expect(
      createLiveAgents(listDenied.stores, READY).getAgent(SCOPE, KEY),
    ).resolves.toEqual(DENIED);
  });
});

describe("createLiveAgents.toolbelt", () => {
  it("pages list_iam_roles, and refuses a belt whose grant conditions it could not read", async () => {
    const { stores, calls } = fakeStores(
      listing({
        list_agent_roles: [ASSIGNMENTS],
        list_iam_roles: [
          {
            roles: [
              role(ROLE_ID, [
                { capability: "list_agent_defs", effect: "allow" },
              ]),
            ],
            hasMore: true,
          },
          {
            roles: [
              role("rol_other", [
                { capability: "execute_code", effect: "allow" },
              ]),
            ],
            hasMore: false,
          },
        ],
      }),
    );
    const res = await createLiveAgents(stores, READY).toolbelt(SCOPE, KEY);
    // Forced live, the belt still never reaches the page: list_iam_roles
    // returns no conditions, and an unread scope is not an unscoped allow.
    expect(res).toEqual({
      ok: false,
      reason: "error",
      code: "contract_output_mismatch",
      status: 502,
    });
    expect(
      calls.filter((c) => c.tool === "list_iam_roles").map((c) => c.input),
    ).toEqual([
      { includeGrants: true, limit: 200, offset: 0 },
      { includeGrants: true, limit: 200, offset: 200 },
    ]);
  });

  it("stays not-backed for an enrolled-only agent, whose belt is its policy bundle", async () => {
    const { stores } = fakeStores(listing());
    await expect(
      createLiveAgents(stores, READY).toolbelt(SCOPE, HOST_KEY),
    ).resolves.toEqual(NOT_BACKED_M0);
  });

  it("passes not-found and either denial through", async () => {
    const { stores } = fakeStores(listing());
    await expect(
      createLiveAgents(stores, READY).toolbelt(SCOPE, "a.b.nope"),
    ).resolves.toMatchObject({
      code: "agent_not_found",
    });
    const rolesDenied = fakeStores(
      listing({
        list_agent_roles: [DENIED],
        list_iam_roles: [{ roles: [], hasMore: false }],
      }),
    );
    await expect(
      createLiveAgents(rolesDenied.stores, READY).toolbelt(SCOPE, KEY),
    ).resolves.toEqual(DENIED);
    const grantsDenied = fakeStores(
      listing({ list_agent_roles: [ASSIGNMENTS], list_iam_roles: [DENIED] }),
    );
    await expect(
      createLiveAgents(grantsDenied.stores, READY).toolbelt(SCOPE, KEY),
    ).resolves.toEqual(DENIED);
  });
});

describe("createLiveAgents.definition", () => {
  it("serves get_agent_def through the unrelaxed AgentDefinition view model", async () => {
    const { stores, calls } = fakeStores({
      list_agent_defs: [{ agents: [DEF] }],
      get_agent_def: [
        { ...DEF, version: 1, isPublished: false, config: CONFIG },
      ],
    });
    const res = await createLiveAgents(stores, CLOSED).definition(SCOPE, KEY);
    expect(res).toEqual({
      ok: true,
      value: {
        agentKey: KEY,
        path: null,
        digest: null,
        commitSha: null,
        source: JSON.stringify(CONFIG, null, 2),
        branches: null,
      },
    });
    expect(calls.at(-1)).toEqual({
      tool: "get_agent_def",
      input: { agentId: DEF.publicId },
    });
  });

  it("is not found for an unknown key and passes denials through", async () => {
    const missing = fakeStores({ list_agent_defs: [{ agents: [DEF] }] });
    await expect(
      createLiveAgents(missing.stores, READY).definition(SCOPE, "a.b.nope"),
    ).resolves.toMatchObject({
      code: "agent_not_found",
    });
    const listDenied = fakeStores({ list_agent_defs: [DENIED] });
    await expect(
      createLiveAgents(listDenied.stores, READY).definition(SCOPE, KEY),
    ).resolves.toEqual(DENIED);
    const getDenied = fakeStores({
      list_agent_defs: [{ agents: [DEF] }],
      get_agent_def: [DENIED],
    });
    await expect(
      createLiveAgents(getDenied.stores, READY).definition(SCOPE, KEY),
    ).resolves.toEqual(DENIED);
  });
});

describe("createLiveAgents.incidents", () => {
  it("parses collector incidents through Incident", async () => {
    const { stores } = fakeStores(listing());
    const res = await createLiveAgents(stores, READY).incidents(SCOPE, KEY);
    expect(res.ok && res.value).toEqual([
      expect.objectContaining({
        id: INCIDENT.publicId,
        kind: "daemon_down",
        severity: 3,
        status: "open",
      }),
    ]);
  });

  it("rejects a row that breaks the view model instead of passing it on", async () => {
    const { stores } = fakeStores(listing(), {
      incidents: () => Promise.resolve([{ ...INCIDENT, severity: 7 }]),
    });
    await expect(
      createLiveAgents(stores, READY).incidents(SCOPE, KEY),
    ).resolves.toMatchObject({
      code: "contract_output_mismatch",
    });
  });

  it.each(["list_agent_defs", "list_tacho_hosts"])(
    "returns the denial %s gave and never reads the incident stores",
    async (tool) => {
      const { stores } = fakeStores(listing({ [tool]: [DENIED] }));
      const incidents = vi.spyOn(stores, "incidents");
      await expect(
        createLiveAgents(stores, READY).incidents(SCOPE, KEY),
      ).resolves.toEqual(DENIED);
      expect(incidents).not.toHaveBeenCalled();
    },
  );

  it("is not found for a key in no store, and reads no incidents for it", async () => {
    const { stores } = fakeStores(listing());
    const incidents = vi.spyOn(stores, "incidents");
    await expect(
      createLiveAgents(stores, READY).incidents(SCOPE, "e2eavg.defaul.nobody"),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "agent_not_found",
      status: 404,
    });
    expect(incidents).not.toHaveBeenCalled();
  });
});

describe("liveAgentStores.readTool", () => {
  const contract = {
    name: "list_agent_defs",
    input: {
      _input: {},
      safeParse: () => ({ success: true as const, data: {} }),
    },
    output: {
      _output: { agents: [] as unknown[] },
      safeParse: (v: unknown) =>
        Array.isArray((v as { agents?: unknown }).agents)
          ? { success: true as const, data: v as { agents: unknown[] } }
          : { success: false as const, error: { issues: [{}] } },
    },
  };

  beforeEach(() => {
    kernel.getSession.mockResolvedValue({
      user: { id: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("denies without a signed-in person and never reaches the kernel", async () => {
    kernel.getSession.mockResolvedValue(null);
    await expect(
      liveAgentStores.readTool(SCOPE, contract, {}),
    ).resolves.toEqual(DENIED);
    expect(kernel.invoke).not.toHaveBeenCalled();
  });

  it("invokes as the person, inside tenant scope, after both handler registries load", async () => {
    let scopeInside: unknown;
    kernel.invoke.mockImplementation(() => {
      scopeInside = getScope();
      return { agents: [DEF] };
    });
    await expect(
      liveAgentStores.readTool(SCOPE, contract, { status: "draft" }),
    ).resolves.toEqual({
      ok: true,
      value: { agents: [DEF] },
    });
    expect(kernel.registered).toEqual(
      expect.arrayContaining(["handlers", "agent"]),
    );
    const [name, input, ctx] = kernel.invoke.mock.calls[0] ?? [];
    expect([name, input]).toEqual(["list_agent_defs", { status: "draft" }]);
    expect(ctx).toMatchObject({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      userId: "11111111-1111-4111-8111-111111111111",
      apiKeyId: null,
      surface: "app",
      messageId: null,
    });
    expect(scopeInside).toMatchObject(SCOPE);
  });

  it("turns an IAM denial or a pending approval into denied", async () => {
    for (const code of ["authz_denied", "pending_approval"]) {
      kernel.invoke.mockRejectedValueOnce(
        new kernel.CapabilityError("list_agent_defs", code, "no"),
      );
      await expect(
        liveAgentStores.readTool(SCOPE, contract, {}),
      ).resolves.toEqual(DENIED);
    }
  });

  it("rethrows every other failure for the error boundary", async () => {
    kernel.invoke.mockRejectedValueOnce(
      new kernel.CapabilityError("list_agent_defs", "invalid_input", "bad"),
    );
    await expect(liveAgentStores.readTool(SCOPE, contract, {})).rejects.toThrow(
      "bad",
    );
    kernel.invoke.mockRejectedValueOnce(new Error("pg down"));
    await expect(liveAgentStores.readTool(SCOPE, contract, {})).rejects.toThrow(
      "pg down",
    );
  });

  it("refuses output the agent tool's own schema rejects", async () => {
    kernel.invoke.mockResolvedValueOnce({ nope: true });
    await expect(
      liveAgentStores.readTool(SCOPE, contract, {}),
    ).resolves.toMatchObject({
      code: "contract_output_mismatch",
      status: 502,
    });
  });

  it("describes a registered agent tool and nothing else", () => {
    kernel.getCapability.mockImplementation((n) =>
      n === "list_agent_defs" ? { description: "List" } : undefined,
    );
    expect(liveAgentStores.describeTool("list_agent_defs")).toBe("List");
    expect(liveAgentStores.describeTool("gone")).toBeNull();
  });
});

describe("liveAgentStores: tenant-scoped store reads", () => {
  it("reads the workspace slug under the tenant's scope", async () => {
    db.queue.push([{ slug: "default" }]);
    await expect(liveAgentStores.workspaceSlug(SCOPE)).resolves.toBe("default");
    expect(db.tables).toEqual([schema.workspaces]);
    expect(db.scopes[0]).toMatchObject(SCOPE);
    db.queue.push([]);
    await expect(liveAgentStores.workspaceSlug(SCOPE)).resolves.toBeNull();
  });

  it("resolves each agent's principal and operator", async () => {
    db.queue.push(
      [
        { publicId: AGENT_ID, principalId: "p1" },
        { publicId: "a2", principalId: null },
        { publicId: "a3", principalId: "p-missing" },
        { publicId: "a4", principalId: "p4" },
      ],
      [
        {
          id: "p1",
          publicId: PRINCIPAL.publicId,
          status: "active",
          parentUserId: "u1",
        },
        {
          id: "p4",
          publicId: "prn_orphan",
          status: "suspended",
          parentUserId: null,
        },
      ],
      [{ id: "u1", publicId: "usr_t8wwe2gvak6m36gayph0pq" }],
    );
    const facts = await liveAgentStores.principals(SCOPE, [
      AGENT_ID,
      "a2",
      "a3",
      "a4",
    ]);
    expect(Object.fromEntries(facts)).toEqual({
      [AGENT_ID]: PRINCIPAL,
      a4: {
        publicId: "prn_orphan",
        status: "suspended",
        operatorPublicId: null,
      },
    });
    expect(db.tables).toEqual([schema.agents, schema.principals, schema.users]);
  });

  it("skips principal reads it has no ids for", async () => {
    await expect(liveAgentStores.principals(SCOPE, [])).resolves.toEqual(
      new Map(),
    );
    db.queue.push([{ publicId: AGENT_ID, principalId: null }]);
    await expect(
      liveAgentStores.principals(SCOPE, [AGENT_ID]),
    ).resolves.toEqual(new Map());
    db.queue.push(
      [{ publicId: AGENT_ID, principalId: "p1" }],
      [
        {
          id: "p1",
          publicId: PRINCIPAL.publicId,
          status: "active",
          parentUserId: null,
        },
      ],
    );
    await expect(
      liveAgentStores.principals(SCOPE, [AGENT_ID]),
    ).resolves.toEqual(
      new Map([[AGENT_ID, { ...PRINCIPAL, operatorPublicId: null }]]),
    );
    expect(db.tables).toEqual([
      schema.agents,
      schema.agents,
      schema.principals,
    ]);
  });

  it("reads each key's latest recorded tier and drops anything outside the enum", async () => {
    await expect(liveAgentStores.latestTiers(SCOPE, [])).resolves.toEqual(
      new Map(),
    );
    db.queue.push([
      { agentKey: KEY, tier: "gateway" },
      { agentKey: HOST_KEY, tier: "sandbox" },
    ]);
    await expect(
      liveAgentStores.latestTiers(SCOPE, [KEY, HOST_KEY]),
    ).resolves.toEqual(new Map([[KEY, "gateway"]]));
    expect(db.tables).toEqual([schema.tachoSessions]);
  });

  it("counts each key's unresolved incidents by host or run, once per incident", async () => {
    await expect(liveAgentStores.openIncidents(SCOPE, [])).resolves.toEqual(
      new Map(),
    );
    expect(db.tables).toEqual([]);
    // The UNION already drops a (key, incident) pair linked by host and run.
    db.queue.push([
      { agentKey: KEY, id: "i1" },
      { agentKey: KEY, id: "i2" },
      { agentKey: HOST_KEY, id: "i3" },
    ]);
    await expect(
      liveAgentStores.openIncidents(SCOPE, [KEY, HOST_KEY, "e2eavg.defaul.x"]),
    ).resolves.toEqual(
      new Map([
        [KEY, 2],
        [HOST_KEY, 1],
      ]),
    );
    // One statement: incidents by host, UNION incidents by run.
    expect(db.tables).toEqual([schema.tachoIncidents, schema.tachoIncidents]);
    expect(db.scopes).toHaveLength(1);
    expect(db.scopes[0]).toMatchObject(SCOPE);
  });

  it("reads host device, credential prefix and first session", async () => {
    const createdAt = new Date("2026-08-24T01:34:40.560Z");
    const first = new Date("2026-03-02T14:22:07.000Z");
    db.queue.push(
      [{ deviceKeyFingerprint: "ed25519:8c41f02b70", apiKeyId: "k1" }],
      [{ keyPrefix: "ox_tWtJtsloV", createdAt, lastUsedAt: null }],
      [{ at: first }],
    );
    await expect(liveAgentStores.hostFacts(SCOPE, KEY)).resolves.toEqual({
      deviceKeyFingerprint: "ed25519:8c41f02b70",
      apiKey: { keyPrefix: "ox_tWtJtsloV", createdAt, lastUsedAt: null },
      firstSessionAt: first,
    });
    expect(db.tables).toEqual([
      schema.tachoHosts,
      schema.apiKeys,
      schema.tachoSessions,
    ]);
  });

  it("has no host facts for an unenrolled key, and tolerates a missing key or session", async () => {
    db.queue.push([]);
    await expect(liveAgentStores.hostFacts(SCOPE, KEY)).resolves.toBeNull();
    db.queue.push([{ deviceKeyFingerprint: "fp", apiKeyId: "k1" }], [], []);
    await expect(liveAgentStores.hostFacts(SCOPE, KEY)).resolves.toEqual({
      deviceKeyFingerprint: "fp",
      apiKey: null,
      firstSessionAt: null,
    });
  });

  it("reads an agent's incidents by host or run, with host, run and resolver ids", async () => {
    const resolvedAt = new Date("2026-09-11T10:00:00.000Z");
    db.queue.push(
      [
        {
          ...INCIDENT,
          hostId: "h1",
          sessionId: "s1",
          resolvedBy: "p1",
          resolvedAt,
          resolutionNote: "Restored",
        },
        {
          ...INCIDENT,
          publicId: "tin_second",
          hostId: null,
          sessionId: "s-gone",
          resolvedBy: null,
        },
        {
          ...INCIDENT,
          publicId: "tin_third",
          hostId: "h-gone",
          sessionId: null,
          resolvedBy: "p-gone",
        },
      ],
      [{ id: "h1", hostname: "mbell-mbp-16" }],
      [{ id: "s1", publicId: "tse_01k5rn2p8x4c6v9b3n5m7q" }],
      [{ id: "p1", publicId: PRINCIPAL.publicId }],
    );
    const rows = await liveAgentStores.incidents(SCOPE, KEY);
    expect(
      rows.map((r) => [
        r.publicId,
        r.hostname,
        r.sessionPublicId,
        r.resolvedByPublicId,
      ]),
    ).toEqual([
      [
        INCIDENT.publicId,
        "mbell-mbp-16",
        "tse_01k5rn2p8x4c6v9b3n5m7q",
        PRINCIPAL.publicId,
      ],
      ["tin_second", null, null, null],
      ["tin_third", null, null, null],
    ]);
    expect(rows[0]).toMatchObject({ resolvedAt, resolutionNote: "Restored" });
    // The incidents read, its two agent-key subqueries, then one lookup per id kind.
    expect(db.tables).toEqual([
      schema.tachoIncidents,
      schema.tachoHosts,
      schema.tachoSessions,
      schema.tachoHosts,
      schema.tachoSessions,
      schema.principals,
    ]);
  });

  it("stops at the incidents read when there are none, and skips lookups with no ids", async () => {
    db.queue.push([]);
    await expect(liveAgentStores.incidents(SCOPE, KEY)).resolves.toEqual([]);
    db.queue.push([
      { ...INCIDENT, hostId: null, sessionId: null, resolvedBy: null },
    ]);
    await expect(liveAgentStores.incidents(SCOPE, KEY)).resolves.toHaveLength(
      1,
    );
    expect(db.tables.filter((t) => t === schema.principals)).toEqual([]);
  });
});

/** Every `column = value` equality anywhere in a drizzle where clause. */
function equalities(where: unknown): Array<[Column, unknown]> {
  const found: Array<[Column, unknown]> = [];
  const walk = (node: unknown): void => {
    if (!is(node, SQL)) return;
    node.queryChunks.forEach((chunk, i) => {
      const op = node.queryChunks[i + 1];
      const value = node.queryChunks[i + 2];
      if (
        is(chunk, Column) &&
        is(op, StringChunk) &&
        op.value.join("") === " = " &&
        is(value, Param)
      )
        found.push([chunk, value.value]);
      walk(chunk);
    });
  };
  walk(where);
  return found;
}

/**
 * The tenant columns a statement reads without pinning to SCOPE: every table's
 * org_id, and its workspace_id where every row has one.
 */
function unpinned(statement: { tables: unknown[]; wheres: unknown[] }) {
  const pinned = statement.wheres.flatMap(equalities);
  const pins = (column: Column, value: string) =>
    pinned.some(([c, v]) => c === column && v === value);
  return statement.tables.flatMap((table) => {
    const columns: Record<string, Column> = getTableColumns(table as Table);
    const name = getTableName(table as Table);
    const missing: string[] = [];
    const org = columns.orgId;
    const workspace = columns.workspaceId;
    if (org && !pins(org, SCOPE.orgId)) missing.push(`${name}.org_id`);
    if (workspace?.notNull && !pins(workspace, SCOPE.workspaceId))
      missing.push(`${name}.workspace_id`);
    return missing;
  });
}

describe("liveAgentStores: every tenant table keeps its own tenant predicate", () => {
  // RLS passes everything through wherever enforcement is off, and agent keys
  // are caller-supplied: a read keyed only by agent key or row id would show
  // another tenant's hosts, credentials and incidents.
  const incidentRow = {
    ...INCIDENT,
    hostId: "h1",
    sessionId: "s1",
    resolvedBy: "p1",
  };
  it.each([
    {
      read: "workspaceSlug",
      script: [[{ slug: "default" }]],
      run: () => liveAgentStores.workspaceSlug(SCOPE),
      statements: 1,
    },
    {
      read: "principals",
      script: [
        [{ publicId: AGENT_ID, principalId: "p1" }],
        [{ id: "p1", publicId: "prn_1", status: "active", parentUserId: "u1" }],
        [{ id: "u1", publicId: "usr_1" }],
      ],
      run: () => liveAgentStores.principals(SCOPE, [AGENT_ID]),
      statements: 3,
    },
    {
      read: "latestTiers",
      script: [[{ agentKey: KEY, tier: "gateway" }]],
      run: () => liveAgentStores.latestTiers(SCOPE, [KEY]),
      statements: 1,
    },
    {
      read: "openIncidents (both UNION arms and their joins)",
      script: [[{ agentKey: KEY, id: "i1" }]],
      run: () => liveAgentStores.openIncidents(SCOPE, [KEY]),
      statements: 2,
    },
    {
      read: "hostFacts (host, credential, first session)",
      script: [
        [{ deviceKeyFingerprint: "fp", apiKeyId: "k1" }],
        [{ keyPrefix: "ox_1", createdAt: new Date(0), lastUsedAt: null }],
        [{ at: new Date(0) }],
      ],
      run: () => liveAgentStores.hostFacts(SCOPE, KEY),
      statements: 3,
    },
    {
      read: "incidents (both subqueries and every lookup)",
      script: [
        [incidentRow],
        [{ id: "h1", hostname: "host" }],
        [{ id: "s1", publicId: "tse_1" }],
        [{ id: "p1", publicId: "prn_1" }],
      ],
      run: () => liveAgentStores.incidents(SCOPE, KEY),
      statements: 6,
    },
  ])("$read", async ({ script, run, statements }) => {
    db.queue.push(...script);
    await run();
    expect(db.statements).toHaveLength(statements);
    expect(db.statements.map(unpinned)).toEqual(db.statements.map(() => []));
  });

  it("notices a read keyed only by agent key, or pinned to another tenant", () => {
    expect(
      unpinned({
        tables: [schema.tachoHosts],
        wheres: [eq(schema.tachoHosts.agentKey, KEY)],
      }),
    ).toEqual(["hosts.org_id", "hosts.workspace_id"]);
    expect(
      unpinned({
        tables: [schema.tachoIncidents, schema.tachoHosts],
        wheres: [
          and(
            eq(schema.tachoIncidents.orgId, SCOPE.orgId),
            eq(schema.tachoIncidents.workspaceId, SCOPE.workspaceId),
            eq(schema.tachoHosts.orgId, "another-org"),
            eq(schema.tachoHosts.workspaceId, SCOPE.workspaceId),
          ),
        ],
      }),
    ).toEqual(["hosts.org_id"]);
  });
});

describe("liveAgents", () => {
  it("is the port over the real stores", async () => {
    await expect(liveAgents.scores(SCOPE, KEY)).resolves.toMatchObject({
      gap: "G11",
    });
    await expect(liveAgents.listAgents(ORG_SCOPE)).resolves.toMatchObject({
      code: "workspace_scope_required",
    });
  });
});
