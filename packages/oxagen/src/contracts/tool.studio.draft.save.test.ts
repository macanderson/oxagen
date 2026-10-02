/**
 * Contract test for save_studio_draft (lane M11, ADR-224).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  STUDIO_DRAFT_OPS_BYTES_MAX,
  STUDIO_DRAFT_OPS_MAX,
  STUDIO_MAX_RESULT_BYTES,
  STUDIO_SERVER_TOML_MAX,
  studioSourceBytes,
  toolStudioDraftSave,
  toolStudioDraftSaveInputObject,
} from "./tool.studio.draft.save";

describe("save_studio_draft is registered as declared", () => {
  it("is scoped, mutates, skips the billing gate, and audits the server folder", () => {
    const cap = getCapability("save_studio_draft");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.audit).toEqual({
      targetKind: "tool_server_folder",
      targetIdField: "server",
    });
  });
});

describe("save_studio_draft input", () => {
  it("accepts a new draft with every kind of edit", () => {
    const input = {
      server: "ledger",
      ops: [
        { kind: "import", tool: "search" },
        { kind: "remove", tool: "delete_all" },
        {
          kind: "classify",
          tool: "search",
          risk: "low",
          sideEffect: "read",
          egress: "third_party",
          impacts: ["reads_customer_data"],
        },
        { kind: "describe", tool: "search", description: "Search the ledger" },
        {
          kind: "test",
          tool: "search",
          environment: "staging",
          args: "{}",
          request: "{}",
          raw: "{}",
          shaped: "{}",
        },
        { kind: "cap", tool: "search", maxResultBytes: 16_000, paging: true },
        { kind: "cap", tool: "list", maxResultBytes: 4_000 },
        { kind: "expose", mode: "search" },
      ],
      revision: 0,
    };
    expect(toolStudioDraftSave.input.parse(input)).toEqual(input);
  });

  it("refuses a cap outside tools.toml's range and an exposure mode server.toml does not take", () => {
    for (const op of [
      { kind: "cap", tool: "search", maxResultBytes: 0 },
      { kind: "cap", tool: "search", maxResultBytes: STUDIO_MAX_RESULT_BYTES + 1 },
      { kind: "cap", tool: "search", maxResultBytes: 1.5 },
      { kind: "cap", tool: "search", maxResultBytes: 4_000, paging: "cursor" },
      { kind: "cap", maxResultBytes: 4_000 },
      { kind: "expose", mode: "hidden" },
      { kind: "expose", mode: "search", tool: "search" },
    ]) {
      expect(
        toolStudioDraftSave.input.safeParse({ server: "ledger", ops: [op] }).success,
      ).toBe(false);
    }
  });

  it("accepts each source type", () => {
    for (const source of [
      { type: "mcp", lockSource: { remote: {} }, tools: [{ name: "search" }] },
      {
        type: "openapi",
        files: [{ path: "openapi.yaml", text: "openapi: 3.1.0" }],
        entry: "openapi.yaml",
      },
      { type: "graphql", sdl: "type Query { a: Int }" },
      { type: "graphql", introspection: { __schema: {} } },
      { type: "grpc", files: [{ path: "proto/a.proto", text: "syntax = \"proto3\";" }] },
      { type: "grpc", reflection: ["Cg=="] },
    ]) {
      expect(
        toolStudioDraftSave.input.safeParse({ server: "ledger", ops: [], source })
          .success,
      ).toBe(true);
    }
  });

  it("refuses the built-in server, a malformed name, and an unknown field", () => {
    for (const input of [
      { server: "builtin", ops: [] },
      { server: "Ledger", ops: [] },
      { server: "ledger", ops: [], extra: true },
    ]) {
      expect(toolStudioDraftSave.input.safeParse(input).success).toBe(false);
    }
  });

  it("refuses an edit it does not know and a commit that is not hex", () => {
    expect(
      toolStudioDraftSave.input.safeParse({
        server: "ledger",
        ops: [{ kind: "rename", tool: "search" }],
      }).success,
    ).toBe(false);
    expect(
      toolStudioDraftSave.input.safeParse({
        server: "ledger",
        ops: [],
        source: { type: "graphql", sdl: "type Query { a: Int }", commit: "main" },
      }).success,
    ).toBe(false);
  });

  it("refuses more edits than a draft holds", () => {
    const ops = Array.from({ length: STUDIO_DRAFT_OPS_MAX + 1 }, () => ({
      kind: "import" as const,
      tool: "search",
    }));
    expect(
      toolStudioDraftSave.input.safeParse({ server: "ledger", ops }).success,
    ).toBe(false);
  });

  it("refuses edits larger than a draft holds, counted in UTF-8 bytes", () => {
    // Each test edit at its field limits is about 640 KiB, so 12 fit under 8
    // MiB and 13 do not.
    const test = {
      kind: "test" as const,
      tool: "search",
      environment: "staging",
      args: "a".repeat(65_536),
      request: "r".repeat(65_536),
      raw: "w".repeat(262_144),
      shaped: "s".repeat(262_144),
    };
    const under = Array.from({ length: 12 }, () => test);
    const over = Array.from({ length: 13 }, () => test);
    expect(JSON.stringify(under).length).toBeLessThan(STUDIO_DRAFT_OPS_BYTES_MAX);
    expect(JSON.stringify(over).length).toBeGreaterThan(STUDIO_DRAFT_OPS_BYTES_MAX);

    expect(
      toolStudioDraftSave.input.safeParse({ server: "ledger", ops: under }).success,
    ).toBe(true);
    const refused = toolStudioDraftSave.input.safeParse({ server: "ledger", ops: over });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path)).toEqual([["ops"]]);
  });

  it("measures server.toml in UTF-8 bytes, the unit the table checks", () => {
    // "é" is one UTF-16 unit and two UTF-8 bytes.
    const fits = `# ${"é".repeat(STUDIO_SERVER_TOML_MAX / 2 - 2)}`;
    const over = `# ${"é".repeat(STUDIO_SERVER_TOML_MAX / 2)}`;
    expect(new TextEncoder().encode(fits).length).toBe(STUDIO_SERVER_TOML_MAX - 2);
    expect(over.length).toBeLessThan(STUDIO_SERVER_TOML_MAX);

    expect(
      toolStudioDraftSave.input.safeParse({ server: "ledger", ops: [], serverToml: fits }).success,
    ).toBe(true);
    const refused = toolStudioDraftSave.input.safeParse({
      server: "ledger",
      ops: [],
      serverToml: over,
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path)).toEqual([["serverToml"]]);
  });

  it("exposes the base object's fields for the MCP tool", () => {
    expect(Object.keys(toolStudioDraftSaveInputObject.shape).sort()).toEqual([
      "ops",
      "revision",
      "server",
      "serverId",
      "serverToml",
      "source",
    ]);
  });

  it("measures a source as its UTF-8 JSON size", () => {
    const source = { type: "graphql" as const, sdl: "type Query { é: Int }" };
    expect(studioSourceBytes(source)).toBe(
      new TextEncoder().encode(JSON.stringify(source)).length,
    );
  });
});
