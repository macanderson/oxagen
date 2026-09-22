/**
 * The searchable belt (MC spec §6.6; #2611).
 *
 * A turn used to send every governed tool to the model on every completion:
 * 271 definitions, 45,007 tokens, 92.4% of the cacheable prefix. The engine
 * still needs the whole list, because its gate refuses a call to a tool it
 * was not told about. The model does not: it is shown the assistant's own
 * belt (the tools pinned as always present), the two meta-tools this module
 * defines, and whatever it has asked for by name.
 *
 * - `search_tools(query, kinds?)` ranks the belt by name and description and
 *   returns at most eight names with a one-line description each. It reads
 *   the materialised set and nothing else, so it can never return a tool the
 *   turn could not call: what the model cannot call, it cannot find.
 * - `load_tools(names)` adds named tools to what the next completion is
 *   shown, under the provider's per-request cap (`assertToolListFitsProvider`),
 *   and answers with the names and descriptions it loaded; the completion
 *   itself carries each tool's input schema. A name outside the belt is
 *   reported back as unknown and loads nothing.
 *
 * Both are answered on the host as tool calls of the turn, so the ledger
 * records each as a `tool.engine_call_completed` receipt: what the model
 * looked for, and what it was shown.
 */
import { tool, type ToolSet } from "@oxagen/ai";
import { z } from "zod";
import type { ToolGovernance } from "./materialize-tools";
import {
  assertToolListFitsProvider,
  TooManyToolsForProviderError,
} from "./tool-budget";

export const SEARCH_TOOLS = "search_tools";
export const LOAD_TOOLS = "load_tools";

/** The spec's ranked-shortlist budget: eight rows a menu or a model was built for. */
export const BELT_SEARCH_LIMIT = 8;

const beltSearchInputSchema = z.object({
  query: z.string().max(500),
});

const beltLoadInputSchema = z.object({
  names: z.array(z.string().min(1).max(128)).min(1).max(BELT_SEARCH_LIMIT),
});

export interface BeltSearchRow {
  name: string;
  description: string;
}

export interface BeltSearchOutput {
  rows: BeltSearchRow[];
}

export interface BeltLoadOutput {
  loaded: BeltSearchRow[];
  /** Names the belt does not hold; nothing was loaded for them. */
  unknown: string[];
  /** Set when loading would have pushed the model's list past the provider's cap. */
  refused: "belt_full" | null;
}

export interface ToolBeltOptions {
  /** The governed set, as `materializeTools()` returned it. */
  tools: ToolSet;
  /** Model-facing aliases shown on every completion without a load. */
  pinned: readonly string[];
  /** The worker model, whose provider decides the per-request cap. */
  modelId: string;
  /**
   * Who serves that model (`ModelIdentity.provider`). On a customer's own
   * vendor key the id is the vendor's bare spelling and carries no prefix to
   * read, so without this the cap is not found and the belt loads past it.
   */
  provider?: string | null;
}

export interface ToolBelt {
  /** Every governed tool plus the two meta-tools: what the engine is declared. */
  tools: ToolSet;
  /** What the provider is shown on the next completion. */
  modelTools(): ToolSet;
  /** Governance facts for the two meta-tools, to merge into the turn's map. */
  governance: Record<string, ToolGovernance>;
}

const META_GOVERNANCE: ToolGovernance = {
  riskLevel: "low",
  requiresApproval: false,
  readOnly: true,
};

/** Rank the belt for a query: name matches outweigh description matches. */
export function rankBelt(
  tools: ToolSet,
  query: string,
  limit = BELT_SEARCH_LIMIT,
): BeltSearchRow[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  const scored: Array<{ row: BeltSearchRow; score: number }> = [];
  for (const [name, def] of Object.entries(tools)) {
    const description = descriptionOf(def);
    const nameText = name.toLowerCase();
    const descText = description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (nameText.includes(term)) score += 3;
      if (descText.includes(term)) score += 1;
    }
    if (terms.length === 0 || score > 0) {
      scored.push({ row: { name, description }, score });
    }
  }
  scored.sort(
    (a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name),
  );
  return scored.slice(0, limit).map((s) => s.row);
}

export function createToolBelt(options: ToolBeltOptions): ToolBelt {
  const governed = options.tools;
  const loaded = new Set<string>();
  const pinned = options.pinned.filter((alias) => alias in governed);

  const meta: ToolSet = {
    [SEARCH_TOOLS]: tool({
      description:
        "Search the tools this turn may call by name or purpose. Returns up to eight names with a one-line description each; call load_tools with the names you want to use.",
      inputSchema: beltSearchInputSchema,
      execute: async (input): Promise<BeltSearchOutput> => ({
        rows: rankBelt(governed, input.query),
      }),
    }),
    [LOAD_TOOLS]: tool({
      description:
        "Load tools by name so they can be called on the next step, where their full definitions are shown. Names come from search_tools.",
      inputSchema: beltLoadInputSchema,
      execute: async (input): Promise<BeltLoadOutput> => {
        const unknown = input.names.filter((name) => !(name in governed));
        const wanted = input.names.filter((name) => name in governed);
        const candidate = new Set([...loaded, ...wanted]);
        try {
          assertToolListFitsProvider(
            { modelId: options.modelId, provider: options.provider ?? null },
            modelToolsFor(candidate),
          );
        } catch (err) {
          if (err instanceof TooManyToolsForProviderError) {
            return { loaded: [], unknown, refused: "belt_full" };
          }
          throw err;
        }
        for (const name of wanted) loaded.add(name);
        return {
          loaded: wanted.map((name) => ({
            name,
            description: descriptionOf(governed[name]),
          })),
          unknown,
          refused: null,
        };
      },
    }),
  };

  const modelToolsFor = (extra: ReadonlySet<string>): ToolSet => {
    const shown: ToolSet = { ...meta };
    for (const alias of pinned) shown[alias] = governed[alias]!;
    for (const alias of extra) {
      const def = governed[alias];
      if (def) shown[alias] = def;
    }
    return shown;
  };

  return {
    tools: { ...governed, ...meta },
    modelTools: () => modelToolsFor(loaded),
    governance: {
      [SEARCH_TOOLS]: META_GOVERNANCE,
      [LOAD_TOOLS]: META_GOVERNANCE,
    },
  };
}

function descriptionOf(def: ToolSet[string] | undefined): string {
  const description = (def as { description?: unknown } | undefined)
    ?.description;
  return typeof description === "string" ? description : "";
}
