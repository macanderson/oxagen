import { Hono } from "hono";
import { archiveCreate } from "@oxagen/oxagen/contracts/archive.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const archiveCreateRoute = new Hono<AppEnv>();

// ZIP archive creation from existing generated assets, inline base64 blobs,
// or plain text entries. Built in-process with fflate; no cloud calls required.
// Route is org + workspace scoped.
archiveCreateRoute.post("/", async (c) => {
  const body = archiveCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(archiveCreate.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
