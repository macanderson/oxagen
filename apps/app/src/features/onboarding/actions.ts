"use server";
// The organization form's write: creates the tenant (create-organization.ts)
// and names the Fleet page of its first workspace as where to go next. A
// refusal names the field and the catalog key the form shows under it.
import type { ActionResult } from "@/server/kernel";
import { requireUser } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  OrganizationForm,
  type OrganizationField,
  organizationFieldErrors,
} from "./org-form";

function refuse(
  reason: "invalid" | "conflict",
  field: OrganizationField,
  code: string,
): ActionResult<never> {
  return { ok: false, reason, code, field };
}

export async function createOrganizationAction(
  input: Record<OrganizationField, string>,
): Promise<ActionResult<{ to: SafePath }>> {
  const { userId } = await requireUser(routes.newOrganization());

  const parsed = OrganizationForm.safeParse(input);
  if (!parsed.success) {
    const [field, code] =
      Object.entries(organizationFieldErrors(parsed.error.issues))[0] ?? [];
    return {
      ok: false,
      reason: "invalid",
      code: code ?? "invalid_input",
      field,
    };
  }

  const { createOrganization } = await import("./create-organization");
  const result = await createOrganization(userId, parsed.data);
  if (result.ok)
    return {
      ok: true,
      value: { to: routes.fleet(result.orgSlug, result.workspaceSlug) },
    };
  if (result.error === "slugTaken")
    return refuse("conflict", "slug", "slugTaken");
  if (result.error === "namespaceTaken")
    return refuse("conflict", "namespace", "namespaceTaken");
  if (result.error === "slugReserved")
    return refuse("invalid", "slug", "slugReserved");
  if (result.error === "workspaceSlugReserved")
    return refuse("invalid", "workspaceSlug", "workspaceSlugReserved");
  if (result.error === "invalid")
    return refuse("invalid", "slug", "slugInvalid");
  return { ok: false, reason: "unavailable", code: "failed" };
}
