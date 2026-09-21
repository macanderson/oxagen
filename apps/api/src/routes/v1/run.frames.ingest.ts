import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { runFramesIngest } from "@oxagen/oxagen/contracts/run.frames.ingest";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const runFramesIngestRoute = new Hono<AppEnv>();
runFramesIngestRoute.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
runFramesIngestRoute.post("/", async (c) => {
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
      runFramesIngest.name,
      runFramesIngest.input.parse(body),
      capabilityContext(c),
      { surface: "api" },
    ),
  );
});
