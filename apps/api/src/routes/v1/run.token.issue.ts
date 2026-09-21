import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { runTokenIssue } from "@oxagen/oxagen/contracts/run.token.issue";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const runTokenIssueRoute = new Hono<AppEnv>();
runTokenIssueRoute.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
runTokenIssueRoute.post("/", async (c) => {
  if (
    c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new HTTPException(415, {
      message: "Content-Type must be application/json",
    });
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  return c.json(
    await invoke(
      runTokenIssue.name,
      runTokenIssue.input.parse(body),
      capabilityContext(c),
      { surface: "api" },
    ),
  );
});
