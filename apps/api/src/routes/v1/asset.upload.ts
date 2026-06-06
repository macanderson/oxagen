import { Hono } from "hono";
import { assetUpload } from "@oxagen/oxagen/contracts/asset.upload";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const assetUploadRoute = new Hono<AppEnv>();

assetUploadRoute.post("/", async (c) => {
  const body = assetUpload.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(assetUpload.name, body, ctx, { surface: "api" });
  return c.json(result);
});
