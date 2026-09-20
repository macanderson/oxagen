import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import {
  schema,
  withSystemDb,
  isUniqueViolation,
  deriveNamespace,
} from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { eq } from "drizzle-orm";
import { grantSignupCredits } from "@oxagen/billing";
import { recordOrgGraphDatabase } from "@oxagen/database/data-plane";
import { provisionOrgGraph } from "@oxagen/ontology/provision";
import { logger } from "./logger";
import { bootstrapOrgIAM } from "./iam-provision";
import { openOnboardingGate } from "./lib/onboarding";
import { bootstrapWorkspace } from "./workspace-bootstrap";
import { provisionAssistantModelKey } from "./assistant-key-bootstrap";

/**
 * The org bootstrap: the organization row, the creator's owner membership,
 * the org's graph placement (pooled, or its own Neo4j database — ADR-098),
 * the IAM roles and grants, the first workspace with everything a workspace
 * needs, the onboarding gate opened on that workspace (#2967: the
 * organization exists, so the gate is at `wrap` with its 14-day provisional
 * window), and the $5 signup grant (grantSignupCredits), in one system
 * transaction. The grant funds the in-app agent's platform-paid turns
 * (ADR-053 §2; apps/app/ARCHITECTURE.md §9, 2026-09-15), so an org never
 * exists without it. No other billing row is written: no contract_terms,
 * gau_buckets or gau_settlements row, and the billing settings row appears on
 * the first write that needs it.
 */
