"use server";
// The organization form's write: creates the tenant (create-organization.ts)
// and names the Fleet page of its first workspace as where to go next.
import { requireUser } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  OrganizationForm,
  type OrganizationField,
  type OrgFormErrorKey,
  organizationFieldErrors,
} from "./org-form";

export type CreateOrganizationState =
  | { ok: true; to: SafePath }
  | {
      ok: false;
      fields?: Partial<Record<OrganizationField, OrgFormErrorKey>>;
      error?: "failed";
    };

export async function createOrganizationAction(
  input: Record<OrganizationField, string>,
): Promise<CreateOrganizationState> {
  const { userId } = await requireUser(routes.newOrganization());

  const parsed = OrganizationForm.safeParse(input);
  if (!parsed.success) {
    return { ok: false, fields: organizationFieldErrors(parsed.error.issues) };
  }

  const { createOrganization } = await import("./create-organization");
  const result = await createOrganization(userId, parsed.data);
  if (result.ok)
    return { ok: true, to: routes.fleet(result.orgSlug, result.workspaceSlug) };
  if (result.error === "slugTaken")
    return { ok: false, fields: { slug: "slugTaken" } };
  if (result.error === "slugReserved")
    return { ok: false, fields: { slug: "slugReserved" } };
  if (result.error === "workspaceSlugReserved")
    return { ok: false, fields: { workspaceSlug: "workspaceSlugReserved" } };
  if (result.error === "namespaceTaken")
    return { ok: false, fields: { namespace: "namespaceTaken" } };
  if (result.error === "invalid")
    return { ok: false, fields: { slug: "slugInvalid" } };
  return { ok: false, error: "failed" };
}
