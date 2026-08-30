import { Hono } from "hono";
import { agentMemoryImportParse } from "@oxagen/oxagen/contracts/agent.memory_import.parse";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryImportParseRoute = new Hono<AppEnv>();

// Read-only preview: extract + classify drafts from uploaded docs, persist
// nothing → 200, not 201.
agentMemoryImportParseRoute.post("/", async (c) => {
  const body = agentMemoryImportParse.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryImportParse.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
