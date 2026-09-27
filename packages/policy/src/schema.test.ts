import { beforeAll, describe, expect, it } from "vitest";
import type { CedarToolEntry } from "@oxagen/tacho";
import { requireCedarRuntime, type CedarRuntime } from "@oxagen/tacho/policy";
import {
  MAX_TOOL_ARGS,
  SCHEMA_PATH,
  argTypeOf,
  cedarString,
  cedarTools,
  isCedarIdentifier,
  writeCedarSchema,
  type ManifestToolLike,
  type ToolManifestLike,
} from "./schema";
import { SPEC_TOOLS } from "./testing";

let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

function manifestTool(
  name: string,
  properties: Record<string, unknown>,
  classification: ManifestToolLike["classification"] = {
    risk: "low",
    side_effect: "read",
    egress: "org_tenant",
    impacts: [],
  },
): ManifestToolLike {
  return { name, version: 1, definition: { inputSchema: { type: "object", properties } }, classification };
}

function entry(args: CedarToolEntry["args"]): CedarToolEntry {
  return { version: 1, risk: "low", side_effect: "read", egress: "org_tenant", impacts: [], args };
}

describe("argTypeOf", () => {
  it.each([
    [{ type: "string" }, "String"],
    [{ type: "integer", minimum: 1 }, "Long"],
    [{ type: "boolean" }, "Bool"],
    [{ type: ["string", "null"] }, "String"],
    [{ type: "array", items: { type: "string" } }, "Set<String>"],
    [{ type: "array", items: { type: "integer" } }, "Set<Long>"],
    [{ enum: ["open", "closed"] }, "String"],
    [{ enum: [1, 2, 3] }, "Long"],
    [{ enum: [true, false] }, "Bool"],
    [{ const: "refund" }, "String"],
  ])("types %j as %s", (schema, type) => {
    expect(argTypeOf(schema)).toBe(type);
  });

  it.each([
    [undefined, "The argument has no JSON Schema."],
    [["string"], "The argument has no JSON Schema."],
    [{}, "The argument has no single JSON type."],
    [{ type: ["string", "integer"] }, "The argument has no single JSON type."],
    [{ enum: ["a", 1] }, "The argument has no single JSON type."],
    [{ enum: [1.5] }, "The argument has no single JSON type."],
    [{ type: "array", items: { type: "object" } }, "Cedar reads a list of strings or whole numbers only."],
    [{ type: "array" }, "Cedar reads a list of strings or whole numbers only."],
    [{ type: "number" }, "Cedar holds whole numbers only. Declare the argument an integer."],
    [{ type: "object" }, "Cedar cannot read an argument of type object."],
  ])("gives a reason for %j", (schema, reason) => {
    expect(argTypeOf(schema)).toEqual({ reason });
  });
});

describe("cedarTools", () => {
  it("reads each tool's classification and the arguments Cedar can type", () => {
    const manifest: ToolManifestLike = {
      servers: [
        {
          name: "billing",
          tools: {
            create_refund: manifestTool(
              "billing__create_refund",
              {
                charge_id: { type: "string" },
                amount: { type: "integer", minimum: 1 },
                "X-Request-Source": { type: "string" },
                ratio: { type: "number" },
              },
              { risk: "high", side_effect: "irreversible", egress: "org_tenant", impacts: ["moves_money"] },
            ),
          },
        },
      ],
    };
    const { tools, skipped } = cedarTools(manifest);
    expect(tools).toEqual({
      billing__create_refund: {
        version: 1,
        risk: "high",
        side_effect: "irreversible",
        egress: "org_tenant",
        impacts: ["moves_money"],
        args: { "X-Request-Source": "String", amount: "Long", charge_id: "String" },
      },
    });
    expect(skipped).toEqual([
      {
        action: "billing__create_refund",
        arg: "ratio",
        reason: "Cedar holds whole numbers only. Declare the argument an integer.",
      },
    ]);
  });

  it("skips a tool on a server named builtin", () => {
    const { tools, skipped } = cedarTools({
      servers: [{ name: "builtin", tools: { shell: manifestTool("builtin__shell", {}) } }],
    });
    expect(tools).toEqual({});
    expect(skipped).toEqual([
      { action: "builtin__shell", reason: "The builtin server name belongs to Oxagen's built-in tools." },
    ]);
  });

  it("reads a tool with no properties as one with no arguments", () => {
    const tool: ManifestToolLike = {
      ...manifestTool("billing__ping", {}),
      definition: { inputSchema: { type: "object" } },
    };
    const { tools } = cedarTools({ servers: [{ name: "billing", tools: { ping: tool } }] });
    expect(tools["billing__ping"]?.args).toEqual({});
  });

  it(`reads the first ${MAX_TOOL_ARGS} arguments of a tool`, () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_TOOL_ARGS + 1 }, (_, i) => [`a${String(i).padStart(3, "0")}`, { type: "string" }]),
    );
    const { tools, skipped } = cedarTools({
      servers: [{ name: "wide", tools: { call: manifestTool("wide__call", properties) } }],
    });
    expect(Object.keys(tools["wide__call"]?.args ?? {})).toHaveLength(MAX_TOOL_ARGS);
    expect(skipped).toEqual([
      {
        action: "wide__call",
        arg: `a${MAX_TOOL_ARGS}`,
        reason: `Cedar reads the first ${MAX_TOOL_ARGS} arguments of a tool.`,
      },
    ]);
  });
});

