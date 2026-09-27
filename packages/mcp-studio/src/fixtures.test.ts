// fixtures.test.ts: every file under fixtures/ parses, and the expected files
// agree with the folders they were written from.
//
// The lanes build against these files. M1 must return
// expected/billing/upstream.json for billing's openapi.yaml, and M4 must
// write servers/<name>/tools.lock.json and expected/<name>/manifest.json byte
// for byte. The checks below tie each expected file to its inputs, so a
// fixture edit that breaks that agreement fails here first.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { toolName } from "@oxagen/oxagen/steering-repo/names";
import { effectiveAnnotations } from "./contract/classification";
import { definitionHash, definitionTokens, documentHash, upstreamHash } from "./contract/hashes";
import { formatJson } from "./contract/json";
import type { McpToolsLock } from "./contract/lock";
import type { ManifestServer } from "./contract/manifest";
import { lockedMcpTool, lockedMcpToolSchema, mcpToolsListResultSchema, type McpTool } from "./contract/mcp-tool";
import {
  parseLock,
  parseRecordedCalls,
  parseSelectionTests,
  parseServerToml,
  parseToolManifest,
  parseToolsToml,
  type ReadResult,
} from "./contract/parse";
import { toolKeySchema } from "./contract/primitives";
import { registryEntrySchema } from "./contract/registry-entry";
import { agentEnvironment, DEFAULT_ENVIRONMENT, type McpServer } from "./contract/server";
import type { McpTools } from "./contract/tools";
import { lockedUpstream, upstreamFromMcpTool } from "./model/from-mcp";
import { builtinSecurityScheme } from "./model/security-scheme";
import { grpcIdempotencyLevelSchema, upstreamToolSchema, type UpstreamTool } from "./model/upstream-tool";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

function text(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

function json(path: string): unknown {
  return JSON.parse(text(path)) as unknown;
}

function yaml(path: string): Record<string, unknown> {
  return parseYaml(text(path)) as Record<string, unknown>;
}

/** The value of a parse that must succeed. A failure shows its issues. */
function ok<T>(result: ReadResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.value;
}

type Json = Record<string, unknown>;

/** Every value of $ref in a parsed document, at any depth. */
function refs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) refs(item, found);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else refs(value, found);
    }
  }
  return found;
}

/** The node a JSON Pointer names, or undefined. */
function pointer(doc: unknown, path: string): unknown {
  if (path === "" || path === "/") return doc;
  let node = doc;
  for (const raw of path.replace(/^\//, "").split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Json)[key];
  }
  return node;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** Every operation in a document's paths, in document order. */
function operations(doc: Json): Array<{ path: string; method: string; op: Json }> {
  const out: Array<{ path: string; method: string; op: Json }> = [];
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Record<string, Json>)) {
    for (const method of METHODS) {
      const op = item[method];
      if (op !== undefined) out.push({ path, method, op: op as Json });
    }
  }
  return out;
}

// ── Server folders ───────────────────────────────────────────────────────────

interface Folder {
  server: McpServer;
  tools: McpTools;
  lock: McpToolsLock;
  manifest: ManifestServer;
}

function folder(name: string): Folder {
  const dir = `servers/${name}`;
  return {
    server: ok(parseServerToml(text(`${dir}/server.toml`))),
    tools: ok(parseToolsToml(text(`${dir}/tools.toml`))),
    lock: ok(parseLock(text(`${dir}/tools.lock.json`))),
    manifest: ok(parseToolManifest(text("expected/tool-manifest.json"))).servers.find((s) => s.name === name)!,
  };
}

const SERVERS = ["billing", "stripe"] as const;

