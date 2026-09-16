// The ApiKey view model is the boundary the API keys page reads through
// (ARCHITECTURE.md §3.4): nothing that could be exchanged for access may cross
// it. list_api_keys returns no secret and no hash today; these tests hold the
// view model to that whatever the contract grows, by naming every field it
// carries and by proving an unrecognised field does not survive the parse.
import { describe, expect, it } from "vitest";
import { ApiKey, ApiKeyList } from "./org";

const SECRET_SHAPED = /secret|hash|token|key$/i;

const stored = {
  id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
  name: "CI runner",
  prefix: "ox_liveliveli",
  createdAt: "2026-09-13T10:00:00.000Z",
  lastUsedAt: "2026-09-14T11:30:00.000Z",
  expiresAt: null,
  revokedAt: null,
};

describe("ApiKey", () => {
  it("carries the key's metadata and no field named like a secret or a hash", () => {
    expect(Object.keys(ApiKey.shape)).toEqual([
      "id",
      "name",
      "prefix",
      "createdAt",
      "lastUsedAt",
      "expiresAt",
      "revokedAt",
    ]);
    expect(
      Object.keys(ApiKey.shape).filter((f) => SECRET_SHAPED.test(f)),
    ).toEqual([]);
  });

  it("drops a field it does not name, so a secret the contract grows cannot reach the page (negative)", () => {
    const parsed = ApiKey.parse({
      ...stored,
      keyHash: "sha256-of-the-live-key",
      secret: "ox_thewholekey",
    });
    expect(Object.keys(parsed)).toEqual(Object.keys(ApiKey.shape));
    expect(JSON.stringify(parsed)).not.toContain("sha256-of-the-live-key");
    expect(JSON.stringify(parsed)).not.toContain("ox_thewholekey");
  });

  it("refuses a raw database id in place of the key's public id (negative)", () => {
    expect(
      ApiKeyList.safeParse([
        { ...stored, id: "7a000000-0000-4000-8000-0000000000a1" },
      ]).success,
    ).toBe(false);
  });

  it("refuses an instant that is not a timestamp (negative)", () => {
    expect(
      ApiKeyList.safeParse([{ ...stored, createdAt: "yesterday" }]).success,
    ).toBe(false);
  });
});
