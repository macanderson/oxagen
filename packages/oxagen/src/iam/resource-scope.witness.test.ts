import { describe, expect, it } from "vitest";
import { evaluateConditions } from "./conditions";

const context = { now: new Date("2026-01-01T00:00:00Z"), clientIp: null };

describe("resourceScope conditions", () => {
  it("accepts the complete resource scope payload and rejects malformed MCP effects", () => {
    const resourceScope = {
      graph: {
        labels: ["Document"],
        relationshipTypes: ["REFERENCES"],
        mode: "read",
        budget: { maxHops: 2, maxNodes: 50, maxTraversalMs: 1_000 },
      },
      mcp: { rules: [{ pattern: "github:*", effect: "ask" }] },
      skills: { slugs: ["research"] },
      agents: { refs: ["reviewer"] },
    };

    expect(evaluateConditions({ resourceScope }, context)).toBe(true);
    expect(
      evaluateConditions(
        {
          resourceScope: {
            ...resourceScope,
            mcp: { rules: [{ pattern: "github:*", effect: "prompt" }] },
          },
        },
        context,
      ),
    ).toBe(false);
  });
});
