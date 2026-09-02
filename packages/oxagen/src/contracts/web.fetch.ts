import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * fetch_web_page — server-side fetch of a caller-supplied URL, returned as
 * markdown.
 *
 * SSRF EXPOSURE (unmitigated, read before widening access). The server makes
 * the request, so the reachable network is the server's, not the caller's.
 * `webFetch` in packages/web/src/fetch.ts restricts the SCHEME to http/https
 * but never checks the HOST, and it follows redirects, so a caller can reach
 * loopback, private RFC-1918 ranges and the cloud metadata endpoint
 * (169.254.169.254) and read the response body back out.
 *
 * Three declarations below widen who can do that, and each is deliberate:
 *   - `surfaces` includes "agent", so an LLM can call this mid-turn on a URL it
 *     read out of untrusted page or document text (prompt injection);
 *   - `agent.requiresApproval: false`, so no human-in-the-loop card fires, and
 *     `sensitivity` is below "destructive", so run_capability_chain
 *     (packages/handlers/src/agent.compose.ts:96) will auto-execute it inside a
 *     plan;
 *   - `defaultEffect: "allow"`, so IAM rule 8 permits the call for any
 *     principal holding no explicit grant.
 *
 * The durable fix is a host allowlist / private-range denylist applied to the
 * initial URL AND to every redirect hop, in packages/web/src/fetch.ts. Until
 * that lands, treat any change that broadens this capability's reach as a
 * security change.
 */
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
    /**
     * URL to fetch. Must use the http:// or https:// scheme.
     *
     * `z.string().url()` only checks that `new URL()` parses the value — it
     * accepts file://, data:// and every other scheme. The scheme allowlist is
     * enforced one layer down, by `webFetch` in packages/web/src/fetch.ts.
     * Nothing on either layer restricts the HOST, so this input reaches private
     * and link-local addresses; see the SSRF note in the header comment above.
     */
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
