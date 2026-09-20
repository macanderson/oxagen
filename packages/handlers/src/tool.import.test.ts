/**
 * Unit tests for the import_tools handler (#2958). The org is tier-free; the
 * role gate runs for real against a tx double. The registry write is an
 * in-memory `publishTool` stand-in with the real idempotency rule (one
 * version per changed checksum), so a re-import proves `published: false`
 * rather than the shape of a canned reply. The handler registers directly:
 * nothing here can reach a repository, so no branch or default branch is
 * ever written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/agent/runtime/mcp-snapshots", () => ({
  readLatestPinnedDescriptors: vi.fn(async () => []),
}));

import {
  createToolImportHandler,
  importDigestOf,
  type PinnedDescriptor,
  type ToolImportDeps,
} from "./tool.import";
import { registryCapabilityId } from "@oxagen/agent/runtime/tool-registry-facts";
import {
  toolChecksum,
  toolSlugOf,
  type PublishToolArgs,
} from "./lib/tool-registry";
import { makeCTX } from "./test-utils/fixtures";
import { TOOL_NAME_MAX_LENGTH } from "@oxagen/oxagen/contracts/tool.declaration.publish";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const SERVER = "0192d4a8-7c1e-7a00-8000-0000000000aa";
const SERVER_B = "0192d4a8-7c1e-7a00-8000-0000000000ab";

const ctx = () => makeCTX({ orgId: ORG, workspaceId: WS, userId: USER });

/**
 * assertOrgRole resolves the org leg first (a principal lookup, then the
 * assignment read) and the workspace leg only when the org leg found no
 * qualifying role. The stub answers the org role on the first leg of each
 * resolution and the workspace role on the second.
 */
function stubRole(orgRole: string | null, wsRole: string | null = null) {
  let leg: 1 | 2 = 2;
  let legResolved = true;
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) {
      leg = leg === 1 && !legResolved ? 2 : 1;
      return [{ id: "prn_1" }];
    }
    if (table === schema.principalRoleAssignments) {
      const role = leg === 1 ? orgRole : wsRole;
      legResolved = role !== null;
      return role ? [{ roleName: role }] : [];
    }
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

/** An in-memory registry with publishTool's idempotency rule. */
function memoryRegistry(pins: PinnedDescriptor[]) {
  const tools = new Map<
    string,
    {
      publicId: string;
      name: string;
      source: string;
      versions: { publicId: string; checksum: string }[];
      mcpServerId: string | null;
    }
  >();
  const stamps: Array<{ serverId: string; digest: string }> = [];
  let seq = 0;
  const deps: ToolImportDeps = {
    findServer: async ({ publicId }) =>
      publicId === "mcs_github"
        ? { id: SERVER, publicId }
        : publicId === "mcs_linear"
          ? { id: SERVER_B, publicId }
          : null,
    readPins: async () => pins,
    publish: async (args: PublishToolArgs) => {
      const slug = toolSlugOf(args);
      const checksum = toolChecksum({ ...args, slug });
      let tool = tools.get(slug);
      if (!tool) {
        seq += 1;
        tool = {
          publicId: `tol_${seq}`,
          name: args.name,
          source: args.source,
          versions: [],
          mcpServerId: args.mcpServerId,
        };
        tools.set(slug, tool);
      }
      const latest = tool.versions.at(-1);
      if (latest && latest.checksum === checksum) {
        return {
          publicId: tool.publicId,
          versionPublicId: latest.publicId,
          slug,
          version: tool.versions.length,
          checksum,
          published: false,
        };
      }
      seq += 1;
      const version = { publicId: `tlv_${seq}`, checksum };
      tool.versions.push(version);
      return {
        publicId: tool.publicId,
        versionPublicId: version.publicId,
        slug,
        version: tool.versions.length,
        checksum,
        published: true,
      };
    },
    activeChecksums: async ({ serverId }) =>
      [...tools.values()]
        .filter((t) => t.mcpServerId === serverId)
        .map((t) => t.versions.at(-1)!.checksum),
    stampImport: async ({ serverId, digest }) => {
      stamps.push({ serverId, digest });
    },
  };
  return { deps, tools, stamps };
}

