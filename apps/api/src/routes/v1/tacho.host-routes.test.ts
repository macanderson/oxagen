import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { TACHO_MAX_REQUEST_BYTES } from "@oxagen/recorder";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { mountTachoHostRoutes } from "./tacho.host-routes";

// Each route's own body limit, as its module declares it.
const LIMITS = [
  ["/events", TACHO_MAX_REQUEST_BYTES],
  ["/memories/uses", 1024 * 1024],
  ["/memories/recall", 384 * 1024],
  ["/commands", 256 * 1024],
  ["/bundle", 64 * 1024],
  ["/memories", 32 * 1024],
  ["/github-token", 4096],
  ["/contained-launch", 4096],
] as const;

function host() {
  const tacho = new Hono<AppEnv>();
  tacho.use("*", async (c, next) => {
    c.set("apiKeyId", "host-key");
    await next();
  });
  mountTachoHostRoutes(tacho);
  const app = new Hono<AppEnv>();
  app.route("/v1/tacho", tacho);
  // The body is `{}` padded with spaces, so a route that got past its body
  // limits refuses the input itself. 422 marks that it was reached.
  app.onError((err, c) =>
    err instanceof HTTPException
      ? err.getResponse()
      : c.json({ reached: true }, 422),
  );
  return app;
}

function post(path: string, bytes: number) {
  return new Request(`http://localhost/v1/tacho${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{}${" ".repeat(bytes - 2)}`,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ apiKeyId: "host-key" });
  mocks.invoke.mockResolvedValue({});
});

describe("Tacho host routes", () => {
  it.each(LIMITS)(
    "reads a %s body at that route's own limit",
    async (path, limit) => {
      // A route mounted earlier with a smaller limit would answer 413 here.
      // The command poll did, behind the two 4 KiB routes.
      const res = await host().fetch(post(path, limit));
      expect(res.status).toBe(422);
    },
  );

  it.each(LIMITS)(
    "refuses a %s body one byte over that route's limit",
    async (path, limit) => {
      const res = await host().fetch(post(path, limit + 1));
      expect(res.status).toBe(413);
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );
});
