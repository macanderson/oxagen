/**
 * The registry, not the shape, is what `isKernelIssuedPlatformOperator`
 * answers on (INV-31). Every case below is a value that looks like a binding
 * and was not minted here.
 */
import { describe, expect, it } from "vitest";
import {
  createPlatformOperatorContext,
  isKernelIssuedPlatformOperator,
} from "./platform-operator";

describe("createPlatformOperatorContext", () => {
  it("mints a binding this module recognises", () => {
    const binding = createPlatformOperatorContext({ requestId: "req-1" });
    expect(isKernelIssuedPlatformOperator(binding)).toBe(true);
  });

  it("carries the operator run's request id and names its principal kind", () => {
    const binding = createPlatformOperatorContext({ requestId: "req-2" });
    expect(binding.requestId).toBe("req-2");
    expect(binding.principalKind).toBe("platform_operator");
  });

  it("mints a distinct binding per call", () => {
    const a = createPlatformOperatorContext({ requestId: "req-3" });
    const b = createPlatformOperatorContext({ requestId: "req-3" });
    expect(a).not.toBe(b);
    expect(isKernelIssuedPlatformOperator(a)).toBe(true);
    expect(isKernelIssuedPlatformOperator(b)).toBe(true);
  });
});

describe("isKernelIssuedPlatformOperator refuses everything it did not mint", () => {
  it("refuses a spread copy of a minted binding", () => {
    const minted = createPlatformOperatorContext({ requestId: "req-4" });
    expect(isKernelIssuedPlatformOperator({ ...minted })).toBe(false);
  });

  it("refuses a JSON round-trip of a minted binding", () => {
    const minted = createPlatformOperatorContext({ requestId: "req-5" });
    expect(
      isKernelIssuedPlatformOperator(JSON.parse(JSON.stringify(minted))),
    ).toBe(false);
  });

  it("refuses a hand-rolled object of the same shape", () => {
    expect(
      isKernelIssuedPlatformOperator({
        principalKind: "platform_operator",
        requestId: "req-6",
      }),
    ).toBe(false);
  });

  it("refuses primitives, null and undefined", () => {
    expect(isKernelIssuedPlatformOperator(true)).toBe(false);
    expect(isKernelIssuedPlatformOperator("platform_operator")).toBe(false);
    expect(isKernelIssuedPlatformOperator(1)).toBe(false);
    expect(isKernelIssuedPlatformOperator(null)).toBe(false);
    expect(isKernelIssuedPlatformOperator(undefined)).toBe(false);
  });
});
