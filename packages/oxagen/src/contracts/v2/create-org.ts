import { z } from "zod";
import { defineTool } from "./_define";
import {
  organizationCreate,
  organizationCreateInputBase,
} from "../org.create";

/**
 * Appendix E: `create_org` — "organization, Neo4j database, keys, billing
 * account". Absorbs `create_org`.
 *
 * A 1:1 carry of the profile fields, with one addition and one restatement the
 * reviewer should look at:
 *
 * 1. **`namespace` is new and required.** Appendix A `org.organizations` makes
 *    it 2–6 characters, unique and IMMUTABLE, and two things are built out of
 *    it that can never be rebuilt: the Neo4j database name (`org_<namespace>`,
 *    §5.3) and the first segment of every agent key (`org_ns.ws_ns.slug`,
 *    §6.2, ADR-024). v1 had no such column, so v1 could defer it; v2 cannot —
 *    an organization created without one has no graph and can register no
 *    agent. It is not derived from `slug`, which is up to 40 characters and
 *    renameable, because deriving an immutable identifier from a renameable one
 *    is how the two drift.
 *
 * 2. **The personal-account rule is restated, not re-imported.**
 *    `organizationCreate.input` is a ZodEffects (it carries a superRefine), so
 *    it has neither `.shape` nor `.extend`, and there is no way to add a field
 *    to it by reference. The FIELD schemas below are still carried by import —
 *    the length caps, the slug regex and its "lowercase letters, digits, and
 *    hyphens only" message stay attached to the fields they describe. Only the
 *    cross-field rule is re-expressed, and it is re-expressed verbatim.
 */
const createOrgInputObject = organizationCreateInputBase.extend({
  namespace: z
    .string()
    .min(2)
    .max(6)
    .regex(
      /^[a-z0-9]+$/,
      "namespace must be 2–6 lowercase letters or digits — it becomes the Neo4j database name and the first segment of every agent key, and can never be changed",
    ),
});

export const createOrg = defineTool({
  name: "create_org",
  domain: "org",
  description:
    "Create an organization: the tenant row and its immutable namespace, its own Neo4j database (§5.3), its key-encryption key (§5.4), and its billing account.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  // Pre-tenant by construction: there is no org to scope to until this returns.
  scoped: false,

  absorbs: ["create_org"],
  // Every field `create_org` declared is carried. `planSlug` included: it is
  // pinned to "free" at creation on purpose (privileged plans come only through
  // the subscription lifecycle), and Appendix A's `org.organizations.plan`
  // keeps the same three values, so the pin still holds in v2.
  drops: [],

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
  // Writes Postgres (org.organizations), provisions a Neo4j database, creates a
  // KMS key-encryption key and a Stripe customer.
  mutates: true,

  input: createOrgInputObject.superRefine((data, ctx) => {
    // Carried verbatim from `create_org`: business-only fields must be absent
    // on personal accounts. See the file header for why this is not imported.
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
    publicId: organizationCreate.output.shape.publicId,
    name: organizationCreate.output.shape.name,
    slug: organizationCreate.output.shape.slug,
    type: organizationCreate.output.shape.type,
    createdAt: organizationCreate.output.shape.createdAt,

    // Echoed because it is immutable: the caller needs to record the value it
    // will be building agent keys out of for the life of the tenant.
    namespace: createOrgInputObject.shape.namespace,

    /**
     * §5.3: one Neo4j database per organization. Surfaced with its status for
     * the same reason `create_workspace` surfaces it — nothing can ask the
     * graph a question until provisioning finishes, and a caller that cannot
     * see the difference will ask too early and read an empty graph as an
     * empty organization.
     */
    graphDatabase: z.object({
      name: z.string(),
      status: z.enum(["provisioning", "ready"]),
    }),

    /**
     * §5.4: one key-encryption key per organization in KMS. This is the key's
     * IDENTIFIER, never key material — it is what an auditor cites when asking
     * which key a segment was sealed under, and what `erase_data` destroys a
     * subject key beneath.
     */
    kekKeyId: z.string(),

    /**
     * The billing account created alongside the tenant. `plan` restates what
     * was written rather than what was asked for: Appendix A's
     * `org.organizations.plan` is the authority, and creation never grants an
     * entitlement above "free".
     */
    billing: z.object({
      stripeCustomerId: z.string(),
      plan: z.literal("free"),
    }),
  }),
});

export type CreateOrgInput = z.output<typeof createOrg.input>;
export type CreateOrgOutput = z.output<typeof createOrg.output>;
