import { describe, expect, it } from "vitest";
import {
  AppError,
  CAPABILITY_ERROR_STATUS,
  CacheTagScopeError,
  ContractOutputMismatch,
  FixtureWriteRefused,
  InvalidStreamCursor,
  ToolNotRegistered,
  toActionFailure,
} from "./errors";

/** A stand-in with the kernel CapabilityError's shape (name + capability + code). */
function capabilityError(
  capability: string,
  code: string,
  accessRequestId?: string,
): Error {
  const err = new Error(`${capability}: ${code}`) as Error & {
    capability: string;
    code: string;
    accessRequestId?: string;
  };
  err.name = "CapabilityError";
  err.capability = capability;
  err.code = code;
  if (accessRequestId) err.accessRequestId = accessRequestId;
  return err;
}

describe("AppError subclasses", () => {
  it.each([
    [new FixtureWriteRefused("resolve_approval"), "fixture_write_refused", 409],
    [new ToolNotRegistered("resolve_approval"), "tool_not_registered", 500],
    [
      new ContractOutputMismatch("resolve_approval", [{ path: ["x"] }]),
      "contract_output_mismatch",
      502,
    ],
    [new InvalidStreamCursor("abc"), "invalid_stream_cursor", 400],
    [new CacheTagScopeError("bad"), "cache_tag_scope", 500],
  ] as const)("%s carries a stable code and status", (err, code, status) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.name).not.toBe("Error");
  });

  it("names the refused tool without leaking input", () => {
    const err = new FixtureWriteRefused("resolve_approval");
    expect(err.tool).toBe("resolve_approval");
    expect(err.message).toContain("fixture data source");
  });

  it("keeps the schema issues on an output mismatch", () => {
    const issues = [{ code: "invalid_type", path: ["id"] }];
    expect(new ContractOutputMismatch("t", issues).issues).toBe(issues);
  });
});

describe("toActionFailure", () => {
  it("maps an AppError to its code and status", () => {
    expect(toActionFailure(new FixtureWriteRefused("t"))).toEqual({
      ok: false,
      code: "fixture_write_refused",
      status: 409,
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
    const err = Object.assign(new Error("spend ceiling"), {
      code: "spend_ceiling_exceeded",
      status: 402,
    });
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
    const err = Object.assign(new Error("x"), { code: "c", status: 200 });
    expect(() => toActionFailure(err)).toThrow(err);
  });

  it("rethrows Next navigation interrupts and unknown failures", () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    expect(() => toActionFailure(redirect)).toThrow(redirect);
    const boom = new TypeError("boom");
    expect(() => toActionFailure(boom)).toThrow(boom);
    expect(() => toActionFailure("not an error")).toThrow();
  });
});