export const organizationCreateHandler: CapabilityHandler<
  typeof organizationCreate
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "organization.create: rejected — no authenticated user",
    );
    throw new Error("organization.create requires an authenticated user");
  }
  const userId = ctx.userId;
  const slugTaken = () =>
    new HandlerError({
      code: "conflict",
      reason: "slug_taken",
      message: `slug "${input.slug}" already in use`,
    });
  // tenancy: system bypass via withSystemDb (bootstrap — creates the org's own root
  // rows; no tenant scope exists yet because the new org does not exist yet, and
  // ctx.orgId is the caller's current org, not the one being created) (see docs/specs/tenancy-rls/spec.md)
  // Fast-path friendly error for the common (non-racing) case; the unique
  // index + the catch below are the authoritative guard against the race.
  const existing = await withSystemDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.slug, input.slug),
      columns: { id: true },
    }),
  );
  if (existing) throw slugTaken();

  try {
    const created = await withSystemDb(async (tx) => {
      // Derive the immutable, globally-unique namespace from the slug, avoiding
      // any namespace already taken. The unique index is the authoritative guard
      // against a concurrent-create race; this best-effort read just picks a
      // non-colliding value in the common case.
      const takenNamespaces = new Set(
        (
          await tx
            .select({ namespace: schema.organizations.namespace })
            .from(schema.organizations)
        ).map((r) => r.namespace.toLowerCase()),
      );
      const namespace = deriveNamespace(input.slug, takenNamespaces);

      const [org] = await tx
        .insert(schema.organizations)
        .values({
          name: input.name,
          slug: input.slug,
          namespace,
          planType: input.planSlug,
          status: "active",
          type: input.type,
          // Business-only fields: contract superRefine guarantees these are
          // undefined for personal accounts, so the DB columns stay null.
          website: input.type === "business" ? (input.website ?? null) : null,
          industry: input.type === "business" ? (input.industry ?? null) : null,
          employeeSize:
            input.type === "business" ? (input.employeeSize ?? null) : null,
          createdById: userId,
          updatedById: userId,
        })
        .returning({
          publicId: schema.organizations.publicId,
          name: schema.organizations.name,
          slug: schema.organizations.slug,
          type: schema.organizations.type,
          createdAt: schema.organizations.createdAt,
          id: schema.organizations.id,
        });

      if (!org) throw new Error("organization insert returned no row");

      // Creator becomes owner. Membership row paired in same tx so callers
      // never see an org they cannot reach.
      await tx.insert(schema.orgUsers).values({
        orgId: org.id,
        userId,
        role: "owner",
        joinedAt: new Date(),
        createdById: userId,
        updatedById: userId,
      });

      // The org's graph (spec §5.3 rules 1, 3, 4; ADR-098). A free or trial
      // org is placed in the pooled database and nothing is created. A paid
      // org on a deployment that runs a real provisioner gets `org-<namespace>`
      // created (idempotently) and the routing row written on THIS
      // transaction, so the org never exists without the binding that sends
      // its sessions to its own database. A provisioning failure is typed
      // (`org_graph_provision_failed` / `org_graph_provisioner_not_configured`)
      // and rolls the org back: a paid org silently left in the pool is the
      // isolation downgrade the spec forbids. The catch below logs it and
      // rethrows. A database created here and orphaned by a later rollback is
      // empty and is reused by `IF NOT EXISTS` if its namespace ever returns.
      const graph = await provisionOrgGraph({
        orgId: org.id,
        namespace,
        planType: input.planSlug,
      });
      if (graph.mode === "database") {
        await recordOrgGraphDatabase(tx, {
          orgId: org.id,
          database: graph.database,
          actorUserId: userId,
        });
      }

      // Bootstrap full IAM state for the org — system roles, owner principal,
      // owner role assignment, and role_grants from capability defaultRoles.
      // Runs inside the same transaction so the org is never visible without
      // the owner having access (atomic with the org creation).
      await bootstrapOrgIAM({
        orgId: org.id,
        ownerUserId: userId,
        actorUserId: userId,
        tx,
      });

      // The first workspace, on the same transaction: an org with no
      // workspace has no page to land on.
      //
      // Deliberately WITHOUT a main repository, although §10.1 says a
      // workspace has exactly one and `create_workspace` refuses to make one
      // without it (ADR-099). This is the spec's own exception (Mission
      // Control spec §7, line ~222): onboarding binds the main repo in a LATER
      // step — the installer offers the git remote of the directory it ran in
      // and one more click installs the GitHub App — and if that step is
      // skipped the workspace is provisional for 14 days (the gate
      // `openOnboardingGate` opens below), with steering, records and agent
      // definitions off until `bind_main_repository` closes the window. It
      // cannot be otherwise: the org does not exist until this transaction
      // commits, so it holds no GitHub authorization and no repository is
      // reachable to bind. `create_workspace` — a SECOND workspace, in an org
      // that can already reach GitHub — is the path that requires one.
      const workspace = await bootstrapWorkspace({
        tx,
        orgId: org.id,
        userId,
        name: input.workspace.name,
        slug: input.workspace.slug,
      });

      // The signup grant commits with the org: a failed grant rolls the org
      // back rather than leaving an org whose first assistant turn the credit
      // gate refuses.
      await grantSignupCredits(tx, org.id);

      await openOnboardingGate(tx, {
        orgId: org.id,
        workspaceId: workspace.id,
        now: org.createdAt,
      });

      return { org, workspace };
    });

    logger.info(
      {
        orgId: created.org.id,
        slug: created.org.slug,
        workspaceId: created.workspace.id,
        surface: ctx.surface,
      },
      "organization.create: organization created successfully",
    );
    // Record security event for org creation (privileged mutation).
    emitSecurityEventAsync({
      eventType: "organization.created",
      actorUserId: userId,
      orgId: created.org.id,
      workspaceId: null,
      outcome: "success",
      capability: null,
      ip: null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: created.org.id },
        "organization.create: failed to record security event",
      );
    });

    // The organisation's own OpenRouter key (ADR-131). Detached for the same
    // reason the security event is: it calls a third party, and neither the
    // person signing up nor the transaction that just committed should wait
    // on OpenRouter. An organisation whose key is not minted serves on the
    // shared key, so this failing costs reconciliation granularity and
    // nothing a customer can see.
    provisionAssistantModelKey({
      orgId: created.org.id,
      orgSlug: created.org.slug,
      userId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: created.org.id },
        "organization.create: assistant model key provisioning threw",
      );
    });

    return {
      publicId: created.org.publicId,
      name: created.org.name,
      slug: created.org.slug,
      type: created.org.type,
      createdAt: created.org.createdAt.toISOString(),
      workspace: {
        publicId: created.workspace.publicId,
        slug: created.workspace.slug,
      },
    };
  } catch (err) {
    if (isUniqueViolation(err, "organizations_slug_idx")) {
      logger.warn(
        { slug: input.slug, orgId: ctx.orgId },
        "organization.create: slug conflict",
      );
      throw slugTaken();
    }
    logger.error(
      { err, orgId: ctx.orgId },
      "organization.create: transaction failed",
    );
    throw err;
  }
};
