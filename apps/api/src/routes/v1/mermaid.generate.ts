import { Hono } from "hono";
import { mermaidGenerate } from "@oxagen/oxagen/contracts/mermaid.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const mermaidGenerateRoute = new Hono<AppEnv>();

// Mermaid diagram generation: validates and passes through the diagram source,
// returning a render directive that points at the client-side mermaid-diagram
// chat component. Route is org + workspace scoped.
mermaidGenerateRoute.post("/", async (c) => {
  const body = mermaidGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(mermaidGenerate.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
