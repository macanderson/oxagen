// Gate step 1: name the organization and its first workspace. Issues carry keys
// under `onboarding.errors.*`.
import { z } from "zod";
import {
  NAMESPACE_PATTERN,
  RESERVED_ORG_SLUGS,
  RESERVED_WORKSPACE_SLUGS,
  SLUG_PATTERN,
} from "./agent-key";

export type OrgFormErrorKey =
  | "orgNameRequired"
  | "orgNameTooLong"
  | "slugInvalid"
  | "slugReserved"
  | "namespaceInvalid"
  | "workspaceNameRequired"
  | "workspaceNameTooLong"
  | "workspaceSlugInvalid"
  | "workspaceSlugReserved"
  | "slugTaken"
  | "namespaceTaken";

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
export type OrganizationFormInput = z.input<typeof OrganizationForm>;
export type OrganizationFormValue = z.output<typeof OrganizationForm>;
export type OrganizationField = keyof OrganizationFormInput;
