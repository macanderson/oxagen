import { expect, it } from "vitest";
import { evaluateEffectiveMcpScope } from "./resolve";

// NOTE: resourceScope.mcp has no "defaultPolicy" concept (unlike
// packages/mcp-config/src/permissions.ts's per-server/global default). Per
// the resourceScope design ("undefined/absent = unrestricted", documented in
// resolve.ts and pinned by several assertions in agent-rbac-scope.test.ts), a
// rule set that does not match a given tool is unrestricted for that set —
// i.e. it contributes "allow", not "ask". The most-restrictive-effect merge
// across rule sets still means any OTHER contributing set's deny/ask wins.
it("an unmatched MCP tool in an otherwise-configured rule set is unrestricted (allow)", () => {
  const decision = evaluateEffectiveMcpScope(
    {
      ruleSets: [[{ pattern: "github:read_*", effect: "allow" }]],
    },
    "github:delete_repository",
  );

  expect(decision).toBe("allow");
});