describe.each(SERVERS)("the %s server folder", (name) => {
  const { server, tools, lock, manifest } = folder(name);
  const entries = tools.tools ?? {};

  it("names the same server in server.toml, the lock, and the manifest", () => {
    expect(server.name).toBe(name);
    expect(lock.server).toBe(name);
    expect(manifest.name).toBe(name);
  });

  it("locks exactly the tools tools.toml imports, at version 1", () => {
    expect(Object.keys(lock.tools).sort()).toStrictEqual(Object.keys(entries).sort());
    for (const tool of Object.values(lock.tools)) expect(tool.version).toBe(1);
  });

  it("writes the lock in the form lock() writes, so M4 can match it byte for byte", () => {
    const raw = text(`servers/${name}/tools.lock.json`);
    expect(formatJson(JSON.parse(raw))).toBe(raw);
    expect(JSON.parse(raw)).toStrictEqual(lock);
  });

  it("carries each locked upstream's hash", () => {
    for (const tool of Object.values(lock.tools)) expect(tool.upstream_hash).toBe(upstreamHash(tool.upstream));
  });

  it("matches its entry in expected/tool-manifest.json", () => {
    expect(json(`expected/${name}/manifest.json`)).toStrictEqual(manifest);
    expect(text(`expected/${name}/manifest.json`)).toBe(formatJson(manifest));
  });

  it("pins in the manifest what the lock pins", () => {
    expect(manifest.pinned).toStrictEqual(lock.source);
    expect(manifest.source).toStrictEqual(server.source);
    expect(manifest.label).toBe(server.label);
    expect(manifest.description).toBe(server.description);
    expect(manifest.exposure).toStrictEqual(server.exposure);
  });

  it("builds each manifest tool from its lock entry and its tools.toml entry", () => {
    expect(Object.keys(manifest.tools).sort()).toStrictEqual(Object.keys(lock.tools).sort());
    for (const [key, tool] of Object.entries(manifest.tools)) {
      const locked = lock.tools[key]!;
      const entry = entries[key]!;
      expect(tool.name).toBe(toolName(name, key));
      expect(tool.definition.name).toBe(tool.name);
      expect(tool.version).toBe(locked.version);
      expect(tool.upstream_hash).toBe(locked.upstream_hash);
      expect(tool.definition_hash).toBe(locked.definition_hash);
      expect(tool.definition_hash).toBe(definitionHash(tool.definition));
      expect(tool.tokens).toBe(definitionTokens(tool.definition));
      expect(tool.definition.description).toBe(entry.description ?? locked.upstream.description);
      expect(tool.definition.annotations).toStrictEqual(effectiveAnnotations(entry));
      expect(tool.classification).toStrictEqual({
        risk: entry.risk,
        side_effect: entry.side_effect,
        egress: entry.egress,
        impacts: entry.impacts ?? [],
        measures: entry.measures ?? {},
        data_classes: entry.data_classes ?? [],
      });
      for (const hidden of [...(entry.hide ?? []), ...Object.keys(entry.fixed ?? {})]) {
        expect(Object.keys((tool.definition.inputSchema.properties ?? {}) as Json)).not.toContain(hidden);
      }
    }
  });

  it("counts the definitions' tokens, and in direct mode sends them all", () => {
    const sum = Object.values(manifest.tools).reduce((total, tool) => total + tool.tokens, 0);
    expect(manifest.tokens.definitions).toBe(sum);
    expect(manifest.exposure.mode).toBe("direct");
    expect(manifest.tokens.request).toBe(sum);
    expect(manifest.search).toBeNull();
  });

  it("sends every agent's calls to the sandbox environment", () => {
    const sandbox = agentEnvironment(server);
    expect(Object.keys(manifest.environments).sort()).toStrictEqual(Object.keys(server.environments ?? {}).sort());
    for (const [env, resolved] of Object.entries(manifest.environments)) {
      expect(resolved.sandbox).toBe(env === sandbox);
      expect(resolved.credential).toBe(server.environments?.[env]?.credential ?? server.auth?.credential);
    }
  });

  it("parses tests/calls.jsonl, and each call names a tool tools.toml imports", () => {
    const calls = ok(parseRecordedCalls(text(`servers/${name}/tests/calls.jsonl`)));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(Object.keys(entries)).toContain(call.tool);
  });

  it("parses tests/selection.jsonl, and each test expects a tool the manifest lists", () => {
    const tests = ok(parseSelectionTests(text(`servers/${name}/tests/selection.jsonl`)));
    expect(tests.length).toBeGreaterThan(0);
    const names = Object.values(manifest.tools).map((tool) => tool.name);
    for (const test of tests) expect(names).toContain(test.expect);
  });
});

