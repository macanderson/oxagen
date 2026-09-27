import { describe, expect, it } from "vitest";
import {
  NotBuiltError,
  parseLock,
  type ManifestServer,
  type McpToolsLock,
} from "@oxagen/mcp-studio";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  buildTools,
  compileServerFolder,
  lockedSecuritySchemes,
  lockedUpstreamTools,
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

function serverFileError(run: () => unknown): ServerFileError {
  try {
    run();
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

describe("compileServerFolder", () => {
  it("compiles the billing folder, or stops at compile until MCP Studio builds it", () => {
    let compiled: ManifestServer | undefined;
    try {
      compiled = compileServerFolder(folder("billing"));
    } catch (error) {
      expect(error).toBeInstanceOf(NotBuiltError);
      expect((error as NotBuiltError).module).toMatch(/^compile/);
      return;
    }
    expect(compiled.name).toBe("billing");
  });

  it("names server.toml when it does not parse", () => {
    const error = serverFileError(() =>
      compileServerFolder({ ...folder("billing"), server: 'schema = "mcp-server/v1"\nname = 7\n' }),
    );
    expect(error.path).toBe("tools/servers/billing/server.toml");
    expect(error.name).toBe("ServerFileError");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.message).toBe(
      `tools/servers/billing/server.toml does not parse: ${error.issues.map((issue) => issue.message).join("; ")}`,
    );
  });

  it("names tools.toml when it does not parse", () => {
    const error = serverFileError(() =>
      compileServerFolder({ ...folder("billing"), tools: "this is not toml [" }),
    );
    expect(error.path).toBe("tools/servers/billing/tools.toml");
  });

  it("names tools.lock.json when the folder has none", () => {
    const error = serverFileError(() => compileServerFolder({ ...folder("billing"), lock: undefined }));
    expect(error.path).toBe("tools/servers/billing/tools.lock.json");
    expect(error.issues).toEqual([
      { line: null, field: null, message: "the folder has no tools.lock.json" },
    ]);
    expect(error.message).toBe(
      "tools/servers/billing/tools.lock.json does not parse: the folder has no tools.lock.json",
    );
  });

  it("names tools.lock.json when it does not parse", () => {
    const error = serverFileError(() => compileServerFolder({ ...folder("billing"), lock: "{}\n" }));
    expect(error.path).toBe("tools/servers/billing/tools.lock.json");
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
});
