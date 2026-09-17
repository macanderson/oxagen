import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the workspace's published steering records. Mounted on the org-scoped router behind session auth (ADR-061). */
export const contextRecordsListRoute = new Hono<AppEnv>();

contextRecordsListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextRecordsList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextRecordsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
