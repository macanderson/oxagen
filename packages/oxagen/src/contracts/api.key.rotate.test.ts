import { describe, expect, it } from "vitest";
import { apiKeyRotate } from "./api.key.rotate";
import { getCapability } from "../registry";

describe("api.key.rotate capability", () => {
  it("parses input with just keyPublicId", () => {
    const parsed = apiKeyRotate.input.parse({ keyPublicId: "aky_abc" });
    expect(parsed.keyPublicId).toBe("aky_abc");
    expect(parsed.name).toBeUndefined();
  });

  it("accepts an optional name override", () => {
    const parsed = apiKeyRotate.input.parse({
      keyPublicId: "aky_abc",
      name: "rotated",
    });
    expect(parsed.name).toBe("rotated");
  });

  it("rejects a missing keyPublicId", () => {
    expect(() => apiKeyRotate.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    const out = apiKeyRotate.output.parse({
      keyId: "k1",
      publicId: "aky_new",
      name: "n",
      keyPrefix: "ox_abc",
      rawKey: "ox_rawsecret",
      expiresAt: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      revokedKeyPublicId: "aky_old",
      revokedAt: "2026-06-16T00:00:00.000Z",
    });
    expect(out.revokedKeyPublicId).toBe("aky_old");
  });

  it("does not consume the billing gate", () => {
    expect(apiKeyRotate.noBillingGate).toBe(true);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("rotate_api_key")).toBe(apiKeyRotate);
  });

  // The app's token page (apps/app/.../developer/tokens/api-key.ts) invokes
  // this on the "agent" surface — there is no "app" surface in
  // CapabilitySurface, so that is the surface every app-initiated call uses.
  // Omitting it made the kernel's surface gate refuse the call outright
  // (`is not exposed on the "agent" surface`) while this contract still
  // advertised an "app" layer. The handler test cannot catch that: it calls
  // the handler directly and never crosses the gate.
  it("is exposed on the surface the app invokes it from", () => {
    expect(apiKeyRotate.surfaces).toContain("agent");
    expect(apiKeyRotate.layers).toContain("app");
  });
});
