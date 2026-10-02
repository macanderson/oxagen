import { z } from "zod";
import { registerCapability } from "../registry";

export const workspaceInviteSend = registerCapability({
  name: "send_workspace_invite",
  domain: "workspace",
  description: "Send a workspace invitation to an email address",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  mutates: true,
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  orgLevel: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "workspace" },
  sensitivity: "low",
  defaultEffect: "deny",
  // An invitation joins the organization, so only the org roles send one.
  // The handler always asked for them; the workspace grants here admitted
  // nobody and are gone (#5228).
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
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
