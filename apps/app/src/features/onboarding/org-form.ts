// The organization form: name the organization, its address and the first
// workspace. Issues carry keys under `onboarding.errors.*`. An address is
// lowercase letters, digits and hyphens; the `create_org` contract owns the
// reserved org and workspace slug sets and derives the immutable namespace
// from the address.
import { z } from "zod";
import {
  RESERVED_ORG_SLUGS,
  RESERVED_WORKSPACE_SLUGS,
} from "@oxagen/oxagen/contracts/org.create";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Lowercase, hyphen-separated, trimmed of edge hyphens, at most `max` characters. */
export function toSlug(input: string, max = 40): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

const ORG_FORM_ERROR_KEYS = [
  "orgNameRequired",
  "orgNameTooLong",
  "slugInvalid",
  "slugReserved",
  "workspaceNameRequired",
  "workspaceNameTooLong",
  "workspaceSlugInvalid",
  "workspaceSlugReserved",
  "slugTaken",
] as const;
export type OrgFormErrorKey = (typeof ORG_FORM_ERROR_KEYS)[number];

const slug = (key: OrgFormErrorKey) =>
  z
    .string()
    .trim()
    .min(2, { error: key })
    .max(40, { error: key })
    .regex(SLUG_PATTERN, { error: key });

export const OrganizationForm = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "orgNameRequired" })
    .max(120, { error: "orgNameTooLong" }),
  slug: slug("slugInvalid").refine((s) => !RESERVED_ORG_SLUGS.has(s), {
    error: "slugReserved",
  }),
  workspaceName: z
    .string()
    .trim()
    .min(1, { error: "workspaceNameRequired" })
    .max(80, { error: "workspaceNameTooLong" }),
  workspaceSlug: slug("workspaceSlugInvalid").refine(
    (s) => !RESERVED_WORKSPACE_SLUGS.has(s),
    {
      error: "workspaceSlugReserved",
    },
  ),
});
type OrganizationFormInput = z.input<typeof OrganizationForm>;
export type OrganizationField = keyof OrganizationFormInput;

/** Each field's first error from a failed parse, as a catalog key; an issue outside both sets is dropped. */
export function organizationFieldErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Partial<Record<OrganizationField, OrgFormErrorKey>> {
  const fields: Partial<Record<OrganizationField, OrgFormErrorKey>> = {};
  for (const { path, message } of issues) {
    const field = OrganizationForm.keyof().options.find((f) => f === path[0]);
    const key = ORG_FORM_ERROR_KEYS.find((k) => k === message);
    if (field !== undefined && key !== undefined) fields[field] ??= key;
  }
  return fields;
}
