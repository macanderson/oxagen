/**
 * planMigration turns a workspace's connected MCP servers into steering repo
 * folders and packs them into steering PRs. These tests run it against
 * hand-built rows, and openBatches against a fake opener.
 */
import { describe, expect, it } from "vitest";
import { parseLock, parseServerToml, parseToolsToml } from "@oxagen/mcp-studio";
import {
  STEERING_PR_FILES_MAX,
  type OpenSteeringPrRequest,
  type SteeringPrOpener,
} from "@oxagen/agent/runtime/steering-pr";
import { SERVER_NAME_PATTERN, TOOL_NAME_MAX } from "@oxagen/oxagen/steering-repo/names";
import {
  batchBody,
  batchFolders,
  openBatches,
  planMigration,
  type MigrationDescriptor,
  type MigrationInput,
  type MigrationPlan,
  type MigrationServer,
  type MigrationTool,
  type PlannedFolder,
} from "./migrate";

let seq = 0;

function server(over: Partial<MigrationServer> = {}): MigrationServer {
  seq += 1;
  return {
    id: `srv-${String(seq).padStart(4, "0")}`,
    name: `Server ${seq}`,
    transportType: "streamable-http",
    endpointUrl: "https://mcp.example.com/mcp",
    authStrategy: "none",
    authKind: null,
    orgListingId: null,
    installActive: null,
    headerNames: null,
    enabled: true,
    origin: "legacy",
    steeringName: null,
    deletedAt: null,
    ...over,
  };
}

const READ = {
  sideEffect: "read",
  egress: "third_party",
  impacts: [],
  measures: {},
  dataClasses: [],
};

function tool(serverId: string, name: string, over: Partial<MigrationTool> = {}): MigrationTool {
  return {
    serverId,
    name,
    description: `The ${name} tool.`,
    enabled: true,
    version: {
      inputSchema: { type: "object", properties: {} },
      riskGrade: "low",
      impacts: null,
      classification: READ,
      classifiedRiskGrade: null,
    },
    ...over,
  };
}

function plan(
  servers: MigrationServer[],
  tools: MigrationTool[] = [],
  descriptors: MigrationDescriptor[] = [],
  existingFolders?: string[],
): MigrationPlan {
  const input: MigrationInput = { servers, tools, descriptors };
  if (existingFolders) input.existingFolders = existingFolders;
  return planMigration(input);
}

function folders(p: MigrationPlan): PlannedFolder[] {
  return p.batches.flatMap((b) => b.folders);
}

function only(p: MigrationPlan): PlannedFolder {
  const all = folders(p);
  expect(all).toHaveLength(1);
  return all[0] as PlannedFolder;
}

function fileOf(f: PlannedFolder, suffix: string): string {
  const file = f.files.find((x) => x.path.endsWith(suffix));
  if (!file) throw new Error(`${f.folder} has no ${suffix}`);
  return file.content;
}

function serverDoc(f: PlannedFolder) {
  const read = parseServerToml(fileOf(f, "/server.toml"));
  if (!read.ok) throw new Error(JSON.stringify(read.issues));
  return read.value;
}

function toolsDoc(f: PlannedFolder) {
  const read = parseToolsToml(fileOf(f, "/tools.toml"));
  if (!read.ok) throw new Error(JSON.stringify(read.issues));
  return read.value.tools ?? {};
}

function lockDoc(f: PlannedFolder) {
  const read = parseLock(fileOf(f, "/tools.lock.json"));
  if (!read.ok) throw new Error(JSON.stringify(read.issues));
  return read.value;
}

