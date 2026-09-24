import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { publishedSteeringGet } from "@oxagen/oxagen/contracts/context.steering.published.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The published `.oxagen/` tree with every file's text, for `oxagen pull` (`get_published_steering`). A POST because it takes an optional binding id and makes live GitHub reads; an empty body `{}` reads the main repository. Mounted on the org-scoped router. */
export const publishedSteeringGetRoute = new Hono<AppEnv>();

publishedSteeringGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = publishedSteeringGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(publishedSteeringGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
