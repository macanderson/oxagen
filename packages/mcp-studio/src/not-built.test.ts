import { describe, expect, it } from "vitest";
import { NotBuiltError, notBuilt, notBuiltAsync } from "./not-built";

describe("notBuilt", () => {
  it("throws a NotBuiltError naming the module", () => {
    expect(() => notBuilt("compile", 1, 2)).toThrow("compile is not built");
    try {
      notBuilt("lock");
    } catch (error) {
      expect(error).toBeInstanceOf(NotBuiltError);
      expect((error as NotBuiltError).module).toBe("lock");
      expect((error as NotBuiltError).name).toBe("NotBuiltError");
    }
  });

  it("rejects for an asynchronous stub", async () => {
    await expect(notBuiltAsync("openapi")).rejects.toThrow("openapi is not built");
  });
});
