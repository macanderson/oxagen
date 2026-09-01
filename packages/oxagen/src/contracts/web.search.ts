import { z } from "zod";
import { registerCapability } from "../registry";

export const webSearch = registerCapability({
  name: "search_web",
  domain: "web",
  description:
    "Search the web using the Tavily API and return ranked results with title, URL, and content snippets.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "search",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "allow",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** Search query string. */
    query: z.string().min(1).max(500),
    /** Maximum number of results to return. Capped at 10. */
    maxResults: z.number().int().min(1).max(10).default(5),
    /** Search depth — "basic" is faster, "advanced" is more thorough. */
    searchDepth: z.enum(["basic", "advanced"]).default("basic"),
    /** Optional list of domains to restrict results to. */
    includeDomains: z.array(z.string()).optional(),
    /** Optional list of domains to exclude from results. */
    excludeDomains: z.array(z.string()).optional(),
  }),
  output: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string().url(),
        content: z.string(),
        score: z.number(),
        publishedDate: z.string().optional(),
      }),
    ),
    totalResults: z.number().int().nonnegative(),
    searchId: z.string(),
  }),
});

export type WebSearchInput = z.output<typeof webSearch.input>;
export type WebSearchOutput = z.output<typeof webSearch.output>;