describe("the tool manifest", () => {
  it("is in the form Oxagen writes, with servers ordered by name", () => {
    const raw = text("expected/tool-manifest.json");
    const manifest = ok(parseToolManifest(raw));
    expect(formatJson(JSON.parse(raw))).toBe(raw);
    expect(manifest.servers.map((s) => s.name)).toStrictEqual([...SERVERS]);
  });
});

describe("the stripe fixtures", () => {
  const { server, lock, manifest } = folder("stripe");
  const listed = mcpToolsListResultSchema.parse(json("sources/stripe/tools-list.json"));
  const initialize = json("sources/stripe/initialize.json") as { serverInfo: { version: string } };

  function source(name: string): McpTool {
    const tool = listed.tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`tools/list has no ${name}`);
    return tool;
  }

  it("pins the version the server reported at initialize", () => {
    expect(lock.source).toStrictEqual({
      type: "remote",
      url: server.source.type === "remote" ? server.source.url : "",
      server_version: initialize.serverInfo.version,
    });
  });

  it("locks the tools/list entry, without _meta", () => {
    expect(source("create_refund")._meta).toBeDefined();
    for (const [key, tool] of Object.entries(lock.tools)) {
      expect(tool.upstream).toStrictEqual(lockedMcpTool(source(key)));
      expect(tool.upstream).toStrictEqual(lockedUpstream(upstreamFromMcpTool(source(key))));
      expect(tool.upstream).not.toHaveProperty("_meta");
    }
  });

  it("leaves a listed tool tools.toml does not import out of the lock", () => {
    expect(source("create_customer")).toBeDefined();
    expect(lock.tools).not.toHaveProperty("create_customer");
  });

  it("sends the MCP tool by its own name, and applies oauth from the scheme's name", () => {
    for (const [key, tool] of Object.entries(manifest.tools)) {
      expect(tool.request).toStrictEqual(upstreamFromMcpTool(source(key)).request);
    }
    expect(manifest.auth?.apply).toStrictEqual(builtinSecurityScheme("oauth", undefined));
  });
});

describe("the billing fixtures", () => {
  const { lock, manifest } = folder("billing");
  const document = text("servers/billing/openapi.yaml");
  const spec = parseYaml(document) as Json;
  const upstream = (json("expected/billing/upstream.json") as unknown[]).map((tool) => upstreamToolSchema.parse(tool));
  const resolved = json("sources/billing/resolved.json") as { commit: string; ref: string };

  function byOperation(operationId: string): UpstreamTool {
    const tool = upstream.find((t) => t.request.kind === "http" && t.request.operation === operationId);
    if (tool === undefined) throw new Error(`expected/billing/upstream.json has no ${operationId}`);
    return tool;
  }

  it("lists one upstream tool per operation, in document order", () => {
    const ids = operations(spec).map(({ op }) => op.operationId);
    expect(upstream.map((t) => (t.request.kind === "http" ? t.request.operation : null))).toStrictEqual(ids);
  });

  it("pins the document's hash, commit, and security schemes", () => {
    if (lock.source.type !== "openapi") throw new Error("billing's lock is not an openapi lock");
    expect(lock.source.document_hash).toBe(documentHash(document));
    expect(lock.source.commit).toBe(resolved.commit);
    expect(lock.source.ref).toBe(resolved.ref);
    expect(Object.keys(lock.source.security_schemes ?? {})).toStrictEqual(
      Object.keys(pointer(spec, "/components/securitySchemes") as Json),
    );
  });

  it("locks the upstream tool M1 returns for the operation", () => {
    const entries = ok(parseToolsToml(text("servers/billing/tools.toml"))).tools ?? {};
    for (const [key, tool] of Object.entries(lock.tools)) {
      expect(tool.upstream).toStrictEqual(byOperation(entries[key]!.operation!));
    }
  });

  it("takes each schema from the document", () => {
    const list = byOperation("listCharges");
    expect(list.outputSchema).toStrictEqual(
      pointer(spec, "/paths/~1customers~1{customer_id}~1charges/get/responses/200/content/application~1json/schema"),
    );
    const refund = byOperation("createRefund");
    const body = pointer(spec, "/paths/~1refunds/post/requestBody/content/application~1json/schema") as Json;
    expect(refund.inputSchema.properties).toMatchObject(body.properties as Json);
    expect(refund.inputSchema.required).toStrictEqual(body.required);
  });

  it("carries x-oxagen-tool as a suggestion", () => {
    expect(byOperation("getCharge").suggestion).toStrictEqual(
      pointer(spec, "/paths/~1charges~1{charge_id}/get/x-oxagen-tool"),
    );
  });

  it("applies the auth scheme the lock pins", () => {
    if (lock.source.type !== "openapi") throw new Error("billing's lock is not an openapi lock");
    expect(manifest.auth?.apply).toStrictEqual(lock.source.security_schemes?.oauth);
  });
});

