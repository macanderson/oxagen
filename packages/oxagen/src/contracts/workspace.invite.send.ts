import { z } from "zod";
import { registerCapability } from "../registry";

export const workspaceInviteSend = registerCapability({
  name: "send_workspace_invite",
  domain: "workspace",
  description: "Send a workspace invitation to an email address",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    email: z.string().email(),
    role: z.enum(["member", "admin", "owner"]).default("member"),
    message: z.string().optional(),
  }),
  output: z.object({
    id: z.string(),
    status: z.string(),
    expires_at: z.string(),
  }),
});

export type WorkspaceInviteSendInput = z.output<
  typeof workspaceInviteSend.input
>;
export type WorkspaceInviteSendOutput = z.output<
  typeof workspaceInviteSend.output
>;
