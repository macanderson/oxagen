import { z } from "zod";
import { registerCapability } from "../registry";

// Invite a user to an org by email. Seat enforcement is applied by the handler
// before the invitation is persisted — if the org has no available license the
// call fails with a typed SeatLimitError.
export const orgMemberAdd = registerCapability({
  name: "add_org_member",
  domain: "org",
  description:
    "Invite a user to join the org by email. Enforces seat/license limits; fails with a typed error when no seat is available.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: true,
    riskLevel: "medium",
    category: "organization",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    email: z.string().email(),
    role: z.string().min(1),
  }),
  output: z.object({
    invitationId: z.string(),
    email: z.string().email(),
    role: z.string(),
    status: z.literal("pending"),
    expiresAt: z.string().nullable(),
  }),
});

export type OrgMemberAddInput = z.output<typeof orgMemberAdd.input>;
export type OrgMemberAddOutput = z.output<typeof orgMemberAdd.output>;
