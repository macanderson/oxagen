// TransportError: the one error a Transport throws, and whether the request
// may have reached the upstream.
import { describe, expect, it } from "vitest";
import { TRANSPORT_ERROR_CODES, TransportError } from "./transport";

describe("TransportError", () => {
  it("carries its code, message, and whether the request was sent", () => {
    const error = new TransportError("timeout", "the upstream took longer than 30000 ms", true);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TransportError");
    expect(error.code).toBe("timeout");
    expect(error.message).toBe("the upstream took longer than 30000 ms");
    expect(error.sent).toBe(true);
  });

  it("marks a request that never left as not sent", () => {
    const error = new TransportError("refused_address", "10.0.0.5 is a private address", false);
    expect(error.sent).toBe(false);
    expect(() => {
      throw error;
    }).toThrow(TransportError);
  });

  it("lists each code once", () => {
    expect(new Set(TRANSPORT_ERROR_CODES).size).toBe(TRANSPORT_ERROR_CODES.length);
    expect(TRANSPORT_ERROR_CODES).toHaveLength(7);
  });
});
