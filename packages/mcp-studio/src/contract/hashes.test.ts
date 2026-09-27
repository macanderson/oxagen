// The hashes and token counts a lock and the manifest carry.
import { countTokens } from "@oxagen/oxagen/steering-repo/tokens";
import { describe, expect, it } from "vitest";
import type { UpstreamTool } from "../model/upstream-tool";
import { definitionHash, definitionHashInput, definitionTokens, documentHash, upstreamHash } from "./hashes";
import { canonicalDigest, canonicalText } from "./json";
import type { EffectiveDefinition } from "./manifest";
import type { LockedMcpTool } from "./mcp-tool";

const definition: EffectiveDefinition = {
  name: "stripe__create_refund",
  title: "Create a refund",
  description: "Refund a charge, in full or in part.",
  inputSchema: {
    type: "object",
    properties: { charge: { type: "string" }, amount: { type: "integer" } },
    required: ["charge"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

describe("definitionHash", () => {
  it("covers the name, description, and input and output schemas", () => {
    expect(definitionHashInput(definition)).toStrictEqual({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: undefined,
    });
  });

  it("hashes the RFC 8785 form of those fields", () => {
    expect(definitionHash(definition)).toBe(
      canonicalDigest({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }),
    );
  });

  it("stays the same when only the title or the annotations change", () => {
    const reclassified: EffectiveDefinition = {
      ...definition,
      title: "Refund a charge",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    };
    expect(definitionHash(reclassified)).toBe(definitionHash(definition));
  });

  it("changes when the description changes", () => {
    const redescribed: EffectiveDefinition = { ...definition, description: "Refund a charge." };
    expect(definitionHash(redescribed)).not.toBe(definitionHash(definition));
  });

  it("changes when an output schema is added", () => {
    const withOutput: EffectiveDefinition = { ...definition, outputSchema: { type: "object" } };
    expect(definitionHash(withOutput)).not.toBe(definitionHash(definition));
  });
});

describe("upstreamHash", () => {
  const locked: LockedMcpTool = {
    name: "create_refund",
    description: "Refund a charge.",
    inputSchema: { type: "object", properties: { charge: { type: "string" } } },
    annotations: { destructiveHint: true },
  };

  it("hashes the RFC 8785 form of a locked tools/list entry", () => {
    expect(upstreamHash(locked)).toBe(canonicalDigest(locked));
  });

  it("does not depend on key order", () => {
    const reordered: LockedMcpTool = {
      annotations: { destructiveHint: true },
      inputSchema: { properties: { charge: { type: "string" } }, type: "object" },
      description: "Refund a charge.",
      name: "create_refund",
    };
    expect(upstreamHash(reordered)).toBe(upstreamHash(locked));
  });

  it("hashes a whole UpstreamTool for a server built from a definition", () => {
    const tool: UpstreamTool = {
      name: "get_charge",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      request: {
        kind: "http",
        operation: "getCharge",
        method: "GET",
        path: "/charges/{id}",
        parameters: [{ name: "id", in: "path", property: "id", required: true }],
      },
    };
    expect(upstreamHash(tool)).toBe(canonicalDigest(tool));
    expect(upstreamHash(tool)).not.toBe(upstreamHash(locked));
  });
});

describe("definitionTokens", () => {
  it("counts the tokens of the definition's RFC 8785 form", () => {
    const tokens = definitionTokens(definition);
    expect(tokens).toBe(countTokens(canonicalText(definition)));
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("documentHash", () => {
  const abc = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  it("hashes text as its UTF-8 bytes", () => {
    expect(documentHash("abc")).toBe(abc);
  });

  it("hashes bytes as given", () => {
    expect(documentHash(new TextEncoder().encode("abc"))).toBe(abc);
  });
});
