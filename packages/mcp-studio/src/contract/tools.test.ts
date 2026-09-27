// mcp-tools/v1: one entry per imported tool, with its classification,
// shaping, and the cross-field checks that tie an entry to its source.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toJsonSchema } from "@oxagen/oxagen/steering-repo/json-schema";
import { MAX_RESULT_BYTES_LIMIT, mcpToolsSchema, toolsEntrySchema } from "./tools";

interface Issue {
  path: string;
  message: string;
}

/** Every issue zod reports for a value, with its path joined by dots. */
function issues(schema: z.ZodTypeAny, value: unknown): Issue[] {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

const classified = { risk: "high", side_effect: "irreversible", egress: "third_party" };

describe("valid entries", () => {
  const entries: Array<[string, Record<string, unknown>]> = [
    ["a bare classification", classified],
    ["an MCP tool renamed from its hyphenated name", { ...classified, upstream: "create-refund" }],
    [
      "an OpenAPI tool with every shaping key",
      {
        ...classified,
        operation: "createRefund",
        impacts: ["moves_money"],
        measures: {
          amount: { path: "$.amount", type: "money", currency_path: "$.currency" },
          charges: { path: "$.charges", type: "count", unit: "charges" },
        },
        data_classes: ["payment_card"],
        description: "Refund a charge, in full or in part.",
        hide: ["X-Request-Id"],
        fixed: { reason: "requested_by_customer" },
        defaults: { amount: 100 },
        rename: { charge_id: "charge" },
        select: ["id", "status", "refunds[].id"],
        redact: ["card.number"],
        max_result_bytes: 4096,
        paginate: "cursor",
        max_items: 500,
        idempotency_header: "Idempotency-Key",
      },
    ],
    [
      "a GraphQL connection",
      {
        ...classified,
        field: "Query.issues",
        selection: "{ id title }",
        paginate: "connection",
        max_items: 200,
      },
    ],
    [
      "a gRPC server stream",
      { ...classified, method: "a_intel.ledger.v1.Ledger/ListEntries", deadline_ms: 5000, max_items: 100 },
    ],
  ];

  it.each(entries)("accept %s", (_label, entry) => {
    expect(issues(toolsEntrySchema, entry)).toStrictEqual([]);
  });

  it("accept a file with no tools and one with defaults", () => {
    expect(issues(mcpToolsSchema, { schema: "mcp-tools/v1" })).toStrictEqual([]);
    expect(
      issues(mcpToolsSchema, {
        schema: "mcp-tools/v1",
        defaults: { max_result_bytes: MAX_RESULT_BYTES_LIMIT },
        tools: { create_refund: classified },
      }),
    ).toStrictEqual([]);
  });
});

describe("cross-field checks", () => {
  it("refuse two ways of naming the upstream operation", () => {
    expect(issues(toolsEntrySchema, { ...classified, upstream: "create_refund", operation: "createRefund" })).toStrictEqual(
      [{ path: "operation", message: "set only one of upstream, operation, field, method" }],
    );
  });

  const needs: Array<[string, Record<string, unknown>, Issue]> = [
    [
      "selection without field",
      { selection: "{ id }" },
      { path: "field", message: "field is required when selection is set" },
    ],
    [
      "idempotency_header without operation",
      { idempotency_header: "Idempotency-Key" },
      { path: "operation", message: "operation is required when idempotency_header is set" },
    ],
    [
      "deadline_ms without method",
      { deadline_ms: 1000 },
      { path: "method", message: "method is required when deadline_ms is set" },
    ],
    [
      "connection paging without field",
      { paginate: "connection" },
      { path: "field", message: "field is required when paginate is connection" },
    ],
    [
      "cursor paging without operation",
      { paginate: "cursor" },
      { path: "operation", message: "operation is required when paginate is cursor" },
    ],
    [
      "page paging without operation",
      { paginate: "page" },
      { path: "operation", message: "operation is required when paginate is page" },
    ],
    [
      "offset paging without operation",
      { paginate: "offset" },
      { path: "operation", message: "operation is required when paginate is offset" },
    ],
    [
      "max_items with nothing to page",
      { max_items: 50 },
      { path: "max_items", message: "max_items needs paginate, or method for a gRPC server stream" },
    ],
  ];

  it.each(needs)("refuse %s", (_label, keys, issue) => {
    expect(issues(toolsEntrySchema, { ...classified, ...keys })).toStrictEqual([issue]);
  });

  it("refuse a money measure with no currency path", () => {
    const entry = { ...classified, measures: { amount: { path: "$.amount", type: "money" } } };
    expect(issues(toolsEntrySchema, entry)).toStrictEqual([
      { path: "measures.amount.currency_path", message: "currency_path is required when type is money" },
    ]);
  });

  it("refuse a repeated impact", () => {
    const entry = { ...classified, impacts: ["moves_money", "moves_money"] };
    expect(issues(toolsEntrySchema, entry)).toStrictEqual([
      { path: "impacts.1", message: 'impacts lists "moves_money" twice' },
    ]);
  });

  it("report a check on the tool that breaks it", () => {
    const file = { schema: "mcp-tools/v1", tools: { list_charges: { ...classified, max_items: 50 } } };
    expect(issues(mcpToolsSchema, file)).toStrictEqual([
      {
        path: "tools.list_charges.max_items",
        message: "max_items needs paginate, or method for a gRPC server stream",
      },
    ]);
  });

  it("publish every check in the JSON Schema", () => {
    const json = toJsonSchema(toolsEntrySchema) as { allOf: unknown[] };
    expect(json.allOf).toHaveLength(9);
    expect(json.allOf).toContainEqual({ dependentRequired: { selection: ["field"] } });
    expect(json.allOf).toContainEqual({
      if: { required: ["max_items"] },
      then: { anyOf: [{ required: ["paginate"] }, { required: ["method"] }] },
    });
  });
});

describe("field values", () => {
  it("refuse a grade outside today's enum", () => {
    expect(issues(toolsEntrySchema, { ...classified, risk: "severe" })).toStrictEqual([
      {
        path: "risk",
        message: "Invalid enum value. Expected 'low' | 'medium' | 'high' | 'critical', received 'severe'",
      },
    ]);
  });

  it("refuse a renamed input that is not an identifier", () => {
    expect(issues(toolsEntrySchema, { ...classified, rename: { charge_id: "charge id" } })).toContainEqual({
      path: "rename.charge_id",
      message: "a renamed input is letters, digits, and underscores",
    });
  });

  it("refuse a result path that is not dotted names", () => {
    expect(issues(toolsEntrySchema, { ...classified, select: ["data["] })).toContainEqual({
      path: "select.0",
      message: "a result path is dotted field names, with [] after an array, such as data[].id",
    });
  });

  it("refuse a result size over 1 MB, in an entry and in defaults", () => {
    const over = MAX_RESULT_BYTES_LIMIT + 1;
    const message = `Number must be less than or equal to ${MAX_RESULT_BYTES_LIMIT}`;
    expect(issues(toolsEntrySchema, { ...classified, max_result_bytes: over })).toStrictEqual([
      { path: "max_result_bytes", message },
    ]);
    expect(issues(mcpToolsSchema, { schema: "mcp-tools/v1", defaults: { max_result_bytes: over } })).toStrictEqual([
      { path: "defaults.max_result_bytes", message },
    ]);
  });

  it("refuse a GraphQL field and a gRPC method in the wrong form", () => {
    expect(issues(toolsEntrySchema, { ...classified, field: "createRefund" })).toContainEqual({
      path: "field",
      message: "a GraphQL field is <RootType>.<field>, such as Mutation.createRefund",
    });
    expect(issues(toolsEntrySchema, { ...classified, method: "Ledger.PostEntry" })).toContainEqual({
      path: "method",
      message: "a gRPC method is <package>.<Service>/<Method>",
    });
  });

  it("refuse an unknown key", () => {
    const found = issues(toolsEntrySchema, { ...classified, retries: 3 });
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("retries");
  });

  it("refuse a tool key that is not snake case", () => {
    const found = issues(mcpToolsSchema, { schema: "mcp-tools/v1", tools: { "Create-Refund": classified } });
    expect(found).toContainEqual({
      path: "tools.Create-Refund",
      message: "a tool key starts with a letter and uses lowercase letters, digits, and underscores",
    });
  });

  it("refuse another schema id", () => {
    expect(issues(mcpToolsSchema, { schema: "mcp-tools/v2" })).toStrictEqual([
      { path: "schema", message: 'Invalid literal value, expected "mcp-tools/v1"' },
    ]);
  });
});
