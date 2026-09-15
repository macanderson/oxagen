"use server";
// The organization form's write: creates the tenant (create-organization.ts)
// and names the Fleet page of its first workspace as where to go next.
import { redirect } from "next/navigation";
import { getAuthUser } from "../auth/session";
import {
  OrganizationForm,
  type OrganizationField,
  type OrgFormErrorKey,
  organizationFieldErrors,
} from "./org-form";

export type CreateOrganizationState =
  | { ok: true; to: string }
  | {
      ok: false;
      fields?: Partial<Record<OrganizationField, OrgFormErrorKey>>;
      error?: "failed";
    };

function fleetPath(orgSlug: string, wsSlug: string): string {
  return `/${encodeURIComponent(orgSlug)}/${encodeURIComponent(wsSlug)}`;
}

export async function createOrganizationAction(
  input: Record<OrganizationField, string>,
): Promise<CreateOrganizationState> {
  const user = await getAuthUser();
  if (!user) redirect("/login?next=%2Fnew-organization");

  const parsed = OrganizationForm.safeParse(input);
  if (!parsed.success) {
    return { ok: false, fields: organizationFieldErrors(parsed.error.issues) };
  }

  const { createOrganization } = await import("./create-organization");
  const result = await createOrganization(user.id, parsed.data);
  if (result.ok)
    return { ok: true, to: fleetPath(result.orgSlug, result.workspaceSlug) };
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
