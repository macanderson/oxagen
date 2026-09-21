import { describe, expect, it } from "vitest";
import {
  openPriceCancellation,
  sealPriceCancellation,
} from "./price-cancellation-token";

const payload = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  provider: "vendor",
  model: "model",
  tokenClass: "output",
  region: null,
  source: "negotiated" as const,
  effectiveFrom: "2026-12-01T00:00:00.000Z",
};
const secret = "a-price-token-key-with-32-characters";

describe("price cancellation token", () => {
  it("round trips the scoped identity without exposing its database UUID", () => {
    const token = sealPriceCancellation(payload, secret);
    expect(openPriceCancellation(token, secret)).toEqual(payload);
    expect(Buffer.from(token, "base64url").toString()).not.toContain(
      payload.id,
    );
    expect(sealPriceCancellation(payload, secret)).not.toBe(token);
  });
  it("rejects tampering and a different key", () => {
    const token = sealPriceCancellation(payload, secret);
    expect(() => openPriceCancellation(token.slice(0, 8), secret)).toThrow(
      expect.objectContaining({ reason: "price_cancellation_invalid" }),
    );
    const bytes = Buffer.from(token, "base64url");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() =>
      openPriceCancellation(bytes.toString("base64url"), secret),
    ).toThrow(
      expect.objectContaining({ reason: "price_cancellation_invalid" }),
    );
    expect(() => openPriceCancellation(token, "another-secret")).toThrow(
      expect.objectContaining({ reason: "price_cancellation_invalid" }),
    );
  });
});
