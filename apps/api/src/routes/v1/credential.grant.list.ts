import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the credential broker's grants, newest first. Mounted on the org-scoped router behind session auth. */
export const credentialGrantListRoute = new Hono<AppEnv>();

credentialGrantListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = credentialGrantList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(credentialGrantList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
