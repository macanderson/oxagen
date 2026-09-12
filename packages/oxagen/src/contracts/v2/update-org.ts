import { z } from "zod";
import { defineTool } from "./_define";
import { orgSettingsWrite } from "../org.settings.write";

/**
 * Appendix E: `update_org` — "name, settings, retention policy". Absorbs
 * `update_org_settings`.
 *
 * The profile half is a clean carry: every field `update_org_settings` had
 * survives, by import, with its partial-update semantics intact (omit = leave
 * unchanged, value = set, null = clear).
 *
 * The retention half is new, and it is the reason this tool is not a rename.
 * §13.1 makes retention an organization-level policy with two knobs, and
 * Appendix A gives both columns to `org.organizations`:
 *
 *  - `retention_days`, default 2555 (seven years). §13.1: "The retention clock
 *    runs seven years from the seal by default. Organizations may set a LONGER
 *    period." So the floor is encoded rather than left to the handler — a
 *    contract that accepts 30 here is a contract that can silently shorten a
 *    customer's audit trail, and object-lock retention is set per object at
 *    write time from this value, which means the mistake is unrecoverable.
 *  - `retention_mode`. §13.1 again: `digest_only` is an opt-down, it is
 *    recorded as a completeness gap, and it lowers the replay grade from `view`
 *    to `inspect` (§8.4). The workspace-level override of the same setting
 *    belongs to `update_workspace` (Appendix A `wrk.workspaces.retention_mode`,
 *    "override of the organization's, or null"), not here.
 */
export const updateOrg = defineTool({
  name: "update_org",
  domain: "org",
  description:
    "Update the organization (partial): profile — name, slug, avatar, website, industry, employee size — and the retention policy (retention period and content vs digest-only mode, §13.1).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,

  absorbs: ["update_org_settings"],
  // Every input and output field of `update_org_settings` is carried.
  drops: [],

  // `sensitivity`, `defaultEffect`, `defaultRoles` and `riskLevel` carry from
  // `update_org_settings` unchanged — one source, no disagreement to resolve.
  //
  // `requiresApproval` does NOT: v1 had it false because the tool only edited a
  // profile. It now carries the retention policy, and `digest_only` is the one
  // setting in the product that makes a run permanently unreadable rather than
  // merely unreadable to the caller (§13.1: bodies that were never written
  // cannot be recovered). §14's interaction rule — every trust badge shows the
  // recorded value and nothing stronger — is only honest if a human chose the
  // downgrade, so the agent surface asks first.
  agent: { requiresApproval: true, riskLevel: "medium", category: "organization" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    // v1 also listed a workspace "Admin" grant. There is no such system role —
    // `SystemWorkspaceRole` is Owner | Member | Viewer — so the entry was
    // unreachable, and it is not reproduced.
    workspace: { Owner: "allow" },
  },
  mutates: true,

  input: z.object({
    // Carried by reference: the slug regex and its "lowercase letters, numbers,
    // and single hyphens" message, and the nullable-to-clear encoding on the
    // three profile fields, all stay attached where they were learned.
    name: orgSettingsWrite.input.shape.name,
    slug: orgSettingsWrite.input.shape.slug,
    avatarUrl: orgSettingsWrite.input.shape.avatarUrl,
    website: orgSettingsWrite.input.shape.website,
    industry: orgSettingsWrite.input.shape.industry,
    employeeSize: orgSettingsWrite.input.shape.employeeSize,

    /**
     * §13.1. Floored at the seven-year default rather than defaulted to it: a
     * partial update omits what it does not change, so a default here would
     * reset the period of every organization that edited only its name.
     */
    retentionDays: z
      .number()
      .int()
      .min(
        2555,
        "retention may be lengthened but never shortened below the seven-year default (§13.1); object-lock retention is stamped per object at write time and cannot be re-applied later",
      )
      .optional(),

    /**
     * §13.1. `content_exact` is the default and the product's explanation
     * promise depends on it; `digest_only` is an opt-down for customers who
     * cannot store prompt content, and it lowers the replay grade.
     */
    retentionMode: z.enum(["content_exact", "digest_only"]).optional(),
  }),

  output: z.object({
    name: orgSettingsWrite.output.shape.name,
    slug: orgSettingsWrite.output.shape.slug,
    avatarUrl: orgSettingsWrite.output.shape.avatarUrl,
    website: orgSettingsWrite.output.shape.website,
    industry: orgSettingsWrite.output.shape.industry,
    employeeSize: orgSettingsWrite.output.shape.employeeSize,
    type: orgSettingsWrite.output.shape.type,

    // The resolved policy, not the requested change — a caller that sent
    // nothing still learns what the organization is currently keeping.
    retentionDays: z.number().int(),
    retentionMode: z.enum(["content_exact", "digest_only"]),
  }),
});

export type UpdateOrgInput = z.output<typeof updateOrg.input>;
export type UpdateOrgOutput = z.output<typeof updateOrg.output>;
