import { Hono } from "hono";
import { skillVersionUpload } from "@oxagen/oxagen/contracts/skill.version.upload";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillVersionUploadRoute = new Hono<AppEnv>();

skillVersionUploadRoute.post("/", async (c) => {
  const input = skillVersionUpload.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(skillVersionUpload.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
