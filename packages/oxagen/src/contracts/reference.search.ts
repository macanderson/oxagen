import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * reference.search — typed autocomplete search behind the chat composer's
 * @-mention picker (and any other surface that needs to reference a platform
 * object by stable public id).
 *
 * Searches, scoped to the caller's tenant, across every referenceable kind:
 * connected repositories (+ their branches), code-graph files/directories,
 * agent definitions, skills, agent tools, MCP servers, capabilities, and
 * knowledge-graph nodes/edges. Each row carries the four fields a mention
 * token needs — type, slug (public id), location, label — plus a description
 * and a property bag for hover inspection.
 *
 * Two modes:
 *   - query mode: free-text substring search, optionally restricted to types.
 *   - resolve mode: `slug` set → exact public-id lookup (used to hydrate a
 *     previously inserted mention chip).
 */

/**
 * Kinds a chat message can reference. Must stay in lockstep with `MentionType`
 * in `@oxagen/ai/mentions` (dep direction forbids importing it here; the
 * apps/app mention unit test asserts the two lists are identical).
 */
export const REFERENCE_TYPES = [
  "repository",
  "branch",
  "file",
  "directory",
  "agent",
  "skill",
  "tool",
  "mcp_server",
  "capability",
  "node",
  "edge",
] as const;

export type ReferenceType = (typeof REFERENCE_TYPES)[number];

const referenceResultRow = z.object({
  type: z.enum(REFERENCE_TYPES).describe("Reference kind"),
  slug: z
    .string()
    .describe("Stable public identifier (publicId, capability name, path, …)"),
  location: z
    .string()
    .describe("Path / URL / graph address locating the referent; may be empty"),
  label: z.string().describe("Human-readable display name — what chips render"),
  description: z
    .string()
    .nullable()
    .describe("One-line context for the picker"),
  properties: z
    .record(z.string(), z.unknown())
    .describe("Property bag revealed when a mention chip is inspected"),
});

export const referenceSearch = registerCapability({
  name: "search_references",
  domain: "reference",
  description:
    "Tenant-scoped autocomplete search across every referenceable platform object — " +
    "connected repositories and branches, code-graph files/directories, agents, skills, " +
    "agent tools, MCP servers, capabilities, and knowledge-graph nodes/edges. Returns " +
    "typed rows (type, slug, location, label, description, properties) ready to become " +
    "@-mention tokens; pass `slug` for exact-id resolution of an existing mention.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    query: z
      .string()
      .min(0)
      .max(500)
      .default("")
      .describe("Free-text search string"),
    types: z
      .array(z.enum(REFERENCE_TYPES))
      .min(1)
      .max(REFERENCE_TYPES.length)
      .optional()
      .describe("Restrict results to these reference kinds"),
    slug: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Exact public-id resolve mode — ignores `query`"),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  output: z.object({
    results: z.array(referenceResultRow).max(25),
  }),
});

export type ReferenceSearchInput = z.output<typeof referenceSearch.input>;
export type ReferenceSearchOutput = z.output<typeof referenceSearch.output>;
export type ReferenceResultRow = z.output<typeof referenceResultRow>;
