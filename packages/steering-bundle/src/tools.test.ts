import { describe, expect, it } from "vitest";
import {
  compile,
  formatJson,
  importGrpc,
  lock as lockServer,
  NotBuiltError,
  parseLock,
  parseServerToml,
  parseToolsToml,
  type ImportedFile,
  type ImportResult,
  type ManifestServer,
  type McpToolsLock,
} from "@oxagen/mcp-studio";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  buildTools,
  compileServerFolder,
  grpcDescriptorSet,
  lockedSecuritySchemes,
  lockedUpstreamTools,
  ProtoFilesError,
  ServerFileError,
  serverNames,
  type ServerFolder,
  type ToolCompiler,
} from "./tools";
import { TreeReader, treeFromFiles } from "./tree";

// ── Fixture server folders ───────────────────────────────────────────────────

const files = fixtureRepo();

function file(path: string): string {
  const text = files.get(path);
  if (text === undefined) throw new Error(`${path} is not in the fixture repo`);
  return text;
}

function folder(name: string): ServerFolder {
  return {
    name,
    server: file(`tools/servers/${name}/server.toml`),
    tools: file(`tools/servers/${name}/tools.toml`),
    lock: file(`tools/servers/${name}/tools.lock.json`),
    proto: [],
  };
}

function lock(name: string): McpToolsLock {
  const read = parseLock(file(`tools/servers/${name}/tools.lock.json`));
  if (!read.ok) {
    throw new Error(`${name}'s lock does not parse: ${read.issues.map((issue) => issue.message).join("; ")}`);
  }
  return read.value;
}

async function reader(tree: ReadonlyMap<string, string>): Promise<TreeReader> {
  return TreeReader.open(treeFromFiles(tree));
}

function without(...paths: string[]): Map<string, string> {
  const copy = new Map(files);
  for (const path of paths) copy.delete(path);
  return copy;
}

async function serverFileError(run: () => Promise<unknown>): Promise<ServerFileError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ServerFileError);
    return error as ServerFileError;
  }
  throw new Error("expected a ServerFileError");
}

const BILLING_TOOLS = [
  "billing__list_charges",
  "billing__get_charge",
  "billing__create_refund",
  "billing__get_refund",
  "billing__list_refunds",
  "billing__cancel_refund",
];
const STRIPE_TOOLS = ["stripe__list_charges", "stripe__create_refund"];

// ── Locks ────────────────────────────────────────────────────────────────────

describe("lockedUpstreamTools", () => {
  it("returns a definition's tools as the lock wrote them", () => {
    const billing = lock("billing");
    const upstream = lockedUpstreamTools(billing);
    expect(upstream.map((tool) => tool.name)).toEqual([
      "cancel_refund",
      "create_refund",
      "get_charge",
      "get_refund",
      "list_charges",
      "list_refunds",
    ]);
    const written = Object.values(billing.tools).map((entry) => entry.upstream);
    upstream.forEach((tool, index) => expect(tool).toBe(written[index]));
  });

  it("turns an MCP server's tools into calls to the same tool", () => {
    const upstream = lockedUpstreamTools(lock("stripe"));
    expect(upstream.map((tool) => [tool.name, tool.request])).toEqual([
      ["create_refund", { kind: "mcp", tool: "create_refund" }],
      ["list_charges", { kind: "mcp", tool: "list_charges" }],
    ]);
  });
});

describe("lockedSecuritySchemes", () => {
  it("returns the schemes an OpenAPI lock recorded", () => {
    expect(Object.keys(lockedSecuritySchemes(lock("billing")))).toEqual(["oauth"]);
  });

  it("returns none for an MCP server", () => {
    expect(lockedSecuritySchemes(lock("stripe"))).toEqual({});
  });
});

// ── One folder ───────────────────────────────────────────────────────────────

/** The tool keys a folder's tools.toml imports, in order. */
function toolKeys(name: string): string[] {
  const read = parseToolsToml(file(`tools/servers/${name}/tools.toml`));
  if (!read.ok) throw new Error(`${name}'s tools.toml does not parse`);
  return Object.keys(read.value.tools ?? {}).sort();
}

