import { z } from "zod";
import { registerCapability } from "../registry";

export const agentUiRender = registerCapability({
  name: "render_agent_ui",
  domain: "agent",
  description: "Render a UI component from an agent response",
  mode: "sync",
  surfaces: ["agent"],
  layers: ["schema", "docs", "unit"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "ui" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow" },
    workspace: { Member: "allow" },
  },
  input: z.object({
    componentId: z.string().min(1).describe("UI component identifier"),
    props: z.record(z.unknown()).default({}).describe("Component props"),
  }),
  output: z.object({
    render: z.object({
      componentId: z.string().describe("UI component identifier"),
      props: z.record(z.unknown()).describe("Component props"),
    }),
  }),
});

export type AgentUiRenderInput = z.output<typeof agentUiRender.input>;
export type AgentUiRenderOutput = z.output<typeof agentUiRender.output>;
