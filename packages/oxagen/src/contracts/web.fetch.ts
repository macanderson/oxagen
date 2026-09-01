import { z } from "zod";
import { registerCapability } from "../registry";

export const webFetch = registerCapability({
  name: "fetch_web_page",
  domain: "web",
  description:
    "Fetch a URL and return its content as clean markdown text. Useful for reading web pages, documentation, or articles.",
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
    /** URL to fetch. Must use http:// or https:// scheme. */
    url: z.string().url(),
    /** When true, strip HTML and convert to readable markdown. Default true. */
    extractMarkdown: z.boolean().default(true),
    /** Request timeout in milliseconds. Capped at 30000. Default 10000. */
    timeout: z.number().int().min(1000).max(30000).default(10000),
  }),
  output: z.object({
    url: z.string().url(),
    title: z.string(),
    content: z.string(),
    wordCount: z.number().int().nonnegative(),
    /** ISO 8601 timestamp of when the fetch completed. */
    fetchedAt: z.string(),
    statusCode: z.number().int(),
  }),
});

export type WebFetchInput = z.output<typeof webFetch.input>;
export type WebFetchOutput = z.output<typeof webFetch.output>;
