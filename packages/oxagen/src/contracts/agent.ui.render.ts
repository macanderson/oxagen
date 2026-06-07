import { z } from "zod";
import { registerCapability } from "../registry";

export const agentUiRender = registerCapability({
  name: "agent.ui.render",
  domain: "agent",
  description:
    "Emit a render directive telling the chat UI to mount a registered component inline. The SSE route extracts result.render and emits a component event.",
  mode: "sync",
  surfaces: ["agent"],
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "ui" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    componentId: z.string().min(1).describe("ID of the registered chat component to render"),
    props: z.record(z.unknown()).default({}).describe("Props forwarded to the component"),
  }),
  output: z.object({
    render: z.object({
      componentId: z.string(),
      props: z.record(z.unknown()),
    }),
  }),
});

export type AgentUiRenderInput = z.output<typeof agentUiRender.input>;
export type AgentUiRenderOutput = z.output<typeof agentUiRender.output>;
