/**
 * The signed policy bundle a host caches and evaluates locally
 * (docs/specs/tacho/spec.md section 7.1). Machine-to-machine, authenticated
 * by the host's API key. `etag` lets the collector poll cheaply: an
 * unchanged bundle answers `not_modified` with no body.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema, policyBundleSchema } from "../tacho/schemas";

export const tachoBundleGet = registerCapability({
  name: "get_tacho_bundle",
  domain: "tacho",
  description:
    "Fetch the signed policy bundle an enrolled Tacho host caches and evaluates locally.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      etag: z.string().max(128).optional(),
    })
    .strict(),
  output: z
    .object({
      not_modified: z.boolean(),
      etag: z.string().min(1),
      bundle: policyBundleSchema.nullable(),
    })
    .strict()
    .superRefine((output, context) => {
      if (output.not_modified === (output.bundle !== null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bundle"],
          message: "bundle is present exactly when not_modified is false",
        });
      }
    }),
});

export type TachoBundleGetInput = z.output<typeof tachoBundleGet.input>;
export type TachoBundleGetOutput = z.output<typeof tachoBundleGet.output>;
