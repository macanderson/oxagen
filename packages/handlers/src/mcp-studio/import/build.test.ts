// build.test.ts: buildFolder and folderCommit, the pure half of Review.
// review.open.test.ts covers a first import from each source, a
// reclassification, a removal, and the unclassified refusal through the
// handler. This file covers the build's other refusals and its edge cases.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import type { StudioDraftOp, StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { parseToolsToml } from "@oxagen/mcp-studio";
import {
  buildFolder,
  folderCommit,
  isDefinitionPath,
  isFolderPath,
  isManagedPath,
  type BuildInput,
  type StudioClassification,
} from "./build";
import { importSource } from "./source";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A file under packages/mcp-studio/fixtures, read when a test asks for it. */
function fixture(path: string): string {
  return readFileSync(new URL(`../../../../mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
}

function fixtureJson<T>(path: string): T {
  return JSON.parse(fixture(path)) as T;
}

/** The billing folder's managed files on the production branch. */
function billingProduction(): Map<string, string> {
  const paths = ["server.toml", "tools.toml", "tools.lock.json", "openapi.yaml", "tests/calls.jsonl"];
  return new Map(paths.map((path) => [path, fixture(`servers/billing/${path}`)]));
}

/** A server.toml for a gRPC server read from a URL, with no auth. */
function grpcServerToml(name: string): string {
  return [
    "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
    'schema = "mcp-server/v1"',
    `name = "${name}"`,
    'label = "Acme ledger"',
    'description = "Ledger entries in the Acme services."',
    "",
    "[source]",
    'type = "grpc"',
    'from = "url"',
    'url = "https://docs.acme.example/grpc"',
    "",
    "[auth]",
    'mode = "none"',
    "",
    "[environments.prod]",
    'url = "https://api.acme.example/v1"',
    "",
    "[exposure]",
    'mode = "direct"',
    "",
    "[sync]",
    'schedule = "daily"',
    "",
  ].join("\n");
}

type McpSource = Extract<StudioSource, { type: "mcp" }>;

/** An MCP source with the stripe lock's source and the tools given. */
function mcpSource(tools: Record<string, unknown>[]): McpSource {
  return {
    type: "mcp",
    lockSource: fixtureJson<{ source: Record<string, unknown> }>("servers/stripe/tools.lock.json").source,
    tools,
  };
}

function stripeTools(): Record<string, unknown>[] {
  return fixtureJson<{ tools: Record<string, unknown>[] }>("sources/stripe/tools-list.json").tools;
}

// ── Ops ──────────────────────────────────────────────────────────────────────

const READ_TENANT: StudioClassification = { risk: "low", sideEffect: "read", egress: "org_tenant", impacts: [] };
const READ_THIRD_PARTY: StudioClassification = { risk: "low", sideEffect: "read", egress: "third_party", impacts: [] };
const MEDIUM_READ: StudioClassification = { risk: "medium", sideEffect: "read", egress: "org_tenant", impacts: [] };

function imp(tool: string): StudioDraftOp {
  return { kind: "import", tool };
}

function classify(tool: string, c: StudioClassification): StudioDraftOp {
  return { kind: "classify", tool, ...c };
}

type TestOp = Extract<StudioDraftOp, { kind: "test" }>;

/** A saved test of list_charges, as Studio stages it, with any field replaced. */
function testOp(fields: Partial<TestOp> = {}): TestOp {
  return {
    kind: "test",
    tool: "list_charges",
    environment: "sandbox",
    args: JSON.stringify({ customer_id: "cus_81" }),
    request: JSON.stringify({ method: "GET", path: "/customers/cus_81/charges" }),
    raw: JSON.stringify({ status: 200, body: { data: [{ id: "ch_3P9", amount: 4000 }] } }),
    shaped: JSON.stringify({ data: [{ id: "ch_3P9", amount: 4000 }] }),
    ...fields,
  };
}

// ── Inputs ───────────────────────────────────────────────────────────────────

interface Fields {
  server?: string;
  ops?: StudioDraftOp[];
  serverToml?: string | null;
  source?: StudioSource | null;
  imported?: BuildInput["imported"];
  production?: ReadonlyMap<string, string>;
}

function input(fields: Fields): BuildInput {
  return {
    draft: {
      server: fields.server ?? "billing",
      ops: fields.ops ?? [],
      serverToml: fields.serverToml ?? null,
      source: fields.source ?? null,
    },
    imported: fields.imported ?? null,
    production: fields.production ?? new Map(),
    credentials: new Set(),
  };
}

/** A new stripe folder from an MCP source, imported the way Review imports it. */
async function stripeInput(source: McpSource, ops: StudioDraftOp[]): Promise<BuildInput> {
  return input({
    server: "stripe",
    serverToml: fixture("servers/stripe/server.toml"),
    source,
    imported: await importSource(source),
    ops,
  });
}

function refusal(build: () => unknown): HandlerError {
  try {
    build();
  } catch (err) {
    if (err instanceof HandlerError) return err;
    throw err;
  }
  throw new Error("buildFolder did not refuse.");
}

function callLines(text: string | undefined): string[] {
  if (text === undefined) throw new Error("The folder holds no tests/calls.jsonl.");
  expect(text.endsWith("\n")).toBe(true);
  return text.split("\n").filter((line) => line !== "");
}

// ── Builds ───────────────────────────────────────────────────────────────────

describe("buildFolder", () => {
  it("keys an MCP tool whose name is not a valid key in snake case, and keeps the name as upstream", async () => {
    const tools = fixtureJson<{ tools: Record<string, unknown>[] }>("mcp/tools-list.json").tools.filter(
      (tool) => tool.name === "search-code",
    );
    const folder = buildFolder(
      await stripeInput(mcpSource(tools), [imp("search-code"), classify("search-code", READ_THIRD_PARTY)]),
    );

    expect(folder.imported).toStrictEqual(["search_code"]);
    expect(folder.isNew).toBe(true);
    const parsed = parseToolsToml(folder.files.get("tools.toml") ?? "");
    if (!parsed.ok) throw new Error("tools.toml does not parse.");
    expect(parsed.value.tools?.search_code).toMatchObject({
      upstream: "search-code",
      risk: "low",
      side_effect: "read",
      egress: "third_party",
    });
    const lock = JSON.parse(folder.files.get("tools.lock.json") ?? "{}") as { tools: Record<string, unknown> };
    expect(Object.keys(lock.tools)).toStrictEqual(["search_code"]);
  });

  it("adds a saved test once, so a second Review of the merged folder commits nothing", () => {
    const ops = [classify("list_charges", MEDIUM_READ), testOp()];
    const first = buildFolder(input({ ops, production: billingProduction() }));

    expect(first.tested).toStrictEqual(["list_charges"]);
    expect(first.reclassified).toStrictEqual([{ tool: "list_charges", before: READ_TENANT, after: MEDIUM_READ }]);
    const lines = callLines(first.files.get("tests/calls.jsonl"));
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({ tool: "list_charges", arguments: { customer_id: "cus_81" } });

    const second = buildFolder(input({ ops, production: first.files }));
    expect(second.tested).toStrictEqual([]);
    expect(second.reclassified).toStrictEqual([]);
    expect(second.files).toStrictEqual(first.files);
    expect(folderCommit("billing", second.files, first.files)).toStrictEqual([]);
  });

  it("keeps production's tools.toml text and definition when no tool changes", () => {
    const production = billingProduction();
    const folder = buildFolder(input({ ops: [classify("list_charges", READ_TENANT)], production }));

    expect(folder.isNew).toBe(false);
    expect(folder.reclassified).toStrictEqual([]);
    expect(folder.files.get("tools.toml")).toBe(production.get("tools.toml"));
    expect(folder.files.get("openapi.yaml")).toBe(production.get("openapi.yaml"));
    expect(folder.files.get("tests/calls.jsonl")).toBe(production.get("tests/calls.jsonl"));
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe("buildFolder refuses", () => {
  it("a folder with no server.toml", () => {
    expect(refusal(() => buildFolder(input({}))).reason).toBe("server_toml_missing");
  });

  it("a server.toml that does not validate", () => {
    const err = refusal(() => buildFolder(input({ serverToml: 'name = "billing"\n' })));
    expect(err.reason).toBe("server_toml_invalid");
  });

  it("a server.toml that names another server", () => {
    const err = refusal(() =>
      buildFolder(input({ server: "payments", serverToml: fixture("servers/billing/server.toml") })),
    );
    expect(err.reason).toBe("server_name_mismatch");
    expect(err.message).toContain("server.toml names billing, and the draft is for payments.");
  });

  it("a gRPC server with no descriptors", () => {
    const err = refusal(() => buildFolder(input({ server: "ledger", serverToml: grpcServerToml("ledger") })));
    expect(err.reason).toBe("source_required");
    expect(err.message).toContain("ledger is a gRPC server");
  });

  it("a new MCP server with no source", () => {
    const err = refusal(() =>
      buildFolder(input({ server: "stripe", serverToml: fixture("servers/stripe/server.toml") })),
    );
    expect(err.reason).toBe("source_required");
    expect(err.message).toContain("stripe has no tools.lock.json yet");
  });

  it("an import with no source", () => {
    const err = refusal(() =>
      buildFolder(
        input({ ops: [imp("getCharge"), classify("getCharge", READ_TENANT)], production: billingProduction() }),
      ),
    );
    expect(err.reason).toBe("source_required");
  });

  it("an MCP source for a server built from a definition", async () => {
    const source = mcpSource(stripeTools());
    const imported = await importSource(source);
    const err = refusal(() => buildFolder(input({ source, imported, production: billingProduction() })));
    expect(err.reason).toBe("source_invalid");
    expect(err.message).toBe(
      "server.toml builds billing from a openapi definition, and the draft's source is an MCP server.",
    );
  });

  it("an import of a tool the source does not offer", async () => {
    const built = await stripeInput(mcpSource(stripeTools()), [
      imp("delete_account"),
      classify("delete_account", READ_THIRD_PARTY),
    ]);
    const err = refusal(() => buildFolder(built));
    expect(err.reason).toBe("tool_not_offered");
    expect(err.message).toContain("delete_account");
  });

  it("an edit to a tool neither tools.toml nor the source holds", async () => {
    const built = await stripeInput(mcpSource(stripeTools()), [classify("delete_account", READ_THIRD_PARTY)]);
    const err = refusal(() => buildFolder(built));
    expect(err.reason).toBe("tool_not_found");
    expect(err.message).toContain("delete_account");
  });

  it("a saved test that carries a credential header, and names the header without its value", () => {
    const request = JSON.stringify({
      method: "GET",
      path: "/customers/cus_81/charges",
      headers: { Authorization: "Bearer sk_live_51" },
    });
    const err = refusal(() => buildFolder(input({ ops: [testOp({ request })], production: billingProduction() })));
    expect(err.reason).toBe("test_holds_credential");
    expect(err.message).toContain("carries a authorization header");
    expect(err.message).not.toContain("sk_live_51");
  });

  it("a saved test whose arguments are not a JSON object", () => {
    const err = refusal(() => buildFolder(input({ ops: [testOp({ args: "[1]" })], production: billingProduction() })));
    expect(err.reason).toBe("test_invalid");
    expect(err.message).toContain("its arguments are not a JSON object.");
  });
});

// ── Paths ────────────────────────────────────────────────────────────────────

describe("folderCommit", () => {
  it("writes each changed file, deletes each managed file the folder drops, and leaves other files", () => {
    const current = new Map([
      ["server.toml", "a\n"],
      ["tests/calls.jsonl", "{}\n"],
      ["tests/selection.jsonl", "{}\n"],
    ]);
    const desired = new Map([
      ["server.toml", "a\n"],
      ["tools.toml", "t\n"],
    ]);
    expect(folderCommit("billing", desired, current)).toStrictEqual([
      { path: "tools/servers/billing/tests/calls.jsonl", content: null },
      { path: "tools/servers/billing/tools.toml", content: "t\n" },
    ]);
  });
});

describe("folder paths", () => {
  it("manages the files Review writes and nothing else", () => {
    const managed = [
      "server.toml",
      "tools.toml",
      "tools.lock.json",
      "tests/calls.jsonl",
      "openapi.yaml",
      "overlay.yaml",
      "schema.graphql",
      "proto/a/b.proto",
    ];
    for (const path of managed) expect(isManagedPath(path)).toBe(true);
    for (const path of ["tests/selection.jsonl", "README.md", "tests/other.jsonl"]) {
      expect(isManagedPath(path)).toBe(false);
    }
    expect(isDefinitionPath("proto/ledger.proto")).toBe(true);
    expect(isDefinitionPath("server.toml")).toBe(false);
  });

  it("accepts only relative paths inside the folder", () => {
    expect(isFolderPath("proto/ledger.proto")).toBe(true);
    for (const path of ["", "/proto/a.proto", "proto//a.proto", "../a.proto", "proto/../a.proto", "./a.proto", "proto\\a.proto"]) {
      expect(isFolderPath(path)).toBe(false);
    }
  });
});
