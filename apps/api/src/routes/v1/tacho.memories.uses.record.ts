import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { tachoMemoryUsesRecord } from "@oxagen/oxagen/contracts/tacho.memories.uses.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Count the memory files the calling host's runs read, and retire the
 * memories whose files its full scans no longer find (ADR-248).
 *
 * Machine-to-machine: the host's API key carries its org and workspace, so
 * this route lives on the static /v1/tacho router and refuses anything but an
 * API key before it reads the body.
 */
// A report holds at most 200 uses and 8 scans of 4,000 paths. A Claude Code
// memory path runs near 100 bytes, so a full scan of 4,000 files is about
// 400 KiB and 1 MiB leaves room for the uses. A body past the limit answers
// 413, and the daemon logs it and drops that call. tacho.host-routes.ts
// mounts routes by this limit.
const MAX_BODY_BYTES = 1024 * 1024;

export const tachoMemoryUsesRecordRoute = new Hono<AppEnv>();

tachoMemoryUsesRecordRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

tachoMemoryUsesRecordRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

tachoMemoryUsesRecordRoute.post("/memories/uses", async (c) => {
  const mediaType = c.req
    .header("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new HTTPException(415, {
      message: "Content-Type must be application/json",
    });
  }

  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoMemoryUsesRecord.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoMemoryUsesRecord.name, input, ctx, {
    surface: "api",
  });
  c.header("Cache-Control", "no-store");
  return c.json(output);
});
