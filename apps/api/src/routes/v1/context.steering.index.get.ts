import { Hono } from "hono";
import { steeringIndexGet } from "@oxagen/oxagen/contracts/context.steering.index.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The workspace's published record index and its check context, for `oxagen check` (`get_steering_index`). Takes no input. Mounted on the org-scoped router, so the caller must belong to the workspace. */
export const steeringIndexGetRoute = new Hono<AppEnv>();

steeringIndexGetRoute.get("/", async (c) =>
  c.json(
    await invoke(steeringIndexGet.name, {}, capabilityContext(c), {
      surface: "api",
    }),
    200,
  ),
);