/** Each tool's three pins, by tool key. */
function pinsOf(
  tools: Record<string, { definition_hash: string; version: number; upstream_hash: string }>,
): Record<string, { definition_hash: string; version: number; upstream_hash: string }> {
  return Object.fromEntries(
    Object.entries(tools).map(([key, { definition_hash, version, upstream_hash }]) => [
      key,
      { definition_hash, version, upstream_hash },
    ]),
  );
}

const BILLING_TOOLS_TOML = "tools/servers/billing/tools.toml";

/** Billing's tools.toml with a new description for get_charge, which billing's lock does not pin. */
function billingToolsWithNewDescription(): string {
  const before = 'description = "Read one charge by its id. Amounts are in cents."';
  const text = file(BILLING_TOOLS_TOML);
  if (!text.includes(before)) {
    throw new Error(`${BILLING_TOOLS_TOML} no longer describes get_charge as this test expects`);
  }
  return text.replace(before, 'description = "Read one charge."');
}

const STALE_LOCK = "The lock's definition_hash for get_charge is not the compiled one. Run lock again.";

describe("compileServerFolder", () => {
  it.each(["billing", "stripe"])("compiles the %s folder and pins each tool to its lock", async (name) => {
    const compiled = await compileServerFolder(folder(name));
    const locked = lock(name);

    expect(compiled.name).toBe(name);
    expect(compiled.pinned).toEqual(locked.source);
    expect(Object.keys(compiled.tools).sort()).toEqual(toolKeys(name));
    expect(pinsOf(compiled.tools)).toEqual(pinsOf(locked.tools));
    // Only a gRPC server carries a descriptor set.
    expect(compiled.descriptor_set).toBeUndefined();
  });

  it("refuses a lock that no longer pins what compiles", async () => {
    await expect(
      compileServerFolder({ ...folder("billing"), tools: billingToolsWithNewDescription() }),
    ).rejects.toThrow(STALE_LOCK);
  });

  it("names server.toml when it does not parse", async () => {
    const error = await serverFileError(() =>
      compileServerFolder({ ...folder("billing"), server: 'schema = "mcp-server/v1"\nname = 7\n' }),
    );
    expect(error.path).toBe("tools/servers/billing/server.toml");
    expect(error.name).toBe("ServerFileError");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.message).toBe(
      `tools/servers/billing/server.toml does not parse: ${error.issues.map((issue) => issue.message).join("; ")}`,
    );
  });

  it("names tools.toml when it does not parse", async () => {
    const error = await serverFileError(() =>
      compileServerFolder({ ...folder("billing"), tools: "this is not toml [" }),
    );
    expect(error.path).toBe("tools/servers/billing/tools.toml");
  });

  it("names tools.lock.json when the folder has none", async () => {
    const error = await serverFileError(() => compileServerFolder({ ...folder("billing"), lock: undefined }));
    expect(error.path).toBe("tools/servers/billing/tools.lock.json");
    expect(error.issues).toEqual([
      { line: null, field: null, message: "the folder has no tools.lock.json" },
    ]);
    expect(error.message).toBe(
      "tools/servers/billing/tools.lock.json does not parse: the folder has no tools.lock.json",
    );
  });

  it("names tools.lock.json when it does not parse", async () => {
    const error = await serverFileError(() => compileServerFolder({ ...folder("billing"), lock: "{}\n" }));
    expect(error.path).toBe("tools/servers/billing/tools.lock.json");
  });
});

// ── A gRPC folder ────────────────────────────────────────────────────────────

/**
 * A gRPC server folder written the way Studio's import writes one: the
 * .proto files under proto/, a tools.toml that imports each method by its
 * path, and the lock from compiling them with the descriptor set the import
 * returned. The environment routes through a relay, as the MCP Studio live
 * test's ledger does (#5139).
 */
const LEDGER = "ledger";
const LEDGER_PROTO: ImportedFile = {
  path: "proto/ledger.proto",
  text: [
    'syntax = "proto3";',
    "",
    "package ledger.v1;",
    "",
    "service Ledger {",
    "  // Read one ledger entry by its id.",
    "  rpc GetEntry(GetEntryRequest) returns (Entry);",
    "}",
    "",
    "message GetEntryRequest {",
    "  string id = 1;",
    "}",
    "",
    "message Entry {",
    "  string id = 1;",
    "  string account_id = 2;",
    "}",
    "",
  ].join("\n"),
};

