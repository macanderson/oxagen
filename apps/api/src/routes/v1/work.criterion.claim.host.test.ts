import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { workCriterionHostClaimRoute } from "./work.criterion.claim.host";

const LIMIT = 16 * 1024;
const input = {
  item_id: "wi_0a1b2c",
  work_order_id: "wo_3d4e5f",
  criterion_id: "c2",
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  text: "The invite test covers an expired link.",
};
const answer = {
  item: { id: "wi_0a1b2c", state: "running", revision: 1, version: 4 },
  repeat: false,
  order: { id: "wo_3d4e5f", send: 1, key: "wi_0a1b2c:r1:s1", delivery: "running" },
  claim: { criterion_id: "c2", head_sha: input.head_sha, run_id: "tse_01j9" },
};

function app(authenticated = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authenticated) c.set("apiKeyId", "host-key");
    await next();
  });
  app.route("/v1/tacho", workCriterionHostClaimRoute);
  return app;
}

function request(body = JSON.stringify(input), type = "application/json") {
  return new Request("http://localhost/v1/tacho/work-orders/criteria/claim", {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ apiKeyId: "host-key" });
  mocks.invoke.mockResolvedValue(answer);
});

describe("host criterion claim endpoint", () => {
  it("requires a host API key before reading a body", async () => {
    expect((await app(false).fetch(request("invalid-json"))).status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes validated input through the kernel on the API surface", async () => {
    const res = await app().fetch(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "claim_work_criterion",
      input,
      { apiKeyId: "host-key" },
      { surface: "api" },
    );
  });

  it("reads a body at its 16 KiB limit", async () => {
    const json = JSON.stringify(input);
    const body = `${json}${" ".repeat(LIMIT - json.length)}`;
    expect(body.length).toBe(LIMIT);
    expect((await app().fetch(request(body))).status).toBe(200);
  });

  it.each([
    ["a criterion id that is not one", { ...input, criterion_id: "criterion-2" }],
    ["a head that is not a full commit id", { ...input, head_sha: "0123456" }],
    ["an enrollment id the contract does not take", { ...input, host_enrollment_id: "tch_0123456789abcdefghjkmn" }],
    ["empty text", { ...input, text: "   " }],
  ])("refuses %s before it invokes", async (_, body) => {
    const res = await app().fetch(request(JSON.stringify(body)));
    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", "application/json", 400],
    ["{}", "text/plain", 415],
    ["x".repeat(LIMIT + 1), "application/json", 413],
  ])("rejects invalid transport %#", async (body, type, status) => {
    expect(
      (await app().fetch(request(String(body), String(type)))).status,
    ).toBe(status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
