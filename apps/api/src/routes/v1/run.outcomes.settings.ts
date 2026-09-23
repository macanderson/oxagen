import { Hono } from "hono";
import { invoke } from "@oxagen/oxagen/kernel";
import { runOutcomesSettingsGet } from "@oxagen/oxagen/contracts/run.outcomes.settings.get";
import { runOutcomesSettingsSet } from "@oxagen/oxagen/contracts/run.outcomes.settings.set";
import type { AppEnv } from "../../app";
import { capabilityContext } from "../../lib/context";

export const runOutcomesSettingsRoute = new Hono<AppEnv>();
runOutcomesSettingsRoute.get("/", async (c) =>
  c.json(
    await invoke(runOutcomesSettingsGet.name, {}, capabilityContext(c), {
      surface: "api",
    }),
  ),
);
runOutcomesSettingsRoute.put("/", async (c) =>
  c.json(
    await invoke(
      runOutcomesSettingsSet.name,
      runOutcomesSettingsSet.input.parse(await c.req.json()),
      capabilityContext(c),
      { surface: "api" },
    ),
  ),
);
