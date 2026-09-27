// status.ts: gRPC status codes by name.
import { describe, expect, it } from "vitest";
import { statusName } from "./status";

describe("statusName", () => {
  it("names each code from OK to UNAUTHENTICATED", () => {
    expect(statusName(0)).toBe("OK");
    expect(statusName(4)).toBe("DEADLINE_EXCEEDED");
    expect(statusName(14)).toBe("UNAVAILABLE");
    expect(statusName(16)).toBe("UNAUTHENTICATED");
  });

  it("reads a code outside 0 to 16 as UNKNOWN", () => {
    expect(statusName(17)).toBe("UNKNOWN");
    expect(statusName(99)).toBe("UNKNOWN");
    expect(statusName(-1)).toBe("UNKNOWN");
  });
});
