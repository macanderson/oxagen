import { Hono } from "hono";
import { agentMemoryImportCommit } from "@oxagen/oxagen/contracts/agent.memory_import.commit";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryImportCommitRoute = new Hono<AppEnv>();

// Persists the confirmed drafts into the AgentMemory graph → 201.
agentMemoryImportCommitRoute.post("/", async (c) => {
  const body = agentMemoryImportCommit.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryImportCommit.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
