"use server";
import { z } from "zod";
import {
  withSystemDb,
  schema,
  isUniqueViolation,
  deriveNamespace,
} from "@oxagen/database";
// tenancy: unscoped seam (org creation bootstrap — no org or workspace exists
// yet at call time; this action IS what creates the first tenant identity, so
// a scope cannot be entered before the org row exists; withSystemDb bypasses
// RLS deliberately)
import { grantFreeCredits } from "@oxagen/billing";
import { logger } from "@oxagen/handlers/logger";
import { ingestImageFromUrl, isIngestibleImageUrl } from "@oxagen/storage";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { getSessionOrRedirect } from "@/lib/session";
import { bootstrapOrgIAM } from "@oxagen/handlers/iam-provision";
import { bootstrapWorkspaceAgents } from "@oxagen/handlers/workspace-agents";
import { seedWorkspaceDefaultRegistrySystem } from "@oxagen/handlers/workspace-registry-seed";
import { seedWorkspaceDefaultCapabilitiesSystem } from "@oxagen/handlers/workspace-capability-seed";
import { seedWorkspaceDefaultSkillsSystem } from "@oxagen/handlers/skill-workspace-seed";
import { seedWorkspaceDefaultEnvironmentSystem } from "@oxagen/handlers/workspace-environment-seed";

// An avatar URL we already own — served from our Vercel Blob store. Such URLs
// (produced by /api/v1/upload/avatar) are persisted as-is; no re-ingest needed.
function isOwnedBlobUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

/**
 * Resolve the org logo URL to persist from the submitted `avatarUrl`.
 *
 * - empty               → null (logo is optional).
 * - our own blob URL    → kept as-is (uploaded through our route).
 * - trusted OAuth host  → copied into our blob store so we own the binary
 *                         (storage boundary); falls back to the external URL
 *                         only if the copy fails, so the avatar still renders.
 * - anything else       → dropped (null). We never fetch or store an arbitrary
 *                         user-supplied URL — that would be an SSRF / stored-
 *                         reference risk.
 */
async function resolveOrgAvatarUrl(
  submitted: string | undefined,
  ownerId: string,
): Promise<string | null> {
  const url = submitted?.trim();
  if (!url) return null;
  if (isOwnedBlobUrl(url)) return url;
  if (isIngestibleImageUrl(url)) {
    const ingested = await ingestImageFromUrl({ url, kind: "avatar", ownerId });
    return ingested?.url ?? url;
  }
  return null;
}

// FormData schema: captures all flat fields from NewOrgForm.
// Fields forwarded via hidden inputs (type, industry, employeeSize) are always
// present but may be empty strings — converted to undefined downstream before
// DB insert.
const FormSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(2).max(40),
  type: z.enum(["personal", "business"]).default("business"),
  website: z.string().optional(),
  industry: z.string().optional(),
  employeeSize: z.string().optional(),
  // Logo URL produced by the avatar upload endpoint. Written directly to the
  // organizations row (the capability contract does not carry avatarUrl), the
  // same pattern the settings general-action uses.
  avatarUrl: z.string().url().max(2048).optional().or(z.literal("")),
});

// Coerce an empty string to undefined so we don't write blank strings into
// optional columns.
function nonEmpty(s: string | undefined): string | undefined {
  return s && s.trim().length > 0 ? s.trim() : undefined;
}

// One server action wraps two capabilities so tenant creation always
// leaves the user inside at least one workspace. Both inserts share a
// transaction so partial state is impossible.
export async function createOrgAction(
  formData: FormData,
): Promise<
  | { ok: true; orgSlug: string; workspaceSlug: string }
  | { ok: false; error: string }
