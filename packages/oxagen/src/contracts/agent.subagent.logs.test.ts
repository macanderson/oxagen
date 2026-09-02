import { describe, expect, it } from "vitest";
import { agentSubagentLogs } from "./agent.subagent.logs";

describe("agent.subagent.logs contract", () => {
  it("is exposed on api, mcp, and agent surfaces", () => {
    expect(agentSubagentLogs.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("requires a fanoutId", () => {
    expect(agentSubagentLogs.input.safeParse({}).success).toBe(false);
    expect(
      agentSubagentLogs.input.safeParse({ fanoutId: "fan_1" }).success,
    ).toBe(true);
  });

  it("produces an asset + consumes a swarm id (chain metadata)", () => {
    expect(agentSubagentLogs.produces).toContain("asset.id");
    expect(agentSubagentLogs.consumes).toContain("swarm.id");
  });

  it("output carries a file-attachment document render directive", () => {
    const out = agentSubagentLogs.output.parse({
      assetId: "ast_1",
      publicId: "gen_1",
      childCount: 3,
      mimeType: "text/markdown",
      sizeBytes: 1024,
      url: "blob://x",
      serveUrl: "/api/v1/assets/gen_1",
      render: {
        componentId: "file-attachment",
        props: {
          url: "/api/v1/assets/gen_1",
          name: "log.md",
          kind: "document",
          mimeType: "text/markdown",
          sizeBytes: 1024,
        },
      },
    });
    expect(out.render.props.kind).toBe("document");
    // Rejects a non-document kind (must be a real document card, not a zip).
    expect(
      agentSubagentLogs.output.safeParse({
        assetId: "a",
        publicId: "p",
        childCount: 0,
        mimeType: "application/zip",
        sizeBytes: 1,
        url: "u",
        serveUrl: "s",
        render: {
          componentId: "file-attachment",
          props: {
            url: "u",
            name: "x.zip",
            kind: "archive",
            mimeType: "application/zip",
            sizeBytes: 1,
          },
        },
      }).success,
    ).toBe(false);
  });
});
