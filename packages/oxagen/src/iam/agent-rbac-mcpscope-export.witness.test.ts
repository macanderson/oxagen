// Witness test: resolve.ts re-exports McpScope (the raw { rules: McpScopeRule[] }
// wrapper), not just McpScopeRule, so downstream consumers (kernel,
// packages/ontology, tool materialization, MCP binding) can construct a raw
// ResourceScope.mcp value while depending on resolve.ts alone — no second
// import from ./conditions required.
import { expect, it } from "vitest";
import type { McpScope, McpScopeRule, ResourceScope } from "./resolve";
import { intersectEffectiveScope } from "./resolve";

it("McpScope (re-exported from resolve.ts) shapes a valid ResourceScope.mcp value", () => {
  const rule: McpScopeRule = { pattern: "github:*", effect: "allow" };
  const mcp: McpScope = { rules: [rule] };
  const scope: ResourceScope = { mcp };

  // Round-trips through the resolver's own intersection machinery, proving
  // the re-exported type is exactly what intersectEffectiveScope expects on
  // the `mcp` dimension of a raw ResourceScope input.
  const effective = intersectEffectiveScope(scope, {});
  expect(effective.mcp?.ruleSets).toEqual([[rule]]);
});
