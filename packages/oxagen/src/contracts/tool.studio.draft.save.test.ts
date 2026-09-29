/**
 * Contract test for save_studio_draft (lane M11, ADR-224).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  STUDIO_DRAFT_OPS_MAX,
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
      ],
      revision: 0,
    };
    expect(toolStudioDraftSave.input.parse(input)).toEqual(input);
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
