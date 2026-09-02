/**
 * capability.registry.get handler tests.
 *
 * Registers a synthetic contract with a rich input/output schema and asserts
 * the zod-derived field specs (types, requiredness, descriptions), the
 * accountability projection, and the clean null not-found path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  pluginForContract: vi.fn(),
}));

vi.mock("@oxagen/oxagen", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen")>();
  return { ...real, pluginForContract: mocks.pluginForContract };
});

import { registerCapability, clearRegistryForTests } from "@oxagen/oxagen";
import {
  capabilityRegistryGetHandler,
  describeSchemaFields,
} from "./capability.registry.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pluginForContract.mockReturnValue(undefined);
  clearRegistryForTests();
});

describe("capabilityRegistryGetHandler", () => {
  it("returns null for an unknown capability (clean not-found)", async () => {
    const out = await capabilityRegistryGetHandler(
      { name: "no_such_cap" },
      CTX,
    );
    expect(out.capability).toBeNull();
  });

  it("returns the full detail with zod-derived field specs", async () => {
    registerCapability({
      name: "rich_cap",
      domain: "testdom",
      description: "a rich capability",
      mode: "sync",
      surfaces: ["api", "mcp"],
      layers: ["api", "mcp", "unit", "docs"],
      scoped: true,
      sensitivity: "medium",
      defaultEffect: "deny",
      defaultRoles: { org: { Owner: "allow" }, workspace: { Viewer: "deny" } },
      audit: { targetKind: "widget", targetIdField: "widgetId" },
      produces: ["widget.id"],
      consumes: ["org.id"],
      chainHints: ["other_cap"],
      input: z.object({
        widgetId: z.string().describe("The widget to read"),
        limit: z.number().int().default(10).describe("Page size"),
        mode: z.enum(["fast", "slow"]).optional(),
        deep: z.boolean().nullable(),
      }),
      output: z.object({
        widgets: z
          .array(z.object({ id: z.string() }))
          .describe("Matching widgets"),
        cursor: z.string().nullable().optional(),
      }),
    });

    const out = await capabilityRegistryGetHandler({ name: "rich_cap" }, CTX);
    const cap = out.capability;
    expect(cap).not.toBeNull();
    expect(cap?.name).toBe("rich_cap");
    expect(cap?.auditTargetKind).toBe("widget");
    expect(cap?.auditTargetIdField).toBe("widgetId");
    expect(cap?.produces).toEqual(["widget.id"]);
    expect(cap?.consumes).toEqual(["org.id"]);
    expect(cap?.chainHints).toEqual(["other_cap"]);
    expect(cap?.workspaceRoles).toEqual({ Viewer: "deny" });

    expect(cap?.inputFields).toEqual([
      {
        name: "widgetId",
        type: "string",
        required: true,
        description: "The widget to read",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Page size",
      },
      {
        name: "mode",
        type: "enum(fast | slow)",
        required: false,
        description: null,
      },
      {
        name: "deep",
        type: "boolean | null",
        required: true,
        description: null,
      },
    ]);
    expect(cap?.outputFields).toEqual([
      {
        name: "widgets",
        type: "array<object>",
        required: true,
        description: "Matching widgets",
      },
      {
        name: "cursor",
        type: "string | null",
        required: false,
        description: null,
      },
    ]);
  });

  it("derives fields through a .refine()-wrapped (ZodEffects) input", () => {
    const wrapped = z
      .object({ start: z.string(), end: z.string() })
      .refine((v) => v.end > v.start);
    expect(describeSchemaFields(wrapped)).toEqual([
      { name: "start", type: "string", required: true, description: null },
      { name: "end", type: "string", required: true, description: null },
    ]);
  });

  it("yields [] for a non-object schema instead of throwing", () => {
    expect(describeSchemaFields(z.string())).toEqual([]);
    expect(describeSchemaFields(z.array(z.string()))).toEqual([]);
  });
});
