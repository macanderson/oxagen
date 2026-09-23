import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema } from "../tacho/schemas";

export const containedMeasurementSchema = z
  .object({
    profile: z.literal("oxagen-linux-docker-v1"),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    configurationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    gatewayOnlyEgress: z.literal(true),
    workspaceOnlyWrites: z.literal(true),
    readOnlyHooks: z.literal(true),
  })
  .strict();

export const tachoContainedLaunchRegister = registerCapability({
  name: "register_contained_launch",
  domain: "tacho",
  description:
    "Register a launch measured by the enrolled host's trusted containment launcher.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      session_uuid: z.string().uuid(),
      genesis_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      measurement: containedMeasurementSchema,
    })
    .strict(),
  output: z.object({ registered: z.literal(true) }).strict(),
});
