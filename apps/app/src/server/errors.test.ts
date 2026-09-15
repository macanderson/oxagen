import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ERROR_STATUS,
  ContractOutputMismatch,
  ToolNotRegistered,
  toActionFailure,
} from "./errors";

/** A stand-in with the kernel CapabilityError's shape (name + capability + code). */
class CapabilityErrorShape extends Error {
  override name = "CapabilityError";
  constructor(
    readonly capability: string,
    readonly code: string,
  ) {
    super(`${capability}: ${code}`);
  }
}

class PendingApprovalShape extends CapabilityErrorShape {
  constructor(
    capability: string,
    code: string,
    readonly accessRequestId: string,
  ) {
    super(capability, code);
  }
}

/** An error carrying a code and an HTTP status, as the billing gate throws. */
class CodedError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function capabilityError(
  capability: string,
  code: string,
  accessRequestId?: string,
): Error {
  return accessRequestId
    ? new PendingApprovalShape(capability, code, accessRequestId)
    : new CapabilityErrorShape(capability, code);
}

describe("AppError subclasses", () => {
  it.each([
    [new ToolNotRegistered("resolve_approval"), "tool_not_registered", 500],
    [
      new ContractOutputMismatch("resolve_approval", [{ path: ["x"] }]),
      "contract_output_mismatch",
      502,
    ],
  ] as const)("%s carries a stable code and status", (err, code, status) => {
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.name).not.toBe("Error");
  });

  it("names the unregistered tool", () => {
    const err = new ToolNotRegistered("resolve_approval");
    expect(err.tool).toBe("resolve_approval");
    expect(err.message).toContain("resolve_approval");
  });

  it("keeps the schema issues on an output mismatch", () => {
    const issues = [{ code: "invalid_type", path: ["id"] }];
    expect(new ContractOutputMismatch("t", issues).issues).toBe(issues);
  });
});

describe("toActionFailure", () => {
  it("maps an AppError to its code and status", () => {
    expect(toActionFailure(new ToolNotRegistered("t"))).toEqual({
      ok: false,
      code: "tool_not_registered",
      status: 500,
    });
  });

  it("maps an IAM denial to 403 and names the permission", () => {
    expect(
      toActionFailure(capabilityError("resolve_approval", "authz_denied")),
    ).toEqual({
      ok: false,
      code: "authz_denied",
      status: 403,
      permission: "resolve_approval",
    });
  });

  it("carries the pollable access request on a pending approval", () => {
    expect(
      toActionFailure(
        capabilityError("rotate_api_key", "pending_approval", "arq_123"),
      ),
    ).toEqual({
      ok: false,
      code: "pending_approval",
      status: 202,
      accessRequestId: "arq_123",
    });
  });

  it.each(Object.entries(CAPABILITY_ERROR_STATUS))(
    "maps kernel code %s to HTTP %i",
    (code, status) => {
      expect(toActionFailure(capabilityError("t", code)).status).toBe(status);
    },
  );

  it("answers 500 for a kernel code it has no row for", () => {
    expect(toActionFailure(capabilityError("t", "brand_new_code"))).toEqual({
      ok: false,
      code: "brand_new_code",
      status: 500,
    });
  });

  it("passes through a coded error with an HTTP status (the billing gate's 402)", () => {
    const err = new CodedError("spend ceiling", "spend_ceiling_exceeded", 402);
    expect(toActionFailure(err)).toEqual({
      ok: false,
      code: "spend_ceiling_exceeded",
      status: 402,
    });
  });

  it("rethrows an error that only looks like a CapabilityError by name", () => {
    const err = new Error("x");
    err.name = "CapabilityError";
    expect(() => toActionFailure(err)).toThrow(err);
  });

  it("rethrows a coded error whose status is not an HTTP error status", () => {
    const err = new CodedError("x", "c", 200);
    expect(() => toActionFailure(err)).toThrow(err);
  });

  it("rethrows Next navigation interrupts and unknown failures", () => {
    const redirect = new Error("NEXT_REDIRECT");
    Reflect.set(redirect, "digest", "NEXT_REDIRECT;replace;/login;307;");
    expect(() => toActionFailure(redirect)).toThrow(redirect);
    const boom = new TypeError("boom");
    expect(() => toActionFailure(boom)).toThrow(boom);
    expect(() => toActionFailure("not an error")).toThrow();
  });
});
