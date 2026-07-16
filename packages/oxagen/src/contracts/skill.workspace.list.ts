import { z } from "zod";
import { registerCapability } from "../registry";

export const skillWorkspaceList = registerCapability({
  name: "list_workspace_skills",
  domain: "skill",
  description: "List skills available in the workspace",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "skill" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    workspace_id: z.string().optional(),
  }),
  output: z.object({
    skills: z.array(
      z.object({
        // Public ID (skl_…). NOT the on-screen identifier — see slug.
        id: z.string(),
        // Kebab-case workspace-unique identifier. Required by the app: it is
        // the detail-route segment (…/skills/<slug>), the search key, and the
        // metrics join key. Its absence is what previously blanked the list.
        slug: z.string(),
        name: z.string(),
        description: z.string(),
        // "builtin" | "tenant" (+ future provenance) — drives the source badge.
        source: z.string(),
        // Builtin/template slug this skill was installed from (workspace-seeded
        // copies of packages/skills templates carry it). Lets the UI badge
        // template-derived skills as Built-in instead of Custom.
        installedFromSlug: z.string().nullable(),
        enabled: z.boolean(),
        // Pinned active version rendered in the list (e.g. "v1"); null when no
        // version is pinned yet.
        activeVersion: z.string().nullable(),
        // ISO-8601 last-modified timestamp; null when unavailable.
        updatedAt: z.string().nullable(),
      }),
    ),
  }),
});

export type SkillWorkspaceListInput = z.output<typeof skillWorkspaceList.input>;
export type SkillWorkspaceListOutput = z.output<
  typeof skillWorkspaceList.output
>;
