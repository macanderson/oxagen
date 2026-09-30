// api-key-gate.test.ts: the transport's auth gate answers as xmcp's
// apiKeyAuthMiddleware did, and passes a request with a bearer key on.
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { API_KEY_REFUSAL, apiKeyGate } from "./api-key-gate";

function run(authorization: string | undefined) {
  const req = { header: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined) };
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  apiKeyGate(req as unknown as Request, { status } as unknown as Response, next as unknown as NextFunction);
  return { status, json, next };
}

describe("apiKeyGate", () => {
  it("passes a request that carries a bearer key", () => {
    const { status, next } = run("Bearer oxk_live_example");
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["a scheme with no token", "Bearer   "],
  ])("refuses %s with xmcp's 401 body", (_what, authorization) => {
    const { status, json, next } = run(authorization);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: API_KEY_REFUSAL });
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps xmcp's refusal text word for word", () => {
    expect(API_KEY_REFUSAL).toBe("Unauthorized: Missing or invalid API key");
  });
});
