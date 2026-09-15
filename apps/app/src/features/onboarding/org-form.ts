// The organization form: name the organization, its address and immutable
// namespace, and the first workspace. Issues carry keys under
// `onboarding.errors.*`. The address and namespace rules are the spec's:
//   namespace: 2–6 lowercase letters or digits, immutable (App. A
//              `org.organizations.namespace`, the live `organizations_namespace_check`)
//   slug:      lowercase letters, digits and hyphens (the `create_org` contract,
//              which also owns the reserved org and workspace slug sets)
import { z } from "zod";
import {
  RESERVED_ORG_SLUGS,
  RESERVED_WORKSPACE_SLUGS,
} from "@oxagen/oxagen/contracts/org.create";

const NAMESPACE_PATTERN = /^[a-z0-9]{2,6}$/;
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

/** A namespace suggestion from a slug: its first alphanumeric run, cut to six characters. */
export function suggestNamespace(slug: string): string {
  const compact =
    slug.split("-").find((part) => part.length >= 2) ?? slug.replace(/-/g, "");
  return compact.replace(/[^a-z0-9]/g, "").slice(0, 6);
}

const ORG_FORM_ERROR_KEYS = [
  "orgNameRequired",
  "orgNameTooLong",
  "slugInvalid",
  "slugReserved",
  "namespaceInvalid",
  "workspaceNameRequired",
  "workspaceNameTooLong",
  "workspaceSlugInvalid",
  "workspaceSlugReserved",
  "slugTaken",
  "namespaceTaken",
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
  namespace: z
    .string()
    .trim()
    .regex(NAMESPACE_PATTERN, { error: "namespaceInvalid" }),
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
export type OrganizationFormValue = z.output<typeof OrganizationForm>;
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
