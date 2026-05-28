import { Hono } from "hono";
import { listCapabilities } from "@oxagen/oxagen";
import { tenantCreateTool } from "./tools/tenant.create.js";
import { workspaceCreateTool } from "./tools/workspace.create.js";
import { billingSubscriptionReadTool } from "./tools/billing.subscription.read.js";
import { chatMessageSendTool } from "./tools/chat.message.send.js";

export type McpTool = {
  name: string;
  description: string;
  invoke: (raw: unknown) => Promise<unknown>;
};

const tools: McpTool[] = [
  tenantCreateTool,
  workspaceCreateTool,
  billingSubscriptionReadTool,
  chatMessageSendTool,
];

export function buildServer() {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // /mcp/tools — list registered tools so clients can discover surface.
  app.get("/mcp/tools", (c) => {
    return c.json({
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      capabilities: listCapabilities().map((cap) => ({
        name: cap.name,
        domain: cap.domain,
        mode: cap.mode,
      })),
    });
  });

  // /mcp/tools/:name — invoke by name; the handler stubs throw "not
  // implemented" until apps/api wires them in.
  app.post("/mcp/tools/:name", async (c) => {
    const name = c.req.param("name");
    const tool = tools.find((t) => t.name === name);
    if (!tool) return c.json({ error: "unknown tool" }, 404);
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await tool.invoke(body);
      return c.json({ result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
