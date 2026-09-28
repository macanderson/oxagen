/**
 * context.steering.index.get.test.ts
 *
 * The route refuses an API key for another workspace than the URL names. An
 * API key carries its own organization and workspace, and the org and
 * workspace middleware keep that scope without reading the URL. Without this
 * check, `oxagen check` in a repo whose workspace.toml names `acme/prod` would
 * read `acme/dev`'s index with a key for `acme/dev` and report against it.
 *
 * The kernel is a fake here; `get_steering_index`'s own tests live with its
 * handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono as HonoType } from "hono";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  systemDb: vi.fn(),
  tx: {
    query: {
      organizations: { findFirst: vi.fn() },
      workspaces: { findFirst: vi.fn() },
    },
  },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...actual,
    // Run the middleware's lookup against the fake tx, and count the calls.
    withSystemDb: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      h.systemDb();
      return fn(h.tx);
    },
  };
});
vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: h.invoke };
});
vi.mock("../../lib/context", () => ({
  capabilityContext: vi.fn(() => ({})),
}));
vi.mock("../../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, captureError: vi.fn() };
});

const { Hono } = await import("hono");
const { errorMiddleware } = await import("../../middleware/error");
const { steeringIndexGetRoute } = await import("./context.steering.index.get");

/** An app with the caller's scope set the way auth.ts sets it. */
function appFor(apiKeyId: string | null): HonoType {
  const app = new Hono();
  app.onError(errorMiddleware as never);
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("requestId", "req_1");
    set("userId", "33333333-3333-3333-3333-333333333333");
    set("apiKeyId", apiKeyId);
    set("orgId", ORG_ID);
    set("workspaceId", WORKSPACE_ID);
    await next();
  });
  app.route(
    "/v1/:org_slug/:workspace_slug/context/steering/index",
    steeringIndexGetRoute as unknown as HonoType,
  );
  return app;
}

const ANSWER = { index: null, context: { runtimes: [] } };

interface Refusal {
  error: { code: string; reason: string; message: string };
  requestId: string;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.query.organizations.findFirst.mockResolvedValue({ slug: "acme" });
  h.tx.query.workspaces.findFirst.mockResolvedValue({ slug: "prod" });
  h.invoke.mockResolvedValue(ANSWER);
});

describe("GET /v1/:org_slug/:workspace_slug/context/steering/index", () => {
  it.each<[string, string]>([
    ["the key's slugs", "acme/prod"],
    ["the key's slugs in another case", "ACME/Prod"],
    ["the key's ids", `${ORG_ID}/${WORKSPACE_ID}`],
  ])("answers an API key when the URL names %s", async (_name, path) => {
    const res = await appFor("key_1").request(
      `/v1/${path}/context/steering/index`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ANSWER);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string]>([
    ["another workspace", "acme/dev"],
    ["another organization", "other/prod"],
  ])(
    "refuses an API key when the URL names %s",
    async (_name, path) => {
      const res = await appFor("key_1").request(
        `/v1/${path}/context/steering/index`,
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as Refusal;
      expect(body.error.code).toBe("forbidden");
      expect(body.error.reason).toBe("key_scope_mismatch");
      expect(body.error.message).toBe(
        `This API key belongs to workspace acme/prod, and the request names ${path}. Use a key for ${path}, or request acme/prod.`,
      );
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  it("names the key's ids when its organization and workspace have no row", async () => {
    h.tx.query.organizations.findFirst.mockResolvedValue(undefined);
    h.tx.query.workspaces.findFirst.mockResolvedValue(undefined);

    const res = await appFor("key_1").request(
      "/v1/acme/prod/context/steering/index",
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as Refusal;
    expect(body.error.message).toContain(
      `belongs to workspace ${ORG_ID}/${WORKSPACE_ID}`,
    );
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("passes a session through without a lookup", async () => {
    const res = await appFor(null).request(
      "/v1/acme/dev/context/steering/index",
    );

    expect(res.status).toBe(200);
    expect(h.systemDb).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
});
