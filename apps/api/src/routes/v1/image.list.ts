import { Hono } from "hono";
import { imageList } from "@oxagen/oxagen/contracts/image.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const imageListRoute = new Hono<AppEnv>();

imageListRoute.get("/", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  const input = imageList.input.parse({ workspace_id });
  const ctx = capabilityContext(c);
  const out = await invoke(imageList.name, input, ctx, { surface: "api" });
  return c.json(out);
});