const LEDGER_SERVER_TOML = [
  "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
  'schema = "mcp-server/v1"',
  `name = "${LEDGER}"`,
  'label = "Ledger"',
  'description = "The sample gRPC ledger, reached through a relay."',
  "",
  "[source]",
  'type = "grpc"',
  'from = "upload"',
  "",
  "[auth]",
  'mode = "none"',
  "",
  "[environments.sandbox]",
  'url = "http://127.0.0.1:50051"',
  'network = "relay:office"',
  "",
  "[exposure]",
  'mode = "direct"',
  "",
  "[sync]",
  'schedule = "manual"',
  "",
].join("\n");

interface GrpcFolder {
  folder: ServerFolder;
  imported: ImportResult;
  /** The tool key tools.toml imports the one method under. */
  key: string;
}

async function ledgerFolder(): Promise<GrpcFolder> {
  const imported = await importGrpc({ files: [LEDGER_PROTO] });
  const [method] = imported.tools;
  if (method === undefined || method.request.kind !== "grpc") {
    throw new Error("The ledger proto imported no gRPC method.");
  }
  const key = method.name;
  const toolsToml = [
    "#:schema https://oxagen.sh/schemas/mcp-tools/v1.json",
    'schema = "mcp-tools/v1"',
    "",
    `[tools.${key}]`,
    `method = ${JSON.stringify(method.request.method)}`,
    'description = "Read one ledger entry by its id."',
    'risk = "low"',
    'side_effect = "read"',
    'egress = "org_tenant"',
    "",
  ].join("\n");
  const server = parseServerToml(LEDGER_SERVER_TOML);
  const tools = parseToolsToml(toolsToml);
  if (!server.ok || !tools.ok) throw new Error("The ledger folder's server.toml or tools.toml does not parse.");
  const compiled = compile({
    server: server.value,
    tools: tools.value,
    upstream: imported.tools,
    security_schemes: {},
    descriptor_set: imported.descriptor_set,
  });
  const locked = lockServer({
    compiled,
    source: { type: "grpc", from: "upload", document_hash: imported.document_hash },
    previous: undefined,
  });
  return {
    folder: { name: LEDGER, server: LEDGER_SERVER_TOML, tools: toolsToml, lock: formatJson(locked), proto: [LEDGER_PROTO] },
    imported,
    key,
  };
}

/** The fixture repo with the ledger folder added. Leave out proto/ with `withProto: false`. */
function treeWithLedger({ folder: ledger }: GrpcFolder, withProto = true): Map<string, string> {
  const tree = new Map(files);
  const base = `tools/servers/${LEDGER}`;
  tree.set(`${base}/server.toml`, ledger.server);
  tree.set(`${base}/tools.toml`, ledger.tools);
  tree.set(`${base}/tools.lock.json`, ledger.lock ?? "");
  if (withProto) for (const proto of ledger.proto) tree.set(`${base}/${proto.path}`, proto.text);
  return tree;
}

function base64(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) throw new Error("The import returned no descriptor set.");
  return Buffer.from(bytes).toString("base64");
}

const NO_PROTO =
  "tools/servers/ledger/proto holds no .proto files, and a gRPC server needs them to serve its tools. Import the server in Studio to write them.";

describe("compileServerFolder for a gRPC server", () => {
  it("carries the descriptor set the folder's proto/ files give", async () => {
    const ledger = await ledgerFolder();
    const compiled = await compileServerFolder(ledger.folder);

    expect(compiled.name).toBe(LEDGER);
    expect(Object.keys(compiled.tools)).toEqual([ledger.key]);
    expect(compiled.descriptor_set).toBe(base64(ledger.imported.descriptor_set));
    expect(compiled.environments["sandbox"]?.network).toBe("relay:office");
  });

  it("refuses a gRPC folder with no proto/ files", async () => {
    const ledger = await ledgerFolder();
    const refused = compileServerFolder({ ...ledger.folder, proto: [] });
    await expect(refused).rejects.toBeInstanceOf(ProtoFilesError);
    await expect(refused).rejects.toThrow(NO_PROTO);
  });
});

describe("grpcDescriptorSet", () => {
  it("names proto/ when its files do not import", async () => {
    const ledger = await ledgerFolder();
    const broken = { ...ledger.folder, proto: [{ path: "proto/ledger.proto", text: "this is not a proto file {" }] };
    const error = await grpcDescriptorSet(broken).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ProtoFilesError);
    expect((error as ProtoFilesError).path).toBe("tools/servers/ledger/proto");
    expect((error as ProtoFilesError).message).toMatch(/^tools\/servers\/ledger\/proto does not import: /);
  });
});

