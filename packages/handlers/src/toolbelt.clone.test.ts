// The toolbelt capabilities and set_tool_state (ADR-198, #4369): the All
// tools belt, cloning it, editing the clone by server and by tool, deleting a
// belt, and the owner's availability and default switches.
//
// The role gates are proven with a tx double, the way agent.identity.test.ts
// proves its own. The belt itself is proven against a real Postgres; that
// block runs where DATABASE_URL is set (CI's `test` job):
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/toolbelt.clone.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  gate: {
    enabled: false,
    principalId: null as string | null,
    roleName: null as string | null,
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const gateTx = () => ({
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === real.schema.principals
            ? mocks.gate.principalId
              ? [{ id: mocks.gate.principalId }]
              : []
            : table === real.schema.principalRoleAssignments
              ? mocks.gate.roleName
                ? [{ roleName: mocks.gate.roleName }]
                : []
              : [];
        const chain = {
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          // The tool and server reads end at orderBy; the belt reads at limit.
          orderBy: async () => rows,
          limit: async () => rows,
        };
        return chain;
      },
    }),
    insert: () => {
      throw new Error("a write reached the store");
    },
    update: () => {
      throw new Error("a write reached the store");
    },
  });
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      mocks.gate.enabled ? fn(gateTx()) : real.withTenantDb(fn as never),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { toolbeltCloneHandler } from "./toolbelt.clone";
import { toolbeltDeleteHandler } from "./toolbelt.delete";
import { toolbeltGetHandler } from "./toolbelt.get";
import { toolbeltListHandler } from "./toolbelt.list";
import { toolbeltUpdateHandler } from "./toolbelt.update";
import { toolStateSetHandler } from "./tool.state.set";
import { toolbeltGet } from "@oxagen/oxagen/contracts/toolbelt.get";
import { toolbeltList } from "@oxagen/oxagen/contracts/toolbelt.list";
import { toolbeltUpdate } from "@oxagen/oxagen/contracts/toolbelt.update";
import { toolStateSet } from "@oxagen/oxagen/contracts/tool.state.set";
import { makeCTX } from "./test-utils/fixtures";

const BELT_ID = "tbt_0123456789abcdefghjkmn";

const refused =
  (code: string, reason: string) =>
  (err: unknown): boolean =>
    isHandlerError(err) && err.code === code && err.reason === reason;

const WRITES = [
  [
    "clone_toolbelt",
    (ctx: CapabilityContext) =>
      toolbeltCloneHandler({ toolbeltId: BELT_ID, name: "Read only" }, ctx),
  ],
  [
    "update_toolbelt",
    (ctx: CapabilityContext) =>
      toolbeltUpdateHandler(
        toolbeltUpdate.input.parse({ toolbeltId: BELT_ID, name: "Renamed" }),
        ctx,
      ),
  ],
  [
    "delete_toolbelt",
    (ctx: CapabilityContext) =>
      toolbeltDeleteHandler({ toolbeltId: BELT_ID }, ctx),
  ],
  [
    "set_tool_state",
    (ctx: CapabilityContext) =>
      toolStateSetHandler(
        toolStateSet.input.parse({ serverId: null, available: false }),
        ctx,
      ),
  ],
] as const;

