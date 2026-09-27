import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runIssuesGet } from "@oxagen/oxagen/contracts/run.issues.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read the issues one run worked on, with each one's state on GitHub now (#3970). */
export const runIssuesGetRoute = new Hono<AppEnv>();

runIssuesGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runIssuesGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runIssuesGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
