import { Hono } from "hono";
import { agentMemoryEvidenceAttach } from "@oxagen/oxagen/contracts/agent.memory.evidence.attach";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryEvidenceAttachRoute = new Hono<AppEnv>();

agentMemoryEvidenceAttachRoute.post("/", async (c) => {
  const body = agentMemoryEvidenceAttach.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryEvidenceAttach.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
