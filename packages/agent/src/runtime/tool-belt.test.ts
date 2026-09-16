/**
 * The searchable belt: what the engine is declared, what the model is shown,
 * and the two meta-tools' guarantees — a search never returns a tool outside
 * the belt, a load outside the belt loads nothing, and a load that would
 * cross the provider cap is refused rather than sent.
 */
import { describe, expect, it } from "vitest";
import type { ToolSet } from "@oxagen/ai";
import {
  BELT_SEARCH_LIMIT,
  LOAD_TOOLS,
  SEARCH_TOOLS,
  createToolBelt,
  rankBelt,
  type BeltLoadOutput,
  type BeltSearchOutput,
} from "./tool-belt";

function governed(count: number, extra: Record<string, string> = {}): ToolSet {
  const tools: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    tools[`tool_${i}`] = {
      description: `Tool number ${i}`,
      inputSchema: { type: "object" },
      execute: async () => i,
    };
  }
  for (const [name, description] of Object.entries(extra)) {
    tools[name] = {
      description,
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      execute: async () => name,
    };
  }
  return tools as ToolSet;
}

async function run<T>(
  tools: ToolSet,
  name: string,
  input: unknown,
): Promise<T> {
  const execute = (
    tools[name] as { execute: (i: unknown, o: unknown) => Promise<T> }
  ).execute;
  return execute(input, { toolCallId: "c", messages: [] });
}

describe("rankBelt", () => {
  it("ranks name matches above description matches and caps at eight", () => {
    const tools = governed(20, {
      list_approvals: "Pending approvals in the workspace",
      approve_thing: "Do the thing",
      resolve_approval: "Decide one approval",
    });
    const rows = rankBelt(tools, "approval");
    expect(rows.map((r) => r.name)).toEqual([
      "list_approvals",
      "resolve_approval",
    ]);
    expect(rankBelt(tools, "")).toHaveLength(BELT_SEARCH_LIMIT);
  });

  it("returns nothing for a query nothing matches (negative)", () => {
    expect(rankBelt(governed(3), "zebra")).toEqual([]);
  });
});

describe("createToolBelt", () => {
  const modelId = "anthropic/claude-sonnet-4";

  it("declares every governed tool plus the meta-tools to the engine, and shows the model the pinned belt plus the meta-tools", () => {
    const tools = governed(30, { recall_memory: "Recall workspace memory" });
    const belt = createToolBelt({
      tools,
      pinned: ["recall_memory", "not_materialised"],
      modelId,
    });
    expect(Object.keys(belt.tools)).toHaveLength(33);
    expect(belt.tools[SEARCH_TOOLS]).toBeDefined();
    expect(belt.tools[LOAD_TOOLS]).toBeDefined();
    expect(Object.keys(belt.modelTools()).sort()).toEqual(
      [SEARCH_TOOLS, LOAD_TOOLS, "recall_memory"].sort(),
    );
    expect(belt.governance).toEqual({
      [SEARCH_TOOLS]: {
        riskLevel: "low",
        requiresApproval: false,
        readOnly: true,
      },
      [LOAD_TOOLS]: {
        riskLevel: "low",
        requiresApproval: false,
        readOnly: true,
      },
    });
  });

  it("search returns only tools the turn may call, and load adds them to what the model sees", async () => {
    const tools = governed(5, { set_budget: "Set a spend budget on an agent" });
    const belt = createToolBelt({ tools, pinned: [], modelId });
    const found = await run<BeltSearchOutput>(belt.tools, SEARCH_TOOLS, {
      query: "budget",
    });
    expect(found.rows).toEqual([
      { name: "set_budget", description: "Set a spend budget on an agent" },
    ]);
    expect(belt.modelTools().set_budget).toBeUndefined();

    const loaded = await run<BeltLoadOutput>(belt.tools, LOAD_TOOLS, {
      names: ["set_budget", "kill_switch"],
    });
    expect(loaded).toEqual({
      // Names and descriptions only: the next completion carries the schema.
      loaded: [
        { name: "set_budget", description: "Set a spend budget on an agent" },
      ],
      unknown: ["kill_switch"],
      refused: null,
    });
    expect(Object.keys(belt.modelTools()).sort()).toEqual(
      [SEARCH_TOOLS, LOAD_TOOLS, "set_budget"].sort(),
    );
  });

  it("never lets a search or a load reach past the governed set (negative)", async () => {
    const belt = createToolBelt({ tools: governed(2), pinned: [], modelId });
    const found = await run<BeltSearchOutput>(belt.tools, SEARCH_TOOLS, {
      query: "delete everything",
    });
    expect(found.rows).toEqual([]);
    const loaded = await run<BeltLoadOutput>(belt.tools, LOAD_TOOLS, {
      names: ["delete_everything"],
    });
    expect(loaded).toEqual({
      loaded: [],
      unknown: ["delete_everything"],
      refused: null,
    });
    expect(Object.keys(belt.modelTools())).toHaveLength(2);
  });

  it("refuses a load that would push the model's list past the provider cap", async () => {
    // OpenAI's cap is 128 tools per request; 130 governed tools, 126 pinned.
    const tools = governed(130);
    const pinned = Array.from({ length: 126 }, (_, i) => `tool_${i}`);
    const belt = createToolBelt({ tools, pinned, modelId: "openai/gpt-5" });
    expect(Object.keys(belt.modelTools())).toHaveLength(128);
    const refused = await run<BeltLoadOutput>(belt.tools, LOAD_TOOLS, {
      names: ["tool_128"],
    });
    expect(refused).toEqual({ loaded: [], unknown: [], refused: "belt_full" });
    expect(Object.keys(belt.modelTools())).toHaveLength(128);
  });
});
