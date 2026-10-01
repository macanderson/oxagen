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
import { grantSignupCredits, issueSignupGrant } from "@oxagen/billing";
import { recordOrgGraphDatabase } from "@oxagen/database/data-plane";
import { provisionOrgGraph } from "@oxagen/ontology/provision";
import { logger } from "./logger";
import { bootstrapOrgIAM } from "./iam-provision";
import { openOnboardingGate } from "./lib/onboarding";
import { bootstrapWorkspace } from "./workspace-bootstrap";
import { provisionAssistantModelKey } from "./assistant-key-bootstrap";
import {
  initialSteeringRepoState,
  settingsWithSteeringRepo,
  startSteeringRepoProvision,
} from "./steering_repo.provision";

/**
 * The org bootstrap: the organization row, the creator's owner membership,
 * the org's graph placement (pooled, or its own Neo4j database — ADR-098),
 * the IAM roles and grants, the first workspace with everything a workspace
 * needs, the onboarding gate opened on that workspace (#2967: the
 * organization exists, so the gate is at `wrap`), and the $5 signup grant
 * (grantSignupCredits), in one system transaction. The grant funds the
 * in-app agent's platform-paid turns (ADR-053 §2; apps/app/ARCHITECTURE.md
 * §9, 2026-09-15), so an org never
 * exists without it. No other billing row is written: no contract_terms,
 * gau_buckets or gau_settlements row, and the billing settings row appears on
 * the first write that needs it.
 *
 * A caller that sends `workspace: null` gets no first workspace. The gate
 * opens with no workspace, and the org's first `create_workspace` fills it in
 * (#4582). The web app does this so its welcome flow can ask you to name the
 * first workspace. Every other caller omits the field and gets "Default".
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
  const namespaceTaken = () =>
    new HandlerError({
      code: "conflict",
      reason: "namespace_taken",
      message: `namespace "${input.namespace ?? ""}" already in use`,
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
    // tenancy: system bypass via withSystemDb (bootstrap — writes the new org's
    // root rows and reads every namespace to keep it globally unique; no tenant
    // scope exists for an org that does not exist yet)
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
      // A namespace the operator chose is used verbatim: an agent key is
      // printed from it, so a suffix added here would hand them a key they
      // did not pick. A taken one is refused instead.
      if (
        input.namespace !== undefined &&
        takenNamespaces.has(input.namespace)
      ) {
        throw namespaceTaken();
      }
      const namespace =
        input.namespace ?? deriveNamespace(input.slug, takenNamespaces);

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
      // workspace has no page to land on. Skipped when the caller sent
      // `workspace: null`, because the web app's welcome flow names the first
      // workspace itself (#4582).
      //
      // It has no repository yet. The provision job started below creates
      // its steering repo once the owner connects GitHub or GitLab, and code
      // repositories are linked afterwards, the same as `create_workspace`.
      const workspace =
        input.workspace === null
          ? null
          : await bootstrapWorkspace({
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
      // The one-time governed-action grant (ADR-NEW, signup grant): sized and
      // timed by the Free plan row as it stands now, and committed with the
      // org so no organisation exists without it.
      await issueSignupGrant(tx, org.id, org.createdAt);

      await openOnboardingGate(tx, {
        orgId: org.id,
        workspaceId: workspace?.id ?? null,
        now: org.createdAt,
      });

      // The first state of both steering repos (#4450): the organization's
      // `<org>/oxagen-config` and the first workspace's own. The provision jobs start
      // after this commits and record their progress here. With no first
      // workspace, only the organization's repo starts. `create_workspace`
      // starts the workspace's own when it makes one.
      const steering = initialSteeringRepoState(org.createdAt);
      await tx
        .update(schema.organizations)
        .set({
          settings: settingsWithSteeringRepo(
            schema.organizations.settings,
            steering,
          ),
        })
        .where(eq(schema.organizations.id, org.id));
      if (workspace !== null) {
        await tx
          .update(schema.workspaces)
          .set({
            settings: settingsWithSteeringRepo(
              schema.workspaces.settings,
              steering,
            ),
          })
          .where(eq(schema.workspaces.id, workspace.id));
      }

      return { org, workspace, steering };
    });

    logger.info(
      {
        orgId: created.org.id,
        slug: created.org.slug,
        workspaceId: created.workspace?.id ?? null,
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

    // Start the provision jobs: the organization's, and the first
    // workspace's when there is one. A new organization has no GitHub or
    // GitLab connection yet, so each job stops at `pick_connection` and
    // records that it waits for one. Onboarding sends the event again once
    // the owner connects. A send that fails is recorded on the setting, never
    // thrown: the organization already exists.
    const { workspace } = created;
    await Promise.all([
      startSteeringRepoProvision(
        { orgId: created.org.id, workspaceId: null, actorUserId: userId },
        created.steering,
      ),
      ...(workspace === null
        ? []
        : [
            startSteeringRepoProvision(
              {
                orgId: created.org.id,
                workspaceId: workspace.id,
                actorUserId: userId,
              },
              created.steering,
            ),
          ]),
    ]);

    return {
      publicId: created.org.publicId,
      name: created.org.name,
      slug: created.org.slug,
      type: created.org.type,
      createdAt: created.org.createdAt.toISOString(),
      workspace:
        workspace === null
          ? null
          : { publicId: workspace.publicId, slug: workspace.slug },
    };
  } catch (err) {
    if (isUniqueViolation(err, "organizations_slug_idx")) {
      logger.warn(
        { slug: input.slug, orgId: ctx.orgId },
        "organization.create: slug conflict",
      );
      throw slugTaken();
    }
    if (err instanceof HandlerError && err.reason === "namespace_taken") {
      throw err;
    }
    // Only a namespace the caller chose is theirs to hear about; a derived one
    // that lost a race is the server's collision and stays a 500.
    if (
      input.namespace !== undefined &&
      isUniqueViolation(err, "organizations_namespace_idx")
    ) {
      logger.warn(
        { namespace: input.namespace, orgId: ctx.orgId },
        "organization.create: namespace conflict",
      );
      throw namespaceTaken();
    }
    logger.error(
      { err, orgId: ctx.orgId },
      "organization.create: transaction failed",
    );
    throw err;
  }
};