// ── Environments ─────────────────────────────────────────────────────────────

describe("the environment fixtures", () => {
  const valid: Array<[string, string]> = [
    ["none", DEFAULT_ENVIRONMENT],
    ["one", "live"],
    ["three-one-sandbox", "staging"],
  ];

  it.each(valid)("%s.toml sends every agent's calls to %s", (file, expected) => {
    expect(agentEnvironment(ok(parseServerToml(text(`environments/${file}.toml`))))).toBe(expected);
  });

  const invalid: Array<[string, string, string]> = [
    [
      "two-no-sandbox",
      "environments",
      "mark one environment sandbox = true: every agent's calls go to the sandbox when a server has two or more environments",
    ],
    ["two-sandboxes", "environments.live.sandbox", "only one environment may be the sandbox, and test already is"],
  ];

  it.each(invalid)("%s.toml is refused at %s", (file, field, message) => {
    const result = parseServerToml(text(`environments/${file}.toml`));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toStrictEqual([expect.objectContaining({ field, message })]);
  });
});

// ── MCP and registry ─────────────────────────────────────────────────────────

describe("the MCP tools/list fixture", () => {
  const listed = mcpToolsListResultSchema.parse(json("mcp/tools-list.json"));
  const [annotated, bare, hyphenated] = listed.tools;

  it("holds an annotated tool, a bare tool, and a hyphenated name, with a next cursor", () => {
    expect(listed.tools.map((t) => t.name)).toStrictEqual(["create_issue", "list_repositories", "search-code"]);
    expect(listed.nextCursor).toBeDefined();
    expect(bare?.annotations).toBeUndefined();
  });

  it("locks only the five MCP hints, and no unknown field", () => {
    const locked = lockedMcpTool(annotated!);
    expect(lockedMcpToolSchema.safeParse(locked).success).toBe(true);
    expect(Object.keys(locked.annotations ?? {}).sort()).toStrictEqual(
      ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint", "title"],
    );
    expect(locked).not.toHaveProperty("icons");
    expect(locked).not.toHaveProperty("_meta");
    expect(lockedMcpTool(bare!)).not.toHaveProperty("annotations");
  });

  it("keeps a hyphenated name as the upstream tool, though it is no tool key", () => {
    expect(toolKeySchema.safeParse(hyphenated!.name).success).toBe(false);
    expect(upstreamFromMcpTool(hyphenated!).request).toStrictEqual({ kind: "mcp", tool: "search-code" });
  });
});

describe("the registry fixtures", () => {
  it.each(["remote-entry", "package-entry"])("%s.json is a registry entry", (file) => {
    expect(registryEntrySchema.safeParse(json(`registry/${file}.json`)).success).toBe(true);
  });

  it("offers a remote in one and a package in the other", () => {
    const remote = registryEntrySchema.parse(json("registry/remote-entry.json"));
    const pkg = registryEntrySchema.parse(json("registry/package-entry.json"));
    expect(remote.server.remotes?.length).toBeGreaterThan(0);
    expect(pkg.server.packages?.length).toBeGreaterThan(0);
  });
});

// ── OpenAPI, GraphQL, and gRPC documents ─────────────────────────────────────