const PINS: PinnedDescriptor[] = [
  { name: "search", description: "Search", inputSchema: { type: "object" } },
  {
    name: "create_payment",
    description: null,
    inputSchema: { type: "object", properties: { amount: { type: "number" } } },
  },
];

beforeEach(() => {
  stubRole("Admin");
});

describe("import_tools", () => {
  it("imports every pinned tool as an mcp-sourced version of origin imported, at risk high, and stamps the server", async () => {
    const reg = memoryRegistry(PINS);
    const publish = vi.spyOn(reg.deps, "publish");
    const out = await createToolImportHandler(reg.deps)(
      { serverId: "mcs_github" },
      ctx(),
    );

    expect(out.serverId).toBe("mcs_github");
    expect(
      out.tools.map((t) => [t.name, t.schemaOrigin, t.published, t.version]),
    ).toEqual([
      ["search", "imported", true, 1],
      ["create_payment", "imported", true, 1],
    ]);
    for (const call of publish.mock.calls) {
      expect(call[0]).toMatchObject({
        orgId: ORG,
        workspaceId: WS,
        userId: USER,
        source: "mcp",
        mcpServerId: SERVER,
        schemaOrigin: "imported",
        riskGrade: "high",
        readOnly: false,
      });
    }
    // A pin with no description is described by its name; the manifest is the descriptor verbatim.
    expect(publish.mock.calls[1]![0]).toMatchObject({
      description: "create_payment",
      manifest: {
        name: "create_payment",
        description: null,
        inputSchema: PINS[1]!.inputSchema,
      },
    });
    expect(reg.stamps).toEqual([
      {
        serverId: SERVER,
        digest: importDigestOf(
          [...reg.tools.values()].map((t) => t.versions[0]!.checksum),
        ),
      },
    ]);
  });

  it("a re-import of an unchanged server publishes nothing and reports the same digest", async () => {
    const reg = memoryRegistry(PINS);
    const handler = createToolImportHandler(reg.deps);
    const first = await handler({ serverId: "mcs_github" }, ctx());
    const second = await handler({ serverId: "mcs_github" }, ctx());
    expect(second.tools.every((t) => t.published === false)).toBe(true);
    expect(second.tools.map((t) => t.id)).toEqual(first.tools.map((t) => t.id));
    expect(second.importDigest).toBe(first.importDigest);
  });

  it("imports only the picked tools", async () => {
    const reg = memoryRegistry(PINS);
    const out = await createToolImportHandler(reg.deps)(
      { serverId: "mcs_github", tools: ["search"] },
      ctx(),
    );
    expect(out.tools.map((t) => t.name)).toEqual(["search"]);
    expect(reg.tools.size).toBe(1);
  });

  it("a picked tool the server has no pin for is not_found and nothing is written", async () => {
    const reg = memoryRegistry(PINS);
    await expect(
      createToolImportHandler(reg.deps)(
        { serverId: "mcs_github", tools: ["search", "delete_everything"] },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "tool_not_pinned" });
    expect(reg.tools.size).toBe(0);
    expect(reg.stamps).toEqual([]);
  });

  it("publishes hand-authored declarations against the server with origin declared and the declared risk", async () => {
    const reg = memoryRegistry([]);
    const publish = vi.spyOn(reg.deps, "publish");
    const out = await createToolImportHandler(reg.deps)(
      {
        serverId: "mcs_github",
        declarations: [
          {
            name: "Lookup_Invoice",
            description: "Look up an invoice",
            input_schema: { type: "object" },
            read_only: true,
            risk_grade: "low",
            manifest: { name: "lookup_invoice" },
            // The handler takes the contract's parsed input, where both
            // classification fields carry a default and are therefore always
            // present. A read-only lookup causes no consequence; the measure
            // is what a mandate targeting one invoice reads the id from.
            consequence_tags: [],
            measures: {
              invoice: { path: "invoice_id", type: "text", unit: "invoice_id" },
            },
          },
        ],
      },
      ctx(),
    );
    expect(out.tools[0]).toMatchObject({
      slug: `mcp.${SERVER}.lookup_invoice`,
      schemaOrigin: "declared",
      published: true,
    });
    expect(publish.mock.calls[0]![0]).toMatchObject({
      schemaOrigin: "declared",
      riskGrade: "low",
      readOnly: true,
      source: "mcp",
      mcpServerId: SERVER,
      // The declared classification reaches the version the gate later reads.
      consequenceTags: [],
      measures: {
        invoice: { path: "invoice_id", type: "text", unit: "invoice_id" },
      },
    });
  });

  it("the same tool name on two servers is two tools, each governed under its own id, and the second import leaves the first untouched", async () => {
    const reg = memoryRegistry([PINS[0]!]);
    const handler = createToolImportHandler(reg.deps);
    const fromA = await handler({ serverId: "mcs_github" }, ctx());
    const fromB = await handler({ serverId: "mcs_linear" }, ctx());

    expect(reg.tools.size).toBe(2);
    expect(fromB.tools[0]!.toolId).not.toBe(fromA.tools[0]!.toolId);
    expect([fromA.tools[0]!.slug, fromB.tools[0]!.slug]).toEqual([
      `mcp.${SERVER}.search`,
      `mcp.${SERVER_B}.search`,
    ]);
    const ids = [...reg.tools.entries()].map(([slug, t]) =>
      registryCapabilityId({ ...t, slug }),
    );
    expect(ids).toEqual([`mcp.${SERVER}.search`, `mcp.${SERVER_B}.search`]);
    // A keeps its one version, active as it was; B did not republish it.
    const a = [...reg.tools.values()].find((t) => t.mcpServerId === SERVER)!;
    expect(a.versions.map((v) => v.publicId)).toEqual([fromA.tools[0]!.id]);
    expect(fromB.tools[0]!.version).toBe(1);
  });

  it("refuses a pinned tool whose name cannot be governed, and writes nothing", async () => {
    // A `tools/list` answer is an external party's, and nothing upstream
    // bounds its names. It matters because the imported tool is governed
    // under `mcp.<server uuid>.<name>`, which openAssistantRun pins into the
    // run spec's tool policy — and the spec pins EVERY materialized tool. One
    // over-long name landing in the registry would therefore fail spec
    // admission for every assistant turn in the workspace, naming nothing.
    const long = "z".repeat(TOOL_NAME_MAX_LENGTH + 1);
    const reg = memoryRegistry([
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
      { name: long, description: null, inputSchema: { type: "object" } },
    ]);
    const publish = vi.spyOn(reg.deps, "publish");

    await expect(
      createToolImportHandler(reg.deps)({ serverId: "mcs_github" }, ctx()),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "tool_name_too_long",
    });

    // Refused at the door: not one tool of the import landed, and no stamp
    // claims a registry state that does not exist.
    expect(publish).not.toHaveBeenCalled();
    expect(reg.tools.size).toBe(0);
    expect(reg.stamps).toEqual([]);
  });

  it("imports a name at the limit, which is the longest identity a run spec can carry", async () => {
    // The boundary is admitted, not merely the one past it rejected: a guard
    // that also refuses the longest legal name would be the same outage with
    // a better error message.
    const atLimit = `a${"b".repeat(TOOL_NAME_MAX_LENGTH - 1)}`;
    const reg = memoryRegistry([
      { name: atLimit, description: null, inputSchema: { type: "object" } },
    ]);
    const out = await createToolImportHandler(reg.deps)(
      { serverId: "mcs_github" },
      ctx(),
    );
    expect(out.tools.map((t) => t.name)).toEqual([atLimit]);
  });

  it("an unknown server is not_found", async () => {
    const reg = memoryRegistry(PINS);
    await expect(
      createToolImportHandler(reg.deps)({ serverId: "mcs_missing" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found", reason: "server_not_found" });
  });

  it("a workspace Owner may import; a Member, a Viewer and a Billing role may not", async () => {
    const reg = memoryRegistry(PINS);
    stubRole(null, "Owner");
    await expect(
      createToolImportHandler(reg.deps)({ serverId: "mcs_github" }, ctx()),
    ).resolves.toBeDefined();
    for (const [org, ws] of [
      [null, "Member"],
      [null, "Viewer"],
      ["Billing", null],
    ] as const) {
      stubRole(org, ws);
      const err = await createToolImportHandler(memoryRegistry(PINS).deps)(
        { serverId: "mcs_github" },
        ctx(),
      ).catch((e: unknown) => e);
      expect(isHandlerError(err) && err.code).toBe("forbidden");
    }
  });
});

describe("import_tools when a publish partway through throws", () => {
  /**
   * Each publish commits on its own transaction (publishTool holds the
   * identity row's insert race), so a throw on publish #3 leaves #1 and #2
   * committed. The stamp used to be written only after the whole loop, so
   * `last_import_digest` kept describing a registry state that no longer
   * existed — the digest a later import diffs against. The handler now stamps
   * what actually landed on the way out and rethrows.
   */
  it("stamps the registry as it actually is, then rethrows", async () => {
    const reg = memoryRegistry(PINS);
    const publish = reg.deps.publish;
    let calls = 0;
    reg.deps.publish = async (args: PublishToolArgs) => {
      calls += 1;
      if (calls === 2) throw new Error("server closed the connection");
      return publish(args);
    };

    await expect(
      createToolImportHandler(reg.deps)({ serverId: "mcs_github" }, ctx()),
    ).rejects.toThrow("server closed the connection");

    // One tool landed, and the stamp names exactly that.
    expect(reg.tools.size).toBe(1);
    expect(reg.stamps).toHaveLength(1);
    expect(reg.stamps[0]).toEqual({
      serverId: SERVER,
      digest: importDigestOf(
        await reg.deps.activeChecksums({
          orgId: ORG,
          workspaceId: WS,
          serverId: SERVER,
        }),
      ),
    });
  });

  it("attributes every import publish to the shared invalidation writer", async () => {
    const reg = memoryRegistry(PINS);
    stubRole("Owner", null);
    const publish = vi.spyOn(reg.deps, "publish");
    await createToolImportHandler(reg.deps)({ serverId: "mcs_github" }, ctx());
    expect(publish).toHaveBeenCalled();
    for (const [args] of publish.mock.calls)
      expect(args.capability).toBe("import_tools");
  });

  it("writes no stamp when the first publish throws", async () => {
    const reg = memoryRegistry(PINS);
    reg.deps.publish = async () => {
      throw new Error("server closed the connection");
    };

    await expect(
      createToolImportHandler(reg.deps)({ serverId: "mcs_github" }, ctx()),
    ).rejects.toThrow("server closed the connection");
    // Nothing landed, so nothing is claimed to have been imported.
    expect(reg.stamps).toEqual([]);
  });

  it("surfaces the publish failure even when the stamp itself fails", async () => {
    const reg = memoryRegistry(PINS);
    const publish = reg.deps.publish;
    let calls = 0;
    reg.deps.publish = async (args: PublishToolArgs) => {
      calls += 1;
      if (calls === 2) throw new Error("server closed the connection");
      return publish(args);
    };
    reg.deps.stampImport = async () => {
      throw new Error("stamp write failed");
    };

    await expect(
      createToolImportHandler(reg.deps)({ serverId: "mcs_github" }, ctx()),
    ).rejects.toThrow("server closed the connection");
  });
});

describe("toolSlugOf", () => {
  it("identifies a server's tool under its server and a declared tool by its lowercased name", () => {
    expect(
      toolSlugOf({ name: " Search ", source: "mcp", mcpServerId: SERVER }),
    ).toBe(`mcp.${SERVER}.search`);
    expect(
      toolSlugOf({ name: "Read_File", source: "custom", mcpServerId: null }),
    ).toBe("read_file");
  });
});

describe("importDigestOf", () => {
  it("is order-independent over the same checksums", () => {
    expect(importDigestOf(["b", "a"])).toBe(importDigestOf(["a", "b"]));
    expect(importDigestOf(["a"])).not.toBe(importDigestOf(["a", "b"]));
  });
});
