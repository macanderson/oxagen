// The organization form (onboarding step 1): name the organization and its
// namespace. The address is derived from the name, so it is not typed. Issues
// carry keys under `onboarding.errors.*`. The `create_org` contract owns the
// reserved org slug set and the namespace's shape, and stores a chosen
// namespace verbatim. The first workspace comes two steps later, once a code
// host is connected, because a workspace needs a steering repo.
import { z } from "zod";
import {
  ORG_NAMESPACE_PATTERN,
  RESERVED_ORG_SLUGS,
  slugFromName,
} from "@oxagen/oxagen/contracts/org.create";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The slug a name suggests, by the one rule every name-made slug follows
 * (`slugFromName`, ADR-198): spaces become hyphens and every other special
 * character, apostrophes included, is dropped.
 */
export function toSlug(input: string, max = 40): string {
  return slugFromName(input, max);
}

/** The namespace a name suggests: its letters and digits, at most six. */
export function toNamespace(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 6);
}

const ORG_FORM_ERROR_KEYS = [
  "orgNameRequired",
  "orgNameTooLong",
  "slugInvalid",
  "slugReserved",
  "namespaceInvalid",
  "namespaceTaken",
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
  namespace: z
    .string()
    .trim()
    .regex(ORG_NAMESPACE_PATTERN, { error: "namespaceInvalid" }),
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
