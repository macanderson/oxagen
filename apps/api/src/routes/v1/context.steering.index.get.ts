import { Hono } from "hono";
import { steeringIndexGet } from "@oxagen/oxagen/contracts/context.steering.index.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import { keyScopeMatchesPath } from "../../middleware/key-scope";
import type { AppEnv } from "../../app";

/**
 * The workspace's published record index and its check context, for `oxagen check` (`get_steering_index`). Takes no input. Mounted on the org-scoped router, so the caller must belong to the workspace.
 *
 * An API key must belong to the workspace the URL names. `oxagen check` sends the workspace a steering repo's workspace.toml names, so a key for another workspace gets 403 `key_scope_mismatch` rather than that workspace's index.
 */
export const steeringIndexGetRoute = new Hono<AppEnv>();

steeringIndexGetRoute.get("/", keyScopeMatchesPath, async (c) =>
  c.json(
    await invoke(steeringIndexGet.name, {}, capabilityContext(c), {
      surface: "api",
    }),
    200,
  ),
);
