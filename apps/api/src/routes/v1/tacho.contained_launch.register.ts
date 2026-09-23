import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { tachoContainedLaunchRegister } from "@oxagen/oxagen/contracts/tacho.contained_launch.register";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

const MAX_BODY_BYTES = 4096;

export const tachoContainedLaunchRegisterRoute = new Hono<AppEnv>();

tachoContainedLaunchRegisterRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

tachoContainedLaunchRegisterRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

tachoContainedLaunchRegisterRoute.post("/contained-launch", async (c) => {
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

  const input = tachoContainedLaunchRegister.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoContainedLaunchRegister.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
