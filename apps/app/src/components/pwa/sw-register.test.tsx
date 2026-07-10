// @vitest-environment jsdom
/**
 * SwRegister — unit tests for the service-worker registration gate.
 *
 * Covers: production-only registration, no-op when serviceWorker is
 * unsupported, and that a registration rejection never throws/propagates
 * (the SW is a pure enhancement — failures must be silently swallowed).
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwRegister } from "./sw-register";

describe("SwRegister", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let register: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    register = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
  });

  afterEach(() => {
    cleanup();
    process.env.NODE_ENV = originalNodeEnv;
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("registers /sw.js in production when serviceWorker is supported", () => {
    process.env.NODE_ENV = "production";
    const { container } = render(<SwRegister />);
    expect(container.firstChild).toBeNull();
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("does not register outside production", () => {
    process.env.NODE_ENV = "test";
    render(<SwRegister />);
    expect(register).not.toHaveBeenCalled();
  });

  it("does not throw and does not register when serviceWorker is unsupported", () => {
    process.env.NODE_ENV = "production";
    Reflect.deleteProperty(navigator, "serviceWorker");
    expect(() => render(<SwRegister />)).not.toThrow();
    expect(register).not.toHaveBeenCalled();
  });

  it("swallows a registration rejection without throwing", () => {
    process.env.NODE_ENV = "production";
    register.mockRejectedValueOnce(new Error("registration failed"));
    expect(() => render(<SwRegister />)).not.toThrow();
  });
});
