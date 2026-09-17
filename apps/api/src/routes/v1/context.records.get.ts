import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextRecordsGet } from "@oxagen/oxagen/contracts/context.records.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Get one published or appended record. Mounted on the org-scoped router behind session auth (ADR-061). */
export const contextRecordsGetRoute = new Hono<AppEnv>();

contextRecordsGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextRecordsGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextRecordsGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
