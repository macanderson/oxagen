import { z } from "zod";
import {
  ORG_TYPE_VALUES,
  INDUSTRY_VALUES,
  EMPLOYEE_SIZE_VALUES,
} from "@oxagen/config";
import { registerCapability } from "../registry";
import { workspaceSlug } from "../workspace-slug";

/**
 * Top-level route segments an organization slug may not take. An org at
 * `/{slug}` would lose its root page or its workspaces to the route that owns
 * the segment (`/invite/core` is an invitation token, `/api/...` the API). The
 * set covers every top-level segment of `apps/app/src/app` (sign-in flows,
 * organization creation, the CLI and GitHub callbacks, the API), the legacy
 * root routes of `apps/app_deprecated` that cutover redirects claim (`account`,
 * `actions`, `onboarding`, `welcome`), and the static and metadata paths the
 * proxy matcher skips. Refused by the input schema so every surface (API, MCP,
 * app) applies the same rule.
 */
export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  // sign-in flows and invitations
  "login",
  "signup",
  "verify",
  "two-factor",
  "forgot-password",
  "reset-password",
  "invite",
  // organization creation and the legacy onboarding gate
  "welcome",
  "new-organization",
  // callbacks and API
  "api",
  "cli",
  "github",
  // legacy root routes of apps/app_deprecated
  "account",
  "actions",
  "onboarding",
  // Next internals, static assets and metadata routes the proxy skips
  "_next",
  "brand",
  "favicon",
  "fonts",
  "manifest",
  "pwa",
  "robots",
  "sitemap",
  "social",
  "spinner",
]);

/**
 * Re-exported from `../workspace-slug`, which holds the one definition and the
 * one slug shape every workspace-slug field is built from.
 *
 * They stay reachable from THIS path on purpose: `apps/app` may import platform
 * code only through `@oxagen/oxagen/contracts/*` (ARCHITECTURE.md §2, INV-03,
 * enforced by `apps/app/src/test/arch/import-graph.test.ts`), so a contract
 * file is the app's doorway to a shared shape. The onboarding form reads both
 * from here, and the definition is still in one place.
 */
export {
  RESERVED_WORKSPACE_SLUGS,
  WORKSPACE_SLUG_PATTERN,
} from "../workspace-slug";

/** `organizations.namespace`: 2-6 lowercase letters or digits, no hyphen. */
export const ORG_NAMESPACE_PATTERN = /^[a-z0-9]{2,6}$/;

const slugShape = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only");

/**
 * The first workspace is part of the org bootstrap: an org with no workspace
 * has no Fleet page to land on. Callers that do not name one get the
 * convention every existing surface used ("Default" at `default`).
 */
const DEFAULT_FIRST_WORKSPACE_NAME = "Default";
const DEFAULT_FIRST_WORKSPACE_SLUG = "default";
// Assembled from the two constants: check_manifest takes the first quoted
// name literal in a contract file as the capability name.
export const DEFAULT_FIRST_WORKSPACE = {
  name: DEFAULT_FIRST_WORKSPACE_NAME,
  slug: DEFAULT_FIRST_WORKSPACE_SLUG,
} as const;

// Exported so MCP and other surfaces can spread `.shape` without re-declaring
// field constraints. The superRefine validation is layered on top below.
export const organizationCreateInputBase = z.object({
  name: z.string().min(1).max(120),
  slug: slugShape.refine((s) => !RESERVED_ORG_SLUGS.has(s), {
    message: "slug is a reserved route segment",
  }),
  /**
   * The immutable namespace every agent key starts with
   * (`<namespace>.<workspace>.<agent>`, ADR-024), as the organization step
   * names it. The column's own shape (`organizations_namespace_check`). Left
   * off, the handler derives one from the slug; given, it is used verbatim or
   * refused as `conflict: namespace_taken`, never silently altered.
   */
  namespace: z
    .string()
    .regex(ORG_NAMESPACE_PATTERN, "2-6 lowercase letters or digits")
    .optional(),
  // Organization creation is not a billing entitlement grant. Privileged plans
  // are established only through the canonical subscription lifecycle.
  planSlug: z.literal("free").default("free"),
  type: z.enum(ORG_TYPE_VALUES).default("business"),
  // Business-only fields — superRefine rejects these on personal accounts.
  website: z.string().trim().url().max(2048).optional(),
  industry: z.enum(INDUSTRY_VALUES).optional(),
  employeeSize: z.enum(EMPLOYEE_SIZE_VALUES).optional(),
  // Billing email/address were removed with billing.org_billing_profiles
  // (migration 20260802130000): the collected data was never read — Stripe
  // captures the billing address at checkout and is the source of truth.
  workspace: z
    .object({
      name: z.string().min(1).max(120),
      // The shared shape: reserved segments and the one spelling (#3110).
      slug: workspaceSlug,
    })
    .default(DEFAULT_FIRST_WORKSPACE),
});

export const organizationCreate = registerCapability({
  name: "create_org",
  domain: "org",
  description:
    "Create a new organization with a globally-unique slug, its owner membership, IAM bootstrap and first workspace",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  // Pre-tenant: the caller has no org yet. The kernel skips the billing gate
  // and the recorder for an unscoped invoke, and the app reaches it with a
  // PretenantCtx.
  scoped: false,
  agent: {
    requiresApproval: true,
    riskLevel: "medium",
    category: "organization",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: organizationCreateInputBase.superRefine((data, ctx) => {
    // Business-only fields must be absent on personal accounts.
    if (data.type === "personal") {
      if (data.website !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "website is only valid for business accounts",
          path: ["website"],
        });
      }
      if (data.industry !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "industry is only valid for business accounts",
          path: ["industry"],
        });
      }
      if (data.employeeSize !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "employeeSize is only valid for business accounts",
          path: ["employeeSize"],
        });
      }
    }
  }),
  output: z.object({
    publicId: z.string(),
    name: z.string(),
    slug: z.string(),
    type: z.string(),
    createdAt: z.string(),
    workspace: z.object({
      publicId: z.string(),
      slug: z.string(),
    }),
  }),
});

export type OrganizationCreateInput = z.output<typeof organizationCreate.input>;
export type OrganizationCreateOutput = z.output<
  typeof organizationCreate.output
>;