/** Every local $ref in a single-file document resolves inside it. */
function expectLocalRefsResolve(doc: Json): void {
  for (const ref of refs(doc)) {
    expect(ref.startsWith("#/"), ref).toBe(true);
    expect(pointer(doc, ref.slice(1)), ref).toBeDefined();
  }
}

describe("the OpenAPI fixtures", () => {
  it("openapi-3.0.yaml has nullable, PUT and DELETE, and one unnamed and one deprecated operation", () => {
    const doc = yaml("openapi/openapi-3.0.yaml");
    expect(doc.openapi).toBe("3.0.3");
    expectLocalRefsResolve(doc);
    const ops = operations(doc);
    expect(ops.map((o) => o.method)).toEqual(expect.arrayContaining(["put", "delete"]));
    expect(ops.filter((o) => o.op.operationId === undefined)).toHaveLength(1);
    expect(ops.filter((o) => o.op.deprecated === true)).toHaveLength(1);
    expect(text("openapi/openapi-3.0.yaml")).toContain("nullable: true");
    expect(pointer(doc, "/components/securitySchemes/api_key/type")).toBe("apiKey");
  });

  it("openapi-3.0.yaml has a path parameter a body property repeats", () => {
    const doc = yaml("openapi/openapi-3.0.yaml");
    const rename = operations(doc).find((o) => o.op.operationId === "renameOwner")!.op;
    const params = (rename.parameters as Json[]).map((p) => p.name);
    const body = pointer(rename, "/requestBody/content/application~1json/schema/properties") as Json;
    expect(params.filter((p) => typeof p === "string" && p in body)).toStrictEqual(["name"]);
  });

  it("openapi-3.1.yaml has a oneOf whose discriminator maps to each branch", () => {
    const doc = yaml("openapi/openapi-3.1.yaml");
    expect(doc.openapi).toBe("3.1.0");
    expectLocalRefsResolve(doc);
    const method = pointer(doc, "/components/schemas/PaymentMethod") as Json;
    expect(method.oneOf).toHaveLength(2);
    const mapping = pointer(method, "/discriminator/mapping") as Record<string, string>;
    for (const [value, ref] of Object.entries(mapping)) {
      expect(pointer(doc, `${ref.slice(1)}/properties/type/const`)).toBe(value);
    }
    expect(pointer(doc, "/components/schemas/Payment/properties/note/type")).toStrictEqual(["string", "null"]);
    expect(doc.webhooks).toBeDefined();
  });

  it("swagger-2.0.yaml has a body parameter, a formData parameter, and securityDefinitions", () => {
    const doc = yaml("openapi/swagger-2.0.yaml");
    expect(doc.swagger).toBe("2.0");
    expect(doc.basePath).toBe("/v1");
    expectLocalRefsResolve(doc);
    const places = operations(doc).flatMap(({ op }) => ((op.parameters ?? []) as Json[]).map((p) => p.in));
    expect(places).toEqual(expect.arrayContaining(["body", "formData", "query", "path"]));
    expect(Object.keys(doc.securityDefinitions as Json)).toStrictEqual(["api_key", "oauth"]);
  });

  it("recursive.yaml has a schema that holds itself and two that hold each other", () => {
    const doc = yaml("openapi/recursive.yaml");
    expectLocalRefsResolve(doc);
    expect(pointer(doc, "/components/schemas/Category/properties/parent/$ref")).toBe("#/components/schemas/Category");
    expect(pointer(doc, "/components/schemas/Employee/properties/manager/$ref")).toBe("#/components/schemas/Manager");
    expect(refs(pointer(doc, "/components/schemas/Manager"))).toContain("#/components/schemas/Employee");
  });

  it("large.yaml has 600 operations with 600 distinct ids", () => {
    const doc = yaml("openapi/large.yaml");
    expectLocalRefsResolve(doc);
    const ids = operations(doc).map(({ op }) => op.operationId);
    expect(ids).toHaveLength(600);
    expect(new Set(ids).size).toBe(600);
  });

  it("multi-file/ reaches every file from openapi.yaml, and every $ref resolves", () => {
    const root = join(FIXTURES, "openapi/multi-file");
    const seen = new Set<string>();
    const queue = [join(root, "openapi.yaml")];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const doc = parseYaml(readFileSync(file, "utf8")) as unknown;
      for (const ref of refs(doc)) {
        const [target = "", fragment] = ref.split("#");
        const path = target === "" ? file : resolve(dirname(file), target);
        expect(existsSync(path), `${relative(root, file)}: ${ref}`).toBe(true);
        const targetDoc = target === "" ? doc : (parseYaml(readFileSync(path, "utf8")) as unknown);
        if (fragment !== undefined) expect(pointer(targetDoc, fragment), ref).toBeDefined();
        if (target !== "") queue.push(path);
      }
    }
    const all = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? all(path) : [path];
      });
    expect([...seen].sort()).toStrictEqual(all(root).sort());
  });
});

