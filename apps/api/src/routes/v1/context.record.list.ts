import { Hono } from "hono";
import { contextRecordList } from "@oxagen/oxagen/contracts/context.record.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const contextRecordListRoute = new Hono<AppEnv>();

contextRecordListRoute.get("/", async (c) => {
  const status = c.req.query("status");
  const limit =
    c.req.query("limit") !== undefined
      ? Number(c.req.query("limit"))
      : undefined;
  const offset =
    c.req.query("offset") !== undefined
      ? Number(c.req.query("offset"))
      : undefined;
  const input = contextRecordList.input.parse({ status, limit, offset });
  const ctx = capabilityContext(c);
  const out = await invoke(contextRecordList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
