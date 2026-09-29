import { describe, expect, it } from "vitest";
import { NotBuiltError, notBuilt, notBuiltAsync } from "./not-built";

describe("notBuilt", () => {
  it("throws a NotBuiltError naming the function", () => {
    expect.assertions(4);
    expect(() => notBuilt("decide", 1, 2)).toThrow("decide is not built");
    try {
      notBuilt("lockDigest");
    } catch (error) {
      expect(error).toBeInstanceOf(NotBuiltError);
      expect((error as NotBuiltError).module).toBe("lockDigest");
      expect((error as NotBuiltError).name).toBe("NotBuiltError");
    }
  });

  it("rejects for an asynchronous stub", async () => {
    await expect(notBuiltAsync("triageItem")).rejects.toThrow("triageItem is not built");
  });
});