describe("cedarString and isCedarIdentifier", () => {
  it("escapes every special character", () => {
    expect(cedarString('a"b\\c\n\r\t\0\u0001\u007f')).toBe('"a\\"b\\\\c\\n\\r\\t\\0\\u{1}\\u{7f}"');
    expect(cedarString("plain")).toBe('"plain"');
  });

  it.each([
    ["amount", true],
    ["_private", true],
    ["amount_cents2", true],
    ["X-Request-Source", false],
    ["1st", false],
    ["", false],
    ["type", false],
    ["context", false],
    ["like", false],
    ["__cedar", false],
  ])("reads %j as an identifier: %s", (name, expected) => {
    expect(isCedarIdentifier(name)).toBe(expected);
  });
});

describe("writeCedarSchema", () => {
  it("writes a schema Cedar parses", () => {
    const text = writeCedarSchema(SPEC_TOOLS);
    expect(runtime.checkParseSchema(text)).toEqual({ type: "success" });
    expect(SCHEMA_PATH).toBe("policy/schema.cedarschema");
  });

  it("quotes an argument name Cedar cannot read bare", () => {
    const text = writeCedarSchema({
      billing__create_refund: entry({ "X-Request-Source": "String", type: "String", amount: "Long" }),
    });
    expect(text).toContain('  "X-Request-Source"?: String,');
    expect(text).toContain('  "type"?: String,');
    expect(text).toContain("  amount?: Long,");
    expect(runtime.checkParseSchema(text)).toEqual({ type: "success" });
  });

  it("gives a tool that types an argument differently its own Args and Call", () => {
    const text = writeCedarSchema({
      a__first: entry({ amount: "Long" }),
      b__second: entry({ amount: "String" }),
      c__third: entry({ path: "Long" }),
    });
    expect(text).toContain("// b__second types an argument differently from the tools above.");
    expect(text).toContain("type Args_1 = {\n  amount?: String\n};");
    expect(text).toContain("type Call_1 = {");
    expect(text).toContain('action "b__second"\n  appliesTo {');
    expect(text).toContain("context: Call_1");
    expect(text).toContain("// c__third types an argument differently from the tools above.");
    expect(text).toContain("type Args_2 = {\n  path?: Long\n};");
    expect(text).toMatch(/type Args = \{[^}]*amount\?: Long/);
    expect(runtime.checkParseSchema(text)).toEqual({ type: "success" });
  });

  it("writes the same text whatever order the tools arrive in", () => {
    const forward = writeCedarSchema({ a__first: entry({ x: "Long" }), b__second: entry({ y: "String" }) });
    const backward = writeCedarSchema({ b__second: entry({ y: "String" }), a__first: entry({ x: "Long" }) });
    expect(backward).toBe(forward);
  });

  it("declares every built-in action with no imported tools", () => {
    const text = writeCedarSchema({});
    for (const name of ["shell", "read_file", "search_files", "write_file", "web_fetch", "web_search"]) {
      expect(text).toContain(`"builtin__${name}"`);
    }
    expect(text).not.toContain("Args_1");
    expect(runtime.checkParseSchema(text)).toEqual({ type: "success" });
  });
});
