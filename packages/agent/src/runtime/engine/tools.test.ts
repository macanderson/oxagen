import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import {
  UnknownToolError,
  executeToolRequest,
  renderToolResult,
  schemaOnlyTools,
  toToolContracts,
} from "./tools";

describe("toToolContracts", () => {
  it("declares each tool with its schema and its governance facts", async () => {
    const contracts = await toToolContracts(
      {
        list_nodes: tool({
          description: "List nodes",
          inputSchema: z.object({ limit: z.number() }),
          execute: async () => [],
        }),
        raw_json: {
          description: "Raw",
          inputSchema: jsonSchema({
            type: "object",
            properties: { q: { type: "string" } },
          }),
        } as never,
      },
      {
        list_nodes: {
          riskLevel: "low",
          requiresApproval: false,
          readOnly: true,
        },
        raw_json: {
          riskLevel: "high",
          requiresApproval: true,
          readOnly: false,
        },
      },
    );
    expect(contracts).toHaveLength(2);
    expect(contracts[0]).toMatchObject({
      version: 1,
      risk: "low",
      requires_approval: false,
      provenance: "declared",
      schema: {
        name: "list_nodes",
        description: "List nodes",
        read_only: true,
      },
    });
    expect(
      (contracts[0]!.schema.input_schema as { properties: object }).properties,
    ).toHaveProperty("limit");
    expect(contracts[1]).toMatchObject({
      risk: "high",
      requires_approval: true,
      schema: {
        name: "raw_json",
        read_only: false,
        input_schema: { type: "object" },
      },
    });
  });

  it("declares a tool with no governance entry as high risk and mutating", async () => {
    const [c] = await toToolContracts(
      { x: { description: "d", inputSchema: { type: "object" } } as never },
      {},
    );
    expect(c).toMatchObject({
      risk: "high",
      requires_approval: false,
      schema: { read_only: false },
    });
  });
});

describe("schemaOnlyTools", () => {
  it("strips execute and keeps everything else", () => {
    const set = {
      t: {
        description: "d",
        inputSchema: { type: "object" },
        execute: async () => 1,
      },
    } as never;
    const stripped = schemaOnlyTools(set) as Record<
      string,
      Record<string, unknown>
    >;
    expect(stripped.t).toEqual({
      description: "d",
      inputSchema: { type: "object" },
    });
  });
});

describe("executeToolRequest", () => {
  it("runs the tool's execute with the engine's request id and returns its text and raw value", async () => {
    const execute = vi.fn(async () => ({ rows: 3 }));
    const result = await executeToolRequest(
      { t: { execute } as never },
      "t",
      { a: 1 },
      { toolCallId: "tool-1-0" },
    );
    expect(execute).toHaveBeenCalledWith(
      { a: 1 },
      expect.objectContaining({ toolCallId: "tool-1-0", messages: [] }),
    );
    expect(result).toEqual({
      output: { ok: { content: '{"rows":3}' } },
      raw: { rows: 3 },
      failed: false,
    });
  });

  it("turns a policy refusal into the refused_by_policy class and any other throw into a plain error", async () => {
    const refused = await executeToolRequest(
      {
        t: {
          execute: async () => {
            throw new Error("Tool blocked by workspace policy: nope");
          },
        } as never,
      },
      "t",
      {},
      { toolCallId: "r" },
    );
    expect(refused.output).toEqual({
      error: {
        message: "Tool blocked by workspace policy: nope",
        class: "refused_by_policy",
      },
    });
    expect(refused.failed).toBe(true);
    const failed = await executeToolRequest(
      {
        t: {
          execute: async () => {
            throw new Error("upstream 500");
          },
        } as never,
      },
      "t",
      {},
      { toolCallId: "r" },
    );
    expect(failed.output).toEqual({ error: { message: "upstream 500" } });
  });

  it("throws UnknownToolError for a tool the turn did not advertise", async () => {
    await expect(
      executeToolRequest({}, "ghost", {}, { toolCallId: "x" }),
    ).rejects.toBeInstanceOf(UnknownToolError);
    await expect(
      executeToolRequest({ t: {} as never }, "t", {}, { toolCallId: "x" }),
    ).rejects.toBeInstanceOf(UnknownToolError);
  });
});

describe("renderToolResult", () => {
  it("passes strings through and renders everything else as JSON", () => {
    expect(renderToolResult("plain")).toBe("plain");
    expect(renderToolResult(undefined)).toBe("");
    expect(renderToolResult({ a: [1] })).toBe('{"a":[1]}');
  });
});
