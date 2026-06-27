import { Hono } from "hono";
import { secretImportEnv } from "@oxagen/oxagen/contracts/secret.import_env";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const secretImportEnvRoute = new Hono<AppEnv>();

secretImportEnvRoute.post("/", async (c) => {
  const body = secretImportEnv.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(secretImportEnv.name, body, ctx, { surface: "api" });
  return c.json(out);
});