// ── Every folder ─────────────────────────────────────────────────────────────

describe("serverNames", () => {
  it("names each server folder once, in order", () => {
    expect(serverNames([...files.keys()])).toEqual(["billing", "stripe"]);
    expect(
      serverNames([
        "tools/servers/zeta/tools.lock.json",
        "tools/servers/alpha/tools.toml",
        "tools/servers/alpha/server.toml",
        "tools/servers/beta/openapi.yaml",
        "tools/servers/gamma/tests/calls.jsonl",
        "tools/toolbelts/refunds.toml",
        "steering/brand/a-intel.brand.voice.md",
      ]),
    ).toEqual(["alpha", "zeta"]);
  });
});

describe("buildTools", () => {
  it("compiles every fixture server with MCP Studio's compile()", async () => {
    const result = await buildTools(await reader(files), compileServerFolder);
    expect(result.servers.map((server) => server.name)).toEqual(["billing", "stripe"]);
    expect(result.imported).toEqual([...BILLING_TOOLS, ...STRIPE_TOOLS]);
    expect(result.warnings).toEqual([]);
  });

  it("leaves out a server whose lock no longer pins what compiles", async () => {
    const tree = new Map(files);
    tree.set(BILLING_TOOLS_TOML, billingToolsWithNewDescription());
    const result = await buildTools(await reader(tree), compileServerFolder);
    expect(result.servers.map((server) => server.name)).toEqual(["stripe"]);
    expect(result.warnings).toEqual([`tools/servers/billing is left out: ${STALE_LOCK}`]);
  });

  it("leaves out each server compile refuses, and still lists the imported tools", async () => {
    const compiler: ToolCompiler = () => {
      throw new NotBuiltError("compile");
    };
    expect(await buildTools(await reader(files), compiler)).toEqual({
      servers: [],
      imported: [...BILLING_TOOLS, ...STRIPE_TOOLS],
      warnings: [
        "tools/servers/billing is left out: MCP Studio's compile is not built yet.",
        "tools/servers/stripe is left out: MCP Studio's compile is not built yet.",
      ],
    });
  });

  it("gives the compiler each folder's three files", async () => {
    const seen: ServerFolder[] = [];
    const compiler: ToolCompiler = (entry) => {
      seen.push(entry);
      return { name: entry.name } as unknown as ManifestServer;
    };
    await buildTools(await reader(files), compiler);
    expect(seen).toEqual([folder("billing"), folder("stripe")]);
  });

  it("orders the compiled servers by the names the compiler gives them", async () => {
    const compiler: ToolCompiler = (entry) =>
      ({ name: entry.name === "billing" ? "zulu" : "alpha" }) as unknown as ManifestServer;
    const { servers, warnings } = await buildTools(await reader(files), compiler);
    expect(servers.map((server) => server.name)).toEqual(["alpha", "zulu"]);
    expect(warnings).toEqual([]);
  });

  it("gives a folder with no lock to the compiler without one", async () => {
    const seen: ServerFolder[] = [];
    const compiler: ToolCompiler = (entry) => {
      seen.push(entry);
      return { name: entry.name } as unknown as ManifestServer;
    };
    await buildTools(await reader(without("tools/servers/stripe/tools.lock.json")), compiler);
    expect(seen.map((entry) => [entry.name, entry.lock === undefined])).toEqual([
      ["billing", false],
      ["stripe", true],
    ]);
  });

  it("warns about a folder with no server.toml and does not compile it", async () => {
    const seen: string[] = [];
    const compiler: ToolCompiler = (entry) => {
      seen.push(entry.name);
      return { name: entry.name } as unknown as ManifestServer;
    };
    const result = await buildTools(
      await reader(without("tools/servers/stripe/server.toml")),
      compiler,
    );
    expect(seen).toEqual(["billing"]);
    expect(result.imported).toEqual(BILLING_TOOLS);
    expect(result.warnings).toEqual([
      "tools/servers/stripe has no server.toml or no tools.toml, so the version has no tools from it.",
    ]);
  });

  it("warns about a folder with no tools.toml", async () => {
    const result = await buildTools(
      await reader(without("tools/servers/billing/tools.toml")),
      () => {
        throw new NotBuiltError("compile");
      },
    );
    expect(result.imported).toEqual(STRIPE_TOOLS);
    expect(result.warnings[0]).toBe(
      "tools/servers/billing has no server.toml or no tools.toml, so the version has no tools from it.",
    );
  });

  it("carries a compiler's own message into the warning", async () => {
    const compiler: ToolCompiler = (entry) => {
      if (entry.name === "billing") throw new Error("billing's lock pins a tool tools.toml drops");
      return { name: entry.name } as unknown as ManifestServer;
    };
    const { servers, warnings } = await buildTools(await reader(files), compiler);
    expect(servers.map((server) => server.name)).toEqual(["stripe"]);
    expect(warnings).toEqual([
      "tools/servers/billing is left out: billing's lock pins a tool tools.toml drops",
    ]);
  });

  it("lists no tools from a tools.toml that does not parse", async () => {
    const tree = new Map(files);
    tree.set("tools/servers/stripe/tools.toml", "this is not toml [");
    const result = await buildTools(await reader(tree), () => {
      throw new NotBuiltError("compile");
    });
    expect(result.imported).toEqual(BILLING_TOOLS);
  });

  it("lists no tools from a tools.toml with no tools table", async () => {
    const tree = new Map(files);
    tree.set("tools/servers/stripe/tools.toml", 'schema = "mcp-tools/v1"\n');
    const result = await buildTools(await reader(tree), () => {
      throw new NotBuiltError("compile");
    });
    expect(result.imported).toEqual(BILLING_TOOLS);
    expect(result.warnings).toEqual([
      "tools/servers/billing is left out: MCP Studio's compile is not built yet.",
      "tools/servers/stripe is left out: MCP Studio's compile is not built yet.",
    ]);
  });

  it("warns when a folder's name is not a server name", async () => {
    const tree = new Map<string, string>();
    for (const name of ["server.toml", "tools.toml", "tools.lock.json"]) {
      tree.set(`tools/servers/Billing/${name}`, file(`tools/servers/billing/${name}`));
    }
    const result = await buildTools(await reader(tree), () => {
      throw new NotBuiltError("compile");
    });
    expect(result.imported).toEqual([]);
    expect(result.warnings[0]).toMatch(
      /^tools\/servers\/Billing\/tools\.toml: "Billing" is not a server name\./,
    );
    expect(result.warnings).toHaveLength(7);
    expect(result.warnings[6]).toBe(
      "tools/servers/Billing is left out: MCP Studio's compile is not built yet.",
    );
  });

  // #5344: publish passed no descriptor set, so compile() refused every gRPC
  // server, and the gateway listed none of its tools to any agent.
  it("serves a gRPC server, with the descriptor set its proto/ files give", async () => {
    const ledger = await ledgerFolder();
    const result = await buildTools(await reader(treeWithLedger(ledger)), compileServerFolder);

    expect(result.warnings).toEqual([]);
    expect(result.servers.map((server) => server.name)).toEqual(["billing", LEDGER, "stripe"]);
    expect(result.imported).toContain(`${LEDGER}__${ledger.key}`);
    const served = result.servers.find((server) => server.name === LEDGER);
    expect(served?.descriptor_set).toBe(base64(ledger.imported.descriptor_set));
  });

  it("gives the compiler a gRPC folder's proto/ files by path in the folder", async () => {
    const ledger = await ledgerFolder();
    const seen: ServerFolder[] = [];
    const compiler: ToolCompiler = (entry) => {
      seen.push(entry);
      return { name: entry.name } as unknown as ManifestServer;
    };
    await buildTools(await reader(treeWithLedger(ledger)), compiler);
    expect(seen.map((entry) => [entry.name, entry.proto])).toEqual([
      ["billing", []],
      [LEDGER, [LEDGER_PROTO]],
      ["stripe", []],
    ]);
  });

  it("leaves out a gRPC server whose folder has no proto/ files, and says why", async () => {
    const ledger = await ledgerFolder();
    const result = await buildTools(await reader(treeWithLedger(ledger, false)), compileServerFolder);

    expect(result.servers.map((server) => server.name)).toEqual(["billing", "stripe"]);
    expect(result.warnings).toEqual([`tools/servers/${LEDGER} is left out: ${NO_PROTO}`]);
  });
});
