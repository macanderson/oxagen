import { Hono } from "hono";
import { skillDraft } from "@oxagen/oxagen/contracts/skill.draft";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillDraftRoute = new Hono<AppEnv>();

skillDraftRoute.post("/", async (c) => {
  const input = skillDraft.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(skillDraft.name, input, ctx, { surface: "api" });
  return c.json(out);
});
