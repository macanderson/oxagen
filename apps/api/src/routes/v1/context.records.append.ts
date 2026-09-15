import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextRecordsAppend } from "@oxagen/oxagen/contracts/context.records.append";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Append one context record (the protocol's context/append); a directive is refused. Mounted on the org-scoped router behind session auth (ADR-061). */
export const contextRecordsAppendRoute = new Hono<AppEnv>();

contextRecordsAppendRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextRecordsAppend.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextRecordsAppend.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
