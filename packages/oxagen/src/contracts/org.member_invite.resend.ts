import { z } from "zod";
import { registerCapability } from "../registry";

export const resendMemberInvite = registerCapability({
  name: "resend_member_invite",
  domain: "org",
  description: "Resend a pending invitation in the calling organization.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z
    .object({ invitationPublicId: z.string().regex(/^invi_[A-Za-z0-9]+$/) })
    .strict(),
  output: z
    .object({
      invitationPublicId: z.string(),
      status: z.literal("pending"),
      expiresAt: z.string().datetime().nullable(),
    })
    .strict(),
});
