"use server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { avatarUrlSchema } from "@oxagen/oxagen/avatar";
import { withTenantDb } from "@oxagen/database";
import { schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { isAuthDenialError, isNextRedirectError } from "@/lib/auth-denial";

// Sentinel workspaceId for org-only actions (no workspace context). The RLS
// policies for org-only tables (organizations, orgUsers) use an org_only
// policy class that checks only org_id — the workspace GUC is set but not
// evaluated. The nil UUID is a valid UUID that satisfies runInTenantScope's
// uuid guard.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const OrgGeneralSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  // Lowercase letters, digits, and single hyphens — no leading/trailing or
  // doubled hyphens. Mirrors the client-side slugify() output.
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must be lowercase letters, numbers, and single hyphens",
    ),
  // https URL or designed-avatar spec string — the canonical avatar validator.
  avatarUrl: avatarUrlSchema.optional().or(z.literal("")),
});

// ---------------------------------------------------------------------------
// Result type — returns the persisted slug so the client can redirect to the
// new URL when the slug changed (the slug is the first path segment).
// ---------------------------------------------------------------------------

export type OrgGeneralActionResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Action
//
// orgSlug is bound by the server component (`.bind(null, orgSlug)`) so that
// the client only passes FormData — mirroring the profile-action pattern.
// ---------------------------------------------------------------------------

export async function updateOrgGeneralAction(
  orgSlug: string,
  formData: FormData,
): Promise<OrgGeneralActionResult> {
  try {
    // 1. Authenticate — session is required on every server action.
    const session = await getSessionOrRedirect();

    // 2. Re-resolve org from the slug (never trust client-provided IDs).
    const org = await resolveOrg(orgSlug);

    // 3. Assert membership first (IDOR guard); resolveOrg + assertOrgMember
    //    both call notFound() on failure, so we return early only for the
    //    role check below.
    await assertOrgMember(org.id, session.user.id);

    // 4. Validate inputs.
    const raw = {
      name: formData.get("name"),
      slug: formData.get("slug"),
      avatarUrl: formData.get("avatarUrl") ?? undefined,
    };
    const parsed = OrgGeneralSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }

    const { name, slug, avatarUrl } = parsed.data;

    return await runInTenantScope(
      { orgId: org.id, workspaceId: ORG_ONLY_WS },
      async () => {
        // 5. Re-read the caller's role from the DB server-side — never trust the
        //    client-side `canEdit` flag.
        const roleRows = await withTenantDb((tx) =>
          tx
            .select({ role: schema.orgUsers.role })
            .from(schema.orgUsers)
            .where(
              and(
                eq(schema.orgUsers.orgId, org.id),
                eq(schema.orgUsers.userId, session.user.id),
              ),
            )
            .limit(1),
        );

        const role = roleRows[0]?.role ?? "";
        if (!["owner", "admin"].includes(role.toLowerCase())) {
          return { ok: false, error: "Forbidden" };
        }

        // 5b. Org slug is globally unique (organizations_slug_idx). When the slug
        //     changed, guard uniqueness up front so we return a clean error rather
        //     than surfacing a raw unique-constraint violation.
        if (slug !== orgSlug) {
          const conflict = await withTenantDb((tx) =>
            tx
              .select({ id: schema.organizations.id })
              .from(schema.organizations)
              .where(eq(schema.organizations.slug, slug))
              .limit(1),
          );
          if (conflict.length > 0 && conflict[0]?.id !== org.id) {
            return { ok: false, error: "That slug is already taken." };
          }
        }

        // 6. Persist the update — and, when the slug changed, capture a history
        //    row in the SAME withTenantDb transaction so the redirect record can
        //    never lag the rename (spec §4.5). Drizzle's `transaction`
        //    semantics give us atomicity for free: either both writes commit, or
        //    neither does. If we split this across two withTenantDb calls a crash
        //    between them would leave the old URL 404-ing.
        await withTenantDb(async (tx) => {
          await tx
            .update(schema.organizations)
            .set({
              name,
              slug,
              avatarUrl: avatarUrl || null,
              updatedByUserId: session.user.id,
            })
            .where(eq(schema.organizations.id, org.id));

          if (slug !== orgSlug) {
            await tx.insert(schema.orgSlugHistory).values({
              orgId: org.id,
              oldSlug: orgSlug,
              newSlug: slug,
            });
          }
        });

        // 7. Invalidate the settings page so a refresh shows the latest values.
        //    Revalidate both the old and (if changed) the new slug path.
        revalidatePath(`/${orgSlug}/settings/general`);
        if (slug !== orgSlug) {
          revalidatePath(`/${slug}/settings/general`);
        }

        return { ok: true, slug };
      },
    );
  } catch (err) {
    // `getSessionOrRedirect()` signals "no session" by throwing the NEXT_REDIRECT
    // sentinel, and `resolveOrg()` / `assertOrgMember()` signal denial by throwing
    // the notFound() NEXT_HTTP_ERROR_FALLBACK sentinel. Both MUST escape this
    // handler for Next to turn them into a redirect / 404 — swallowing them
    // returns the raw digest string ("NEXT_REDIRECT;…") to the browser as if it
    // were an error message, and the caller never reaches the login page.
    if (isNextRedirectError(err) || isAuthDenialError(err)) throw err;
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred";
    return { ok: false, error: message };
  }
}
