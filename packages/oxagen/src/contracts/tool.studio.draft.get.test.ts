/**
 * Contract test for get_studio_draft (lane M11, ADR-224).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStudioDraftGet } from "./tool.studio.draft.get";

describe("get_studio_draft is registered as declared", () => {
  it("is scoped, reads only, and skips the billing gate", () => {
    const cap = getCapability("get_studio_draft");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
  });
});

describe("get_studio_draft", () => {
  it("accepts a server name and refuses anything else", () => {
    expect(toolStudioDraftGet.input.parse({ server: "ledger" })).toEqual({
      server: "ledger",
    });
    for (const input of [
      {},
      { server: "builtin" },
      { server: "ledger", revision: 1 },
    ]) {
      expect(toolStudioDraftGet.input.safeParse(input).success).toBe(false);
    }
  });

  it("returns a draft or null", () => {
    expect(toolStudioDraftGet.output.parse({ draft: null })).toEqual({
      draft: null,
    });
    const draft = {
      server: "ledger",
      serverId: "mcs_1",
      ops: [{ kind: "import", tool: "search" }],
      serverToml: null,
      source: { type: "openapi", bytes: 2048 },
      revision: 3,
      pr: {
        number: 12,
        url: "https://github.com/acme/steering/pull/12",
        branch: "tools/ledger",
      },
      updatedAt: "2026-09-28T00:00:00.000Z",
    };
    expect(toolStudioDraftGet.output.parse({ draft })).toEqual({ draft });
    expect(
      toolStudioDraftGet.output.safeParse({ draft: { ...draft, revision: 0 } })
        .success,
    ).toBe(false);
  });
});
