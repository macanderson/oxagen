import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureSource } from "./adapters/fixture";
import { liveSource } from "./adapters/live";
import { dataSource } from "./source";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dataSource", () => {
  it("selects the fixture adapter outside production when MC_DATA=fixture", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    expect(await dataSource()).toBe(fixtureSource);
    vi.stubEnv("NODE_ENV", "test");
    expect(await dataSource()).toBe(fixtureSource);
  });

  it("never selects fixtures in a production build, even with MC_DATA=fixture (negative)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    expect(await dataSource()).toBe(liveSource);
  });

  it.each(["", "live", "FIXTURE", "fixtures"])(
    "selects live data for MC_DATA=%j (negative)",
    async (value) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("MC_DATA", value);
      expect(await dataSource()).toBe(liveSource);
    },
  );
});