describe("toolbelt writes: the role gate", () => {
  beforeEach(() => {
    mocks.gate.enabled = true;
    mocks.gate.principalId = "prn_row";
    mocks.gate.roleName = null;
  });

  for (const role of ["Member", "Viewer", "Billing"]) {
    it.each(WRITES)(`%s refuses an org ${role}`, async (_name, call) => {
      mocks.gate.roleName = role;
      await expect(call(makeCTX())).rejects.toSatisfy(
        refused("forbidden", "org_role_required"),
      );
    });
  }

  it.each(WRITES)("%s lets an org Admin past the gate", async (name, call) => {
    mocks.gate.roleName = "Admin";
    // Past the gate each write reads first. The double holds no belt, so a
    // belt write is not_found; set_tool_state finds no tool to change.
    const outcome = await call(makeCTX()).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (name === "set_tool_state") {
      expect(outcome).toEqual({ value: { updated: 0 } });
    } else {
      expect("error" in outcome && outcome.error).toSatisfy(
        refused("not_found", "toolbelt_not_found"),
      );
    }
  });

  it("clone_toolbelt refuses the All tools belt's slug", async () => {
    mocks.gate.roleName = "Owner";
    await expect(
      toolbeltCloneHandler(
        { toolbeltId: BELT_ID, name: "All tools" },
        makeCTX(),
      ),
    ).rejects.toSatisfy(refused("conflict", "toolbelt_slug_taken"));
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "toolbelts against Postgres",
  async () => {
    const { withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { inArray } = await import("drizzle-orm");
    const support = await import(
      "@oxagen/agent/handlers/_agent-identity.test-support"
    );
    const { agentToolbeltAssignHandler } = await import(
      "./agent.toolbelt.assign"
    );

    let tenant: import("@oxagen/agent/handlers/_agent-identity.test-support").SeededTenant;
    const orgIds: string[] = [];
    const userIds: string[] = [];
    let github = "";
    let db = "";
    const tools = new Map<string, string>();
    const inScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope(
        { orgId: tenant.orgId, workspaceId: tenant.workspaceId },
        fn,
      );
    const ctx = () => support.ctxFor(tenant, tenant.userId);

    beforeAll(async () => {
      mocks.gate.enabled = false;
      tenant = await support.seedTenant("free");
      orgIds.push(tenant.orgId);
      userIds.push(tenant.userId);
      await support.seedMember(tenant, "Owner");
      // Two servers and one declared tool. github's delete_repo starts off.
      await withSystemDb(async (tx) => {
        const servers = await tx
          .insert(schema.mcpServers)
          .values(
            (["github", "db"] as const).map((name) => ({
              orgId: tenant.orgId,
              workspaceId: tenant.workspaceId,
              name,
              transportType: "streamable-http",
              endpointUrl: `https://${name}.mcp.example.com`,
              authStrategy: "none",
              healthStatus: "healthy",
            })),
          )
          .returning({
            id: schema.mcpServers.id,
            publicId: schema.mcpServers.publicId,
            name: schema.mcpServers.name,
          });
        const byName = new Map(servers.map((s) => [s.name, s]));
        github = byName.get("github")!.publicId;
        db = byName.get("db")!.publicId;
        const rows = await tx
          .insert(schema.tools)
          .values(
            [
              {
                name: "create_issue",
                slug: "github-create-issue",
                source: "mcp",
                mcpServerId: byName.get("github")!.id,
              },
              {
                name: "delete_repo",
                slug: "github-delete-repo",
                source: "mcp",
                mcpServerId: byName.get("github")!.id,
                defaultActive: false,
              },
              {
                name: "query",
                slug: "db-query",
                source: "mcp",
                mcpServerId: byName.get("db")!.id,
              },
              { name: "summarize", slug: "summarize", source: "custom" },
            ].map((row) => ({
              ...row,
              orgId: tenant.orgId,
              workspaceId: tenant.workspaceId,
            })),
          )
          .returning({
            publicId: schema.tools.publicId,
            name: schema.tools.name,
          });
        for (const row of rows) tools.set(row.name, row.publicId);
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.tools)
          .where(inArray(schema.tools.orgId, orgIds));
        await tx
          .delete(schema.mcpServers)
          .where(inArray(schema.mcpServers.orgId, orgIds));
      });
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    let allToolsId = "";
    let cloneId = "";

    it("list_toolbelts creates the All tools belt on first touch and counts what it holds", async () => {
      const out = toolbeltList.output.parse(
        await inScope(() => toolbeltListHandler({}, ctx())),
      );
      expect(out.availableTools).toBe(4);
      expect(out.items).toHaveLength(1);
      expect(out.items[0]).toMatchObject({
        name: "All tools",
        slug: "all-tools",
        kind: "all_tools",
        clonedFrom: null,
        tools: 4,
        activeTools: 3,
        servers: 3,
        agents: 0,
      });
      allToolsId = out.items[0]!.id;
      // A second read finds the same belt rather than making another.
      const again = await inScope(() => toolbeltListHandler({}, ctx()));
      expect(again.items.map((i) => i.id)).toEqual([allToolsId]);
    });

    it("get_toolbelt groups the tools by server, declared tools first", async () => {
      const out = toolbeltGet.output.parse(
        await inScope(() =>
          toolbeltGetHandler({ toolbeltId: allToolsId }, ctx()),
        ),
      );
      expect(out.groups.map((g) => [g.server.name, g.included])).toEqual([
        ["Declared tools", true],
        ["db", true],
        ["github", true],
      ]);
      const githubGroup = out.groups.find((g) => g.server.id === github)!;
      expect(
        githubGroup.tools.map((t) => [t.name, t.member, t.active]),
      ).toEqual([
        ["create_issue", true, true],
        ["delete_repo", true, false],
      ]);
    });

    it("clone_toolbelt copies every available tool as the All tools belt shows it", async () => {
      const out = await inScope(() =>
        toolbeltCloneHandler(
          { toolbeltId: allToolsId, name: "Mac's reviewers" },
          ctx(),
        ),
      );
      expect(out.toolbelt).toMatchObject({
        name: "Mac's reviewers",
        slug: "macs-reviewers",
        kind: "custom",
      });
      cloneId = out.toolbelt.id;
      await expect(
        inScope(() =>
          toolbeltCloneHandler(
            { toolbeltId: allToolsId, name: "Macs reviewers" },
            ctx(),
          ),
        ),
      ).rejects.toSatisfy(refused("conflict", "toolbelt_slug_taken"));
      const list = await inScope(() => toolbeltListHandler({}, ctx()));
      expect(list.items.find((i) => i.id === cloneId)).toMatchObject({
        clonedFrom: { id: allToolsId },
        tools: 4,
        activeTools: 3,
      });
    });

    it("update_toolbelt removes a server, turns one on, and turns on a tool that starts off", async () => {
      await inScope(() =>
        toolbeltUpdateHandler(
          toolbeltUpdate.input.parse({
            toolbeltId: cloneId,
            changes: [
              { op: "remove_server", serverId: db },
              {
                op: "set_tool_active",
                toolId: tools.get("delete_repo")!,
                active: true,
              },
              { op: "set_server_active", serverId: null, active: false },
            ],
          }),
          ctx(),
        ),
      );
      const out = await inScope(() =>
        toolbeltGetHandler({ toolbeltId: cloneId }, ctx()),
      );
      const state = new Map(
        out.groups.flatMap((g) =>
          g.tools.map((t) => [t.name, [g.included, t.member, t.active]]),
        ),
      );
      expect(state.get("query")).toEqual([false, false, false]);
      expect(state.get("delete_repo")).toEqual([true, true, true]);
      expect(state.get("create_issue")).toEqual([true, true, true]);
      expect(state.get("summarize")).toEqual([true, true, false]);

      // Adding the server back brings its available tools in, active.
      await inScope(() =>
        toolbeltUpdateHandler(
          toolbeltUpdate.input.parse({
            toolbeltId: cloneId,
            changes: [{ op: "add_server", serverId: db }],
          }),
          ctx(),
        ),
      );
      const back = await inScope(() =>
        toolbeltGetHandler({ toolbeltId: cloneId }, ctx()),
      );
      expect(
        back.groups.find((g) => g.server.id === db)?.tools[0],
      ).toMatchObject({ name: "query", member: true, active: true });
    });

    it("update_toolbelt refuses the All tools belt", async () => {
      await expect(
        inScope(() =>
          toolbeltUpdateHandler(
            toolbeltUpdate.input.parse({ toolbeltId: allToolsId, name: "x" }),
            ctx(),
          ),
        ),
      ).rejects.toSatisfy(refused("conflict", "all_tools_is_derived"));
    });

    it("set_tool_state takes a tool out of every belt, and the clone keeps its row for when it returns", async () => {
      const off = await inScope(() =>
        toolStateSetHandler(
          toolStateSet.input.parse({
            toolIds: [tools.get("create_issue")!],
            available: false,
          }),
          ctx(),
        ),
      );
      expect(off).toEqual({ updated: 1 });
      const clone = await inScope(() =>
        toolbeltGetHandler({ toolbeltId: cloneId }, ctx()),
      );
      const issue = clone.groups
        .flatMap((g) => g.tools)
        .find((t) => t.name === "create_issue");
      expect(issue).toMatchObject({
        available: false,
        member: true,
        active: false,
      });
      await expect(
        inScope(() =>
          toolbeltUpdateHandler(
            toolbeltUpdate.input.parse({
              toolbeltId: cloneId,
              changes: [
                {
                  op: "set_tool_active",
                  toolId: tools.get("create_issue")!,
                  active: true,
                },
              ],
            }),
            ctx(),
          ),
        ),
      ).rejects.toSatisfy(refused("conflict", "tool_unavailable"));

      // Back on, it is active in the clone again as the clone left it.
      await inScope(() =>
        toolStateSetHandler(
          toolStateSet.input.parse({ serverId: github, available: true }),
          ctx(),
        ),
      );
      const restored = await inScope(() =>
        toolbeltGetHandler({ toolbeltId: cloneId }, ctx()),
      );
      expect(
        restored.groups
          .flatMap((g) => g.tools)
          .find((t) => t.name === "create_issue"),
      ).toMatchObject({ available: true, active: true });
      // A repeat that changes nothing writes nothing.
      const same = await inScope(() =>
        toolStateSetHandler(
          toolStateSet.input.parse({ serverId: github, available: true }),
          ctx(),
        ),
      );
      expect(same).toEqual({ updated: 0 });
    });

    it("delete_toolbelt refuses a belt a live agent carries, then deletes it once the agent moves on", async () => {
      const agent = await support.seedAgent(tenant, {
        slug: "reviewer",
        status: "active",
      });
      await inScope(() =>
        agentToolbeltAssignHandler(
          { agentId: agent.publicId, toolbeltId: cloneId },
          ctx(),
        ),
      );
      await expect(
        inScope(() => toolbeltDeleteHandler({ toolbeltId: cloneId }, ctx())),
      ).rejects.toSatisfy(refused("conflict", "toolbelt_in_use"));
      await expect(
        inScope(() => toolbeltDeleteHandler({ toolbeltId: allToolsId }, ctx())),
      ).rejects.toSatisfy(refused("conflict", "all_tools_is_derived"));

      await inScope(() =>
        agentToolbeltAssignHandler(
          { agentId: agent.publicId, toolbeltId: allToolsId },
          ctx(),
        ),
      );
      await expect(
        inScope(() => toolbeltDeleteHandler({ toolbeltId: cloneId }, ctx())),
      ).resolves.toEqual({ toolbeltId: cloneId, deleted: true });
      const list = await inScope(() => toolbeltListHandler({}, ctx()));
      expect(list.items.map((i) => i.id)).toEqual([allToolsId]);
      expect(list.items[0]!.agents).toBe(1);
    });
  },
);
