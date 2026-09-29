import { describe, expect, it } from "vitest";
import type { ToolManifest } from "../contract/manifest";
import { contentHash, entryText, firstSentence, searchEntryTexts, shortName } from "./entry";

function tool(name: string, description?: string): unknown {
  return { name, definition: { name, description, inputSchema: { type: "object" }, annotations: {} } };
}

function manifest(): ToolManifest {
  return {
    schema: "tool-manifest/v1",
    servers: [
      {
        name: "billing",
        exposure: { mode: "search", definition_budget: 100 },
        tools: {
          create_refund: tool("billing__create_refund", "Refund a charge.  The refund goes to the card."),
          list_charges: tool("billing__list_charges"),
        },
      },
      {
        name: "docs",
        exposure: { mode: "direct", definition_budget: 100 },
        tools: { read_page: tool("docs__read_page", "Read a page.") },
      },
    ],
  } as unknown as ToolManifest;
}

describe("firstSentence", () => {
  it("keeps the first sentence on one line", () => {
    expect(firstSentence("Refund a\n charge. Then more.")).toBe("Refund a charge.");
  });

  it("keeps the whole text when it has no sentence end", () => {
    expect(firstSentence("  List charges  ")).toBe("List charges");
  });

  it("gives an empty line for no description", () => {
    expect(firstSentence(undefined)).toBe("");
  });
});

describe("entry lines", () => {
  it("takes the name after the server's prefix", () => {
    expect(shortName({ name: "billing" }, { name: "billing__create_refund" })).toBe("create_refund");
  });

  it("joins the short name and the summary, or keeps the name alone", () => {
    expect(entryText("create_refund", "Refund a charge.")).toBe("create_refund: Refund a charge.");
    expect(entryText("list_charges", "")).toBe("list_charges");
  });

  it("hashes a line as lowercase sha256 hex", () => {
    expect(contentHash("list_charges")).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash("list_charges")).not.toBe(contentHash("list_charges: List charges."));
  });

  it("lists the lines of search-mode servers only", () => {
    expect(searchEntryTexts(manifest())).toEqual(["create_refund: Refund a charge.", "list_charges"]);
  });
});