describe("batching", () => {
  it("splits more than 299 files into several PRs and never splits a folder", () => {
    const servers = Array.from({ length: 100 }, (_, i) => server({ name: `Server ${i}` }));
    const tools = servers.map((s) => tool(s.id, "search"));
    const p = plan(servers, tools);

    expect(folders(p)).toHaveLength(100);
    expect(p.batches.length).toBeGreaterThanOrEqual(2);
    const seen = new Map<string, number>();
    for (const batch of p.batches) {
      expect(batch.files.length).toBeLessThanOrEqual(STEERING_PR_FILES_MAX);
      expect(batch.total).toBe(p.batches.length);
      for (const f of batch.folders) {
        expect(f.files).toHaveLength(3);
        for (const file of f.files) {
          expect(file.path.startsWith(`tools/servers/${f.folder}/`)).toBe(true);
          const dir = file.path.split("/")[2] as string;
          const prior = seen.get(dir);
          if (prior !== undefined) expect(prior).toBe(batch.index);
          seen.set(dir, batch.index);
        }
      }
    }
    expect(p.batches.map((b) => b.index)).toEqual(p.batches.map((_, i) => i + 1));
  });

  it("packs whole folders up to the file limit", () => {
    const f = (name: string): PlannedFolder => ({
      folder: name,
      serverId: name,
      label: name,
      toolCount: 0,
      unclassified: [],
      files: [1, 2, 3].map((n) => ({ path: `tools/servers/${name}/${n}`, content: "" })),
    });
    const groups = batchFolders([f("c"), f("a"), f("b"), f("d"), f("e")], 7);
    expect(groups.map((g) => g.map((x) => x.folder))).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("gives the batch number and the total in the title and body", () => {
    const servers = Array.from({ length: 100 }, (_, i) => server({ name: `Server ${i}` }));
    const p = plan(servers);
    const last = p.batches[p.batches.length - 1];
    if (!last) throw new Error("no batch");
    expect(batchBody(last, p)).toContain(`Batch ${last.index} of ${last.total}.`);
  });

  it("plans nothing for a workspace with nothing to move", () => {
    const p = plan([server({ enabled: false })]);
    expect(p.batches).toEqual([]);
  });
});

describe("which servers move", () => {
  it("moves remote http and sse rows and lists stdio rows", () => {
    const http = server({ name: "Linear" });
    const sse = server({ name: "Legacy SSE", transportType: "sse" });
    const stdio = server({ name: "Filesystem", transportType: "stdio", endpointUrl: "npx fs" });
    const p = plan([http, sse, stdio]);

    expect(folders(p).map((f) => f.folder).sort()).toEqual(["legacy_sse", "linear"]);
    const sseFolder = folders(p).find((f) => f.folder === "legacy_sse") as PlannedFolder;
    expect(serverDoc(sseFolder).source).toMatchObject({ type: "remote", transport: "sse" });
    const httpFolder = folders(p).find((f) => f.folder === "linear") as PlannedFolder;
    expect(serverDoc(httpFolder).source).toMatchObject({ type: "remote", transport: "http" });

    expect(p.notMoved).toEqual([
      { name: "Filesystem", reason: expect.stringContaining("local process") },
    ]);
    const body = batchBody(p.batches[0] as MigrationPlan["batches"][number], p);
    expect(body).toContain("## Servers not moved");
    expect(body).toContain("- Filesystem: it runs as a local process");
  });

  it("skips disabled, deleted, steering, and inactive plugin rows without listing them", () => {
    const p = plan([
      server({ name: "Off", enabled: false }),
      server({ name: "Off stdio", enabled: false, transportType: "stdio" }),
      server({ name: "Gone", deletedAt: new Date() }),
      server({ name: "Steered", origin: "steering", steeringName: "steered" }),
      server({ name: "Plugin off", orgListingId: "lst-1", installActive: false }),
    ]);
    expect(p.batches).toEqual([]);
    expect(p.notMoved).toEqual([]);
  });

  it("lists a URL with a query string, which could carry a credential", () => {
    const p = plan([server({ name: "Keyed", endpointUrl: "https://mcp.example.com/mcp?key=secret" })]);
    expect(p.batches).toEqual([]);
    expect(p.notMoved[0]?.reason).toContain("query string");
  });

  it("skips a row already in a batch, and re-plans it when its folder never merged", () => {
    const row = server({ name: "Linear", steeringName: "linear" });
    expect(folders(plan([row]))).toEqual([]);
    expect(folders(plan([row], [], [], ["linear"]))).toEqual([]);
    const again = only(plan([row], [], [], []));
    expect(again.folder).toBe("linear");
  });
});

describe("folder names", () => {
  it("makes a valid, unique name from any server name", () => {
    const p = plan([
      server({ id: "a", name: "GitHub Enterprise!!" }),
      server({ id: "b", name: "123 Tools" }),
      server({ id: "c", name: "***" }),
      server({ id: "d", name: "builtin" }),
      server({ id: "e", name: "Linear" }),
      server({ id: "f", name: "Linear" }),
      server({ id: "g", name: "An extremely long server name that runs on" }),
    ]);
    const byId = new Map(folders(p).map((f) => [f.serverId, f.folder]));
    expect(byId.get("a")).toBe("github_enterprise");
    expect(byId.get("b")).toBe("s_123_tools");
    expect(byId.get("c")).toBe("server");
    expect(byId.get("d")).toBe("builtin_2");
    expect(byId.get("e")).toBe("linear");
    expect(byId.get("f")).toBe("linear_2");
    for (const name of byId.values()) expect(name).toMatch(SERVER_NAME_PATTERN);
    expect((byId.get("g") as string).length).toBeLessThanOrEqual(24);
  });

  it("does not reuse a folder another row already names", () => {
    const p = plan([
      server({ name: "Linear", origin: "steering", steeringName: "linear" }),
      server({ id: "new", name: "Linear" }),
    ]);
    expect(only(p).folder).toBe("linear_2");
  });
});

describe("auth", () => {
  it("maps a plugin row with an OAuth install to service OAuth", () => {
    const p = plan([
      server({
        name: "Notion",
        orgListingId: "lst-1",
        installActive: true,
        authKind: "oauth",
        authStrategy: "bearer",
      }),
    ]);
    expect(serverDoc(only(p)).auth).toEqual({
      mode: "service",
      scheme: "oauth",
      credential: "oxagen:credential/notion",
    });
  });

  it("maps a plugin row with no auth to mode none", () => {
    const p = plan([
      server({ name: "Docs", orgListingId: "lst-1", installActive: true, authKind: "none" }),
    ]);
    expect(serverDoc(only(p)).auth).toEqual({ mode: "none" });
  });

  it("maps a standalone bearer row, naming the credential after the folder", () => {
    const p = plan([server({ name: "Acme API", authStrategy: "bearer" })]);
    expect(serverDoc(only(p)).auth).toEqual({
      mode: "service",
      scheme: "bearer",
      credential: "oxagen:credential/acme-api",
    });
  });

  it("maps a header row with one header, and lists the rest", () => {
    const one = server({ name: "One", authStrategy: "header", headerNames: ["X-Api-Key"] });
    const none = server({ name: "Unreadable", authStrategy: "header", headerNames: null });
    const two = server({ name: "Two", authStrategy: "header", headerNames: ["X-A", "X-B"] });
    const p = plan([one, none, two]);

    expect(serverDoc(only(p)).auth).toEqual({
      mode: "service",
      scheme: "header",
      header: "X-Api-Key",
      credential: "oxagen:credential/one",
    });
    const reasons = new Map(p.notMoved.map((s) => [s.name, s.reason]));
    expect(reasons.get("Unreadable")).toContain("could not be read");
    expect(reasons.get("Two")).toContain("2 auth headers");
  });
});

describe("tools", () => {
  it("carries a classified tool's grade and classification", () => {
    const s = server({ name: "Billing" });
    const p = plan(
      [s],
      [
        tool(s.id, "refund", {
          version: {
            inputSchema: { type: "object", properties: { amount: { type: "number" } } },
            riskGrade: "medium",
            impacts: ["moves_money"],
            classification: { ...READ, sideEffect: "irreversible", impacts: ["notifies_customer"] },
            classifiedRiskGrade: "high",
          },
        }),
      ],
    );
    const f = only(p);
    expect(f.unclassified).toEqual([]);
    expect(toolsDoc(f).refund).toEqual({
      risk: "high",
      side_effect: "irreversible",
      egress: "third_party",
      impacts: ["moves_money", "notifies_customer"],
    });
  });

  it("writes an unclassified tool as high risk, write, third party, and flags it", () => {
    const s = server({ name: "Crm" });
    const p = plan(
      [s],
      [
        tool(s.id, "lookup", {
          version: {
            inputSchema: { type: "object" },
            riskGrade: "low",
            impacts: ["reads_pii"],
            classification: null,
            classifiedRiskGrade: null,
          },
        }),
        tool(s.id, "wipe", {
          version: {
            inputSchema: { type: "object" },
            riskGrade: "critical",
            impacts: null,
            classification: { sideEffect: "nonsense" },
            classifiedRiskGrade: null,
          },
        }),
      ],
    );
    const f = only(p);
    const tools = toolsDoc(f);
    expect(tools.lookup).toEqual({
      risk: "high",
      side_effect: "write",
      egress: "third_party",
      impacts: ["reads_pii"],
    });
    expect(tools.wipe).toMatchObject({ risk: "critical", side_effect: "write" });
    expect(f.unclassified.sort()).toEqual(["crm__lookup", "crm__wipe"]);
    const body = batchBody(p.batches[0] as MigrationPlan["batches"][number], p);
    expect(body).toContain("## Tools with no classification");
    expect(body).toContain("`crm__lookup`");
  });

  it("names a renamed key's upstream tool, and keeps keys unique", () => {
    const s = server({ name: "Tracker" });
    const p = plan(
      [s],
      [tool(s.id, "Create-Issue"), tool(s.id, "list_issues"), tool(s.id, "a-b"), tool(s.id, "a_b")],
    );
    const tools = toolsDoc(only(p));
    expect(tools.create_issue?.upstream).toBe("Create-Issue");
    expect(tools.list_issues?.upstream).toBeUndefined();
    expect(Object.keys(tools).filter((k) => k.startsWith("a_b")).sort()).toEqual(["a_b", "a_b_2"]);
  });

  it("fits a long tool name under the full-name limit", () => {
    const s = server({ name: "An extremely long server name" });
    const p = plan([s], [tool(s.id, "x".repeat(90))]);
    const f = only(p);
    const [key] = Object.keys(toolsDoc(f));
    expect(`${f.folder}__${key}`.length).toBeLessThanOrEqual(TOOL_NAME_MAX);
    expect(toolsDoc(f)[key as string]?.upstream).toBe("x".repeat(90));
  });

  it("carries pinned tools with no row, and keeps a disabled row's tool off", () => {
    const s = server({ name: "Search" });
    const descriptors: MigrationDescriptor[] = [
      { serverId: s.id, name: "query", description: "Run a query.", inputSchema: { type: "object" } },
      { serverId: s.id, name: "delete_index", description: null, inputSchema: { type: "object" } },
      { serverId: "other", name: "elsewhere", description: null, inputSchema: { type: "object" } },
    ];
    const p = plan([s], [tool(s.id, "delete_index", { enabled: false })], descriptors);
    const f = only(p);
    expect(Object.keys(toolsDoc(f))).toEqual(["query"]);
    expect(f.unclassified).toEqual(["search__query"]);
  });

  it("locks the pinned snapshot over the version's schema", () => {
    const s = server({ name: "Wiki" });
    const pinned = { type: "object", properties: { q: { type: "string" } } };
    const p = plan(
      [s],
      [tool(s.id, "Find")],
      [{ serverId: s.id, name: "find", description: "Find a page.", inputSchema: pinned }],
    );
    const lock = lockDoc(only(p));
    expect(lock.tools.find?.upstream).toEqual({
      name: "find",
      description: "Find a page.",
      inputSchema: pinned,
    });
    expect(lock.tools.find?.version).toBe(1);
    expect(lock.tools.find?.definition_hash).toMatch(/^sha256:/);
  });

  it("lists a tool whose input schema is not an object schema, and moves the rest", () => {
    const s = server({ name: "Odd" });
    const p = plan(
      [s],
      [
        tool(s.id, "broken", {
          version: {
            inputSchema: { type: "string" },
            riskGrade: "low",
            impacts: null,
            classification: READ,
            classifiedRiskGrade: null,
          },
        }),
        tool(s.id, "fine"),
      ],
    );
    expect(Object.keys(toolsDoc(only(p)))).toEqual(["fine"]);
    expect(p.toolsNotMoved).toEqual([
      { server: "odd", tool: "broken", reason: expect.stringContaining("input schema") },
    ]);
  });

  it("writes files that read back under their own schemas", () => {
    const s = server({ name: "Everything", authStrategy: "bearer" });
    const f = only(plan([s], [tool(s.id, "one"), tool(s.id, "Two")]));
    expect(serverDoc(f).name).toBe("everything");
    expect(Object.keys(toolsDoc(f)).sort()).toEqual(["one", "two"]);
    expect(Object.keys(lockDoc(f).tools).sort()).toEqual(["one", "two"]);
    expect(fileOf(f, "/server.toml").split("\n", 1)[0]).toMatch(/^#:schema /);
  });
});

describe("the PR body", () => {
  it("cuts a very long body and says so", () => {
    const many = Array.from({ length: 1500 }, (_, i) =>
      server({ name: `Local tool ${i} ${"y".repeat(40)}`, transportType: "stdio" }),
    );
    const p = plan([server({ name: "Kept" }), ...many]);
    const body = batchBody(p.batches[0] as MigrationPlan["batches"][number], p);
    expect(body.length).toBeLessThan(61_000);
    expect(body).toContain("The list is cut at");
  });
});

describe("openBatches", () => {
  function fakeOpener(): SteeringPrOpener & { requests: OpenSteeringPrRequest[] } {
    const requests: OpenSteeringPrRequest[] = [];
    return {
      requests,
      hasSteeringRepo: async () => true,
      open: async (request) => {
        requests.push(request);
        return {
          number: 100 + requests.length,
          url: `https://github.com/acme/oxagen-steering/pull/${100 + requests.length}`,
          branch: request.branch,
        };
      },
    };
  }

  const scope = { orgId: "org-1", workspaceId: "ws-1" };
  const now = new Date("2026-09-26T06:30:00.000Z");

  it("opens each batch in order and marks its rows after it opens", async () => {
    const servers = Array.from({ length: 100 }, (_, i) => server({ name: `Server ${i}` }));
    const p = plan(servers);
    const opener = fakeOpener();
    const marked: string[][] = [];
    const opened = await openBatches({
      scope,
      plan: p,
      opener,
      actorUserId: null,
      now,
      markMoved: async (fs) => {
        marked.push(fs.map((f) => f.folder));
      },
    });

    expect(opened.map((o) => o.number)).toEqual(p.batches.map((_, i) => 101 + i));
    expect(marked).toEqual(p.batches.map((b) => b.folders.map((f) => f.folder)));
    const first = opener.requests[0] as OpenSteeringPrRequest;
    expect(first.branch).toBe("tools/migrate-servers-20260926t063000z-1");
    expect(first.title).toBe(
      `Move connected MCP servers into the steering repo (batch 1 of ${p.batches.length})`,
    );
    expect(first.files.length).toBeLessThanOrEqual(STEERING_PR_FILES_MAX);
    expect(first.orgId).toBe("org-1");
  });

  it("names the open PR when its rows cannot be marked", async () => {
    const p = plan([server({ name: "Linear" })]);
    await expect(
      openBatches({
        scope,
        plan: p,
        opener: fakeOpener(),
        actorUserId: null,
        now,
        markMoved: async () => {
          throw new Error("connection reset");
        },
      }),
    ).rejects.toThrow(/Steering PR #101 is open.*connection reset/);
  });
});