/** The fields of one type in an SDL, by name. */
function sdlFields(sdl: string, type: string): string[] {
  const block = new RegExp(`\\ntype ${type}(?: implements \\w+)? \\{\\n([^}]*)\\}`).exec(sdl)?.[1];
  if (block === undefined) throw new Error(`the SDL has no type ${type}`);
  return block
    .split("\n")
    .map((line) => /^ {2}(\w+)[(:]/.exec(line)?.[1])
    .filter((field): field is string => field !== undefined);
}

describe("the GraphQL fixture", () => {
  const sdl = text("graphql/schema.graphql");

  it("has queries, mutations, and a subscription", () => {
    expect(sdlFields(sdl, "Query")).toStrictEqual(["node", "issue", "issues", "search", "viewer"]);
    expect(sdlFields(sdl, "Mutation")).toStrictEqual(["createIssue", "updateIssue", "deleteIssue", "addComment"]);
    expect(sdlFields(sdl, "Subscription")).toStrictEqual(["issueChanged"]);
  });

  it("has a Relay connection, an interface, a union, a scalar, and a deprecated field", () => {
    expect(sdlFields(sdl, "IssueConnection")).toStrictEqual(["edges", "pageInfo", "totalCount"]);
    expect(sdlFields(sdl, "PageInfo")).toEqual(expect.arrayContaining(["hasNextPage", "endCursor"]));
    for (const marker of ["interface Node", "union Assignee", "scalar DateTime", "input CreateIssueInput", "@deprecated"]) {
      expect(sdl).toContain(marker);
    }
  });

  it("balances its braces", () => {
    expect(sdl.split("{").length).toBe(sdl.split("}").length);
  });
});

describe("the gRPC fixture", () => {
  const proto = text("grpc/ledger.proto");
  const rpc = /rpc (\w+)\((stream )?[\w.]+\) returns \((stream )?[\w.]+\)(?: \{\s*option idempotency_level = (\w+);\s*\})?/g;
  const methods = [...proto.matchAll(rpc)].map((m) => ({
    name: m[1],
    streaming: m[2] !== undefined ? (m[3] !== undefined ? "bidi" : "client") : m[3] !== undefined ? "server" : "unary",
    level: m[4] ?? "IDEMPOTENCY_UNKNOWN",
  }));

  it("has unary, server-streaming, client-streaming, and bidi methods", () => {
    expect(methods.map((m) => [m.name, m.streaming])).toStrictEqual([
      ["GetEntry", "unary"],
      ["PostEntry", "unary"],
      ["ReverseEntry", "unary"],
      ["ListEntries", "server"],
      ["UploadEntries", "client"],
      ["SyncEntries", "bidi"],
    ]);
  });

  it("has all three idempotency levels, by the names the model uses", () => {
    for (const m of methods) expect(grpcIdempotencyLevelSchema.safeParse(m.level).success).toBe(true);
    expect(new Set(methods.map((m) => m.level))).toStrictEqual(new Set(grpcIdempotencyLevelSchema.options));
  });

  it("has an Any field, a oneof, a map, and a repeated field", () => {
    for (const marker of ["google.protobuf.Any detail", "oneof source", "map<string, string> labels", "repeated string"]) {
      expect(proto).toContain(marker);
    }
    expect(proto).toContain("package a_intel.ledger.v1;");
  });
});