> {
  const session = await getSessionOrRedirect();
  const raw = Object.fromEntries(formData);
  const parsedForm = FormSchema.safeParse(raw);
  if (!parsedForm.success) {
    return {
      ok: false,
      error: parsedForm.error.issues[0]?.message ?? "Invalid form input",
    };
  }

  const fd = parsedForm.data;

  const isBusiness = fd.type === "business";

  // Validate the FULL payload through the capability contract so this onboarding
  // surface enforces the exact same business-field rules as the API and MCP
  // surfaces (no drift, defense in depth — a crafted POST must not bypass them).
  const orgInput = organizationCreate.input.safeParse({
    name: fd.name,
    slug: fd.slug,
    type: fd.type,
    website: isBusiness ? nonEmpty(fd.website) : undefined,
    industry: isBusiness ? nonEmpty(fd.industry) : undefined,
    employeeSize: isBusiness ? nonEmpty(fd.employeeSize) : undefined,
  });
  if (!orgInput.success) {
    return {
      ok: false,
      error: orgInput.error.issues[0]?.message ?? "Invalid organization",
    };
  }
  const org = orgInput.data;

  const workspaceInput = workspaceCreate.input.safeParse({
    name: "Default",
    slug: "default",
  });
  if (!workspaceInput.success) return { ok: false, error: "Invalid workspace" };

  // Resolve the logo BEFORE the transaction — copying an OAuth avatar into our
  // blob store is a network call that must not run inside the DB transaction.
  // Best-effort: never block org creation on it.
  const resolvedAvatarUrl = await resolveOrgAvatarUrl(
    fd.avatarUrl,
    session.user.id,
  );

  try {
    const result = await withSystemDb(async (tx) => {
      // Derive the immutable, globally-unique org namespace from the slug,
      // avoiding any already taken. The unique index is the hard race guard.
      const takenOrgNamespaces = new Set(
        (
          await tx
            .select({ namespace: schema.organizations.namespace })
            .from(schema.organizations)
        ).map((r) => r.namespace.toLowerCase()),
      );
      const orgNamespace = deriveNamespace(org.slug, takenOrgNamespaces);

      const [tenant] = await tx
        .insert(schema.organizations)
        .values({
          name: org.name,
          slug: org.slug,
          namespace: orgNamespace,
          planType: org.planSlug,
          status: "active",
          type: org.type,
          website: org.website ?? null,
          industry: org.industry ?? null,
          employeeSize: org.employeeSize ?? null,
          avatarUrl: resolvedAvatarUrl,
          createdByUserId: session.user.id,
          updatedByUserId: session.user.id,
        })
        .returning();
      if (!tenant) throw new Error("Insert failed");

      await tx.insert(schema.orgUsers).values({
        orgId: tenant.id,
        userId: session.user.id,
        role: "owner",
        joinedAt: new Date(),
        createdByUserId: session.user.id,
        updatedByUserId: session.user.id,
      });

      // The org was just created, so it has no other workspaces yet — the
      // taken set is empty. The (org_id, namespace) unique index still guards.
      const workspaceNamespace = deriveNamespace(
        workspaceInput.data.slug,
        new Set<string>(),
      );

      const [workspace] = await tx
        .insert(schema.workspaces)
        .values({
          orgId: tenant.id,
          name: workspaceInput.data.name,
          slug: workspaceInput.data.slug,
          namespace: workspaceNamespace,
          createdByUserId: session.user.id,
          updatedByUserId: session.user.id,
        })
        .returning();
      if (!workspace) throw new Error("Workspace insert failed");

      await tx.insert(schema.workspaceUsers).values({
        workspaceId: workspace.id,
        userId: session.user.id,
        role: "owner",
        joinedAt: new Date(),
        createdByUserId: session.user.id,
        updatedByUserId: session.user.id,
      });

      // Bootstrap full IAM state atomically with org creation: system roles,
      // owner principal, owner role assignment, and role_grants from defaultRoles.
      await bootstrapOrgIAM({
        orgId: tenant.id,
        ownerUserId: session.user.id,
        actorUserId: session.user.id,
        tx,
      });

      // Bootstrap the built-in qa-chat agent atomically with workspace creation
      // so the workspace is immediately usable from the ask/chat surface.
      await bootstrapWorkspaceAgents({
        workspaceId: workspace.id,
        orgId: tenant.id,
        userId: session.user.id,
        tx,
      });

      return {
        orgId: tenant.id,
        orgSlug: tenant.slug,
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
      };
    });

    // Grant the non-expiring Free signup credits ($5) outside the org
    // transaction, mirroring organizationCreateHandler. A grant hiccup must not
    // fail signup — the org already exists and the grant is recoverable.
    try {
      await grantFreeCredits(result.orgId);
    } catch (grantErr) {
      logger.error(
        { err: grantErr, orgId: result.orgId },
        "[onboarding] grantFreeCredits failed",
      );
    }

    // Seed the default MCP registry, capability packs, and builtin skills
    // outside the transaction (fire-and-log): a seed failure must NOT roll
    // back the org/workspace that was just created.
    try {
      await seedWorkspaceDefaultRegistrySystem({
        orgId: result.orgId,
        workspaceId: result.workspaceId,
      });
    } catch (seedErr) {
      logger.error(
        { err: seedErr, orgId: result.orgId, workspaceId: result.workspaceId },
        "[onboarding] seedWorkspaceDefaultRegistrySystem failed — org/workspace created; seed is recoverable via db:backfill-workspace-seeds",
      );
    }
    try {
      await seedWorkspaceDefaultCapabilitiesSystem({
        orgId: result.orgId,
        workspaceId: result.workspaceId,
      });
    } catch (seedErr) {
      logger.error(
        { err: seedErr, orgId: result.orgId, workspaceId: result.workspaceId },
        "[onboarding] seedWorkspaceDefaultCapabilitiesSystem failed — org/workspace created; seed is recoverable via db:backfill-workspace-seeds",
      );
    }
    try {
      await seedWorkspaceDefaultSkillsSystem({
        orgId: result.orgId,
        workspaceId: result.workspaceId,
      });
    } catch (seedErr) {
      logger.error(
        { err: seedErr, orgId: result.orgId, workspaceId: result.workspaceId },
        "[onboarding] seedWorkspaceDefaultSkillsSystem failed — org/workspace created; seed is recoverable via db:backfill-workspace-seeds",
      );
    }
    try {
      await seedWorkspaceDefaultEnvironmentSystem({
        orgId: result.orgId,
        workspaceId: result.workspaceId,
      });
    } catch (seedErr) {
      logger.error(
        { err: seedErr, orgId: result.orgId, workspaceId: result.workspaceId },
        "[onboarding] seedWorkspaceDefaultEnvironmentSystem failed — org/workspace created; seed is recoverable via db:backfill-workspace-seeds",
      );
    }

    return {
      ok: true,
      orgSlug: result.orgSlug,
      workspaceSlug: result.workspaceSlug,
    };
  } catch (err) {
    // The only unique index reachable here is organizations_slug_idx — the
    // workspace insert always uses slug "default" under a freshly-minted org id,
    // so a 23505 means the org slug collided.
    if (isUniqueViolation(err)) {
      return { ok: false, error: `Slug "${org.slug}" is already taken` };
    }
    // Never surface a raw driver/SQL error string to the user — it can leak
    // schema and query details. Log the real cause for diagnosis and return a
    // generic, safe message.
    logger.error(
      { err, slug: org.slug },
      "[onboarding] createOrgAction failed",
    );
    return {
      ok: false,
      error: "Failed to create organization. Please try again.",
    };
  }
}
