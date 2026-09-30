/**
 * Contract test for list_studio_tools (lane M10, #4682).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  studioServerToolSchema,
  toolStudioToolsList,
} from "./tool.studio.tools.list";

const imported = {
  name: "search_entries",
  key: "search",
  state: "imported",
  description: "Search the ledger.",
  importedDescription: "Find ledger entries by text.",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
  tokens: 64,
  classification: {
    risk: "low",
    sideEffect: "read",
    egress: "third_party",
    impacts: [],
    confirmed: true,
    basis: null,
  },
  snapshotId: "snap_1",
  capturedAt: "2026-09-29T10:00:00.000Z",
  withheld: false,
} as const;

const available = {
  name: "delete_entry",
  key: null,
  state: "available",
  description: null,
  importedDescription: null,
  inputSchema: { type: "object" },
  annotations: null,
  tokens: 40,
  classification: {
    risk: "high",
    sideEffect: "irreversible",
    egress: "third_party",
    impacts: [],
    confirmed: false,
    basis: "fail_safe",
  },
  snapshotId: "snap_2",
  capturedAt: "2026-09-29T10:00:00.000Z",
  withheld: true,
} as const;

const output = {
  server: "ledger",
  mcpServerId: "mcs_1",
  snapshotId: "snap_2",
  capturedAt: "2026-09-29T10:00:00.000Z",
  exposure: { mode: "direct", budget: 8000 },
  tokens: { definitions: 64, budget: 8000 },
  imported: 1,
  offered: 2,
  searchRecommended: false,
  compileError: null,
  tools: [imported, available],
} as const;

describe("list_studio_tools is registered as declared", () => {
  it("is scoped, reads only, and skips the billing gate", () => {
    const cap = getCapability("list_studio_tools");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
  });

  it("lets a workspace viewer read", () => {
    const cap = getCapability("list_studio_tools");
    expect(cap?.defaultRoles?.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });
});

describe("list_studio_tools", () => {
  it("accepts a server name and refuses anything else", () => {
    expect(toolStudioToolsList.input.parse({ server: "ledger" })).toEqual({
      server: "ledger",
    });
    for (const input of [
      {},
      { server: "Ledger" },
      { server: "builtin" },
      { server: "ledger", state: "imported" },
    ]) {
      expect(toolStudioToolsList.input.safeParse(input).success).toBe(false);
    }
  });

  it("returns imported and available rows with the token totals", () => {
    expect(toolStudioToolsList.output.parse(output)).toEqual(output);
  });

  it("carries a compile error with no token total", () => {
    const broken = {
      ...output,
      tokens: { definitions: null, budget: 8000 },
      compileError: "tools.toml: search imports an unknown tool",
      tools: [{ ...imported, tokens: null }],
    };
    expect(toolStudioToolsList.output.parse(broken)).toEqual(broken);
  });

  it("refuses an unknown state, basis, or a zero budget", () => {
    expect(
      studioServerToolSchema.safeParse({ ...imported, state: "removed" })
        .success,
    ).toBe(false);
    expect(
      studioServerToolSchema.safeParse({
        ...available,
        classification: { ...available.classification, basis: "guess" },
      }).success,
    ).toBe(false);
    expect(
      toolStudioToolsList.output.safeParse({
        ...output,
        exposure: { mode: "direct", budget: 0 },
      }).success,
    ).toBe(false);
  });
});
