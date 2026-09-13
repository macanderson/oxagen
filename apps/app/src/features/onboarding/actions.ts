"use server";
// Gate step 1's write. Fixture mode validates and moves on to the fixture org
// without writing anything; live mode creates the tenant (create-organization.ts).
import { redirect } from "next/navigation";
import { isFixtureMode } from "@/server/fixture-session";
import { getAuthUser } from "../auth/session";
import { FIXTURE_SCOPE } from "./fixture";
import {
  OrganizationForm,
  type OrganizationField,
  type OrgFormErrorKey,
} from "./org-form";

export type CreateOrganizationState =
  | { ok: true; to: string }
  | {
      ok: false;
      fields?: Partial<Record<OrganizationField, OrgFormErrorKey>>;
      error?: "failed";
    };

function wrapStep(orgSlug: string, wsSlug: string): string {
  return `/welcome/wrap?${new URLSearchParams({ org: orgSlug, ws: wsSlug }).toString()}`;
}

export async function createOrganizationAction(
  input: Record<OrganizationField, string>,
): Promise<CreateOrganizationState> {
  const user = await getAuthUser();
  if (!user) redirect("/login?next=%2Fwelcome");

  const parsed = OrganizationForm.safeParse(input);
  if (!parsed.success) {
    const fields: Partial<Record<OrganizationField, OrgFormErrorKey>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as OrganizationField | undefined;
      if (field && !fields[field])
        fields[field] = issue.message as OrgFormErrorKey;
    }
    return { ok: false, fields };
  }

  if (isFixtureMode())
    return {
      ok: true,
      to: wrapStep(FIXTURE_SCOPE.org.slug, FIXTURE_SCOPE.ws.slug),
    };

  const { createOrganization } = await import("./create-organization");
  const result = await createOrganization(user.id, parsed.data);
  if (result.ok)
    return { ok: true, to: wrapStep(result.orgSlug, result.workspaceSlug) };
  if (result.error === "slugTaken")
    return { ok: false, fields: { slug: "slugTaken" } };
  if (result.error === "namespaceTaken")
    return { ok: false, fields: { namespace: "namespaceTaken" } };
  if (result.error === "invalid")
    return { ok: false, fields: { slug: "slugInvalid" } };
  return { ok: false, error: "failed" };
}
