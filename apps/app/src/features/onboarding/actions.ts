"use server";
// The organization form's write: create_org through the kernel seam for the
// signed-in person before any organization (PretenantCtx). The handler writes
// the organization, the owner membership, IAM and the first workspace in one
// transaction and derives the namespace from the address; the result names
// that workspace's Fleet page.
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireUser } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { OrganizationForm, type OrganizationField } from "./org-form";

/**
 * A field the form refuses is `invalid` with the field and its
 * `onboarding.errors` key as the code, and no capability runs. A taken address
 * is the handler's `conflict` with code `slug_taken`.
 */
export async function createOrganizationAction(
  input: Record<OrganizationField, string>,
): Promise<ActionResult<{ to: SafePath }>> {
  const ctx = await requireUser(routes.newOrganization());
  const parsed = OrganizationForm.safeParse(input);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      ok: false,
      reason: "invalid",
      code: issue?.message ?? "invalid_input",
      field: issue?.path.map(String).join(".") ?? "",
    };
  }
  const { name, slug, workspaceName, workspaceSlug } = parsed.data;
  const result = await kernelWrite(ctx, organizationCreate, {
    name,
    slug,
    workspace: { name: workspaceName, slug: workspaceSlug },
  });
  return result.ok
    ? {
        ok: true,
        value: {
          to: routes.fleet(result.value.slug, result.value.workspace.slug),
        },
      }
    : result;
}
