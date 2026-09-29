// source.test.ts: importSource, the draft's source imported again at Review.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import type { StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { NotBuiltError } from "@oxagen/mcp-studio";
import { importSource } from "./source";

/** A file under packages/mcp-studio/fixtures, read when a test asks for it. */
function fixture(path: string): string {
  return readFileSync(new URL(`../../../../mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
}

function fixtureJson<T>(path: string): T {
  return JSON.parse(fixture(path)) as T;
}

const COMMIT = "4be91d2c0a7e5f3b9d18e6a2c4f0b7d95e3a1c86";

function stripeLockSource(): Record<string, unknown> {
  return fixtureJson<{ source: Record<string, unknown> }>("servers/stripe/tools.lock.json").source;
}

function stripeTools(): Record<string, unknown>[] {
  return fixtureJson<{ tools: Record<string, unknown>[] }>("sources/stripe/tools-list.json").tools;
}

async function refusal(source: StudioSource, grpc?: Parameters<typeof importSource>[1]): Promise<HandlerError> {
  try {
    await importSource(source, grpc);
  } catch (err) {
    if (err instanceof HandlerError) return err;
    throw err;
  }
  throw new Error("importSource did not refuse.");
}

describe("importSource", () => {
  it("offers each tool of an MCP server's tools/list result and keeps the lock's source", async () => {
    const imported = await importSource({ type: "mcp", lockSource: stripeLockSource(), tools: stripeTools() });

    expect(imported.type).toBe("mcp");
    expect(imported.offered.map((tool) => tool.name)).toStrictEqual(["create_refund", "list_charges", "create_customer"]);
    expect(imported.offered[0]?.request).toStrictEqual({ kind: "mcp", tool: "create_refund" });
    expect(imported.mcpLockSource).toStrictEqual(stripeLockSource());
    expect(imported.files).toStrictEqual([]);
    expect(imported.documentHash).toBeNull();
  });

  it("vendors an OpenAPI definition as openapi.yaml, with its hash and commit", async () => {
    const text = fixture("servers/billing/openapi.yaml");
    const imported = await importSource({
      type: "openapi",
      files: [{ path: "openapi.yaml", text }],
      entry: "openapi.yaml",
      commit: COMMIT,
    });

    expect(imported.type).toBe("openapi");
    expect(imported.files.map((file) => file.path)).toStrictEqual(["openapi.yaml"]);
    expect(imported.documentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(imported.commit).toBe(COMMIT);
    expect(imported.mcpLockSource).toBeNull();
    expect(Object.keys(imported.securitySchemes)).toContain("oauth");
  });

  it("vendors a GraphQL SDL as schema.graphql", async () => {
    const sdl = fixture("graphql/schema.graphql");
    const imported = await importSource({ type: "graphql", sdl });

    expect(imported.files).toStrictEqual([{ path: "schema.graphql", text: sdl }]);
    expect(imported.offered.length).toBeGreaterThan(0);
    expect(imported.commit).toBeUndefined();
  });
});

describe("importSource refuses", () => {
  it("a gRPC definition while its importer has not shipped", async () => {
    const err = await refusal(
      { type: "grpc", files: [{ path: "proto/ledger.proto", text: fixture("grpc/ledger.proto") }] },
      async () => {
        throw new NotBuiltError("grpc");
      },
    );
    expect(err.reason).toBe("importer_not_built");
    expect(err.message).toBe("Oxagen cannot import a grpc definition yet: the grpc importer has not shipped.");
  });

  it("a proto file outside proto/", async () => {
    const err = await refusal({ type: "grpc", files: [{ path: "ledger.proto", text: fixture("grpc/ledger.proto") }] });
    expect(err.reason).toBe("source_invalid");
    expect(err.message).toBe(
      "ledger.proto is outside proto/. A gRPC definition's files live under proto/ in the server's folder.",
    );
  });

  it("a tools/list result that names one tool twice", async () => {
    const [first] = stripeTools();
    const err = await refusal({ type: "mcp", lockSource: stripeLockSource(), tools: [first ?? {}, first ?? {}] });
    expect(err.reason).toBe("source_invalid");
    expect(err.message).toBe("The server's tools/list result names create_refund twice.");
  });

  it("a tools/list entry that is not an MCP tool", async () => {
    const err = await refusal({ type: "mcp", lockSource: stripeLockSource(), tools: [{ name: "" }] });
    expect(err.reason).toBe("source_invalid");
    expect(err.message).toBe("Tool 1 of the server's tools/list result is not an MCP tool.");
  });

  it("a lock source tools.lock.json cannot record", async () => {
    const err = await refusal({ type: "mcp", lockSource: { type: "ftp" }, tools: stripeTools() });
    expect(err.reason).toBe("source_invalid");
    expect(err.message).toContain("is not a remote, registry, or local source");
  });

  it("OpenAPI files that hold no root document", async () => {
    const err = await refusal({
      type: "openapi",
      files: [{ path: "paths/items.yaml", text: "get: {}\n" }],
      entry: "openapi.yaml",
    });
    expect(err.reason).toBe("source_invalid");
    expect(err.message).toBe(
      "The OpenAPI files hold no openapi.yaml, which the source names as the root document.",
    );
  });

  it("an SDL that does not describe a schema", async () => {
    const err = await refusal({ type: "graphql", sdl: "type {" });
    expect(err.reason).toBe("source_invalid");
    expect(err.message).toMatch(/^The graphql definition does not import\. /);
  });
});
