import { Hono } from "hono";
import { documentList } from "@oxagen/oxagen/contracts/document.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const documentListRoute = new Hono<AppEnv>();

documentListRoute.get("/", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  const input = documentList.input.parse({ workspace_id });
  const ctx = capabilityContext(c);
  const out = await invoke(documentList.name, input, ctx, { surface: "api" });
  return c.json(out);
});
