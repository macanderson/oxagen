import { Hono } from "hono";
import { documentRead } from "@oxagen/oxagen/contracts/document.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const documentReadRoute = new Hono<AppEnv>();

documentReadRoute.get("/", async (c) => {
  const document_id = c.req.query("document_id") ?? "";
  const input = documentRead.input.parse({ document_id });
  const ctx = capabilityContext(c);
  const out = await invoke(documentRead.name, input, ctx, { surface: "api" });
  return c.json(out);
});
