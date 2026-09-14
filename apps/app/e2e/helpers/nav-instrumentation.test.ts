/**
 * The #2559 diagnostic must never break the request it is watching.
 *
 * It did. The fetch wrapper read `.url` off whatever `fetch` was handed, and a
 * `URL` has no `.url` — so `undefined.includes("_rsc=")` threw inside the app's
 * own fetch. Better Auth's client passes a `URL`, so `signUp.email` rejected
 * before any request was made, the signup form rendered "Cannot read properties
 * of undefined (reading 'includes')", and the two specs carrying this
 * instrumentation reported a navigation timeout with no cause attached.
 *
 * The first case below is that bug. It throws against the old classifier and
 * passes against this one.
 */
import { describe, expect, it } from "vitest";
import { classifyFetchInput } from "./nav-instrumentation";

const SIGNUP = "http://localhost:3000/api/auth/sign-up/email";

describe("classifyFetchInput", () => {
  it("reads a URL object, which is what broke signup", () => {
    const target = classifyFetchInput(new URL(SIGNUP), { method: "POST" });
    expect(target.url).toBe(SIGNUP);
    expect(target.isRscLike).toBe(false);
  });

  it("reads a string", () => {
    expect(classifyFetchInput(SIGNUP, undefined).url).toBe(SIGNUP);
  });

  it("reads a Request", () => {
    const target = classifyFetchInput(new Request(SIGNUP), undefined);
    expect(target.url).toBe(SIGNUP);
  });

  it("recognises an RSC request by its query param", () => {
    const target = classifyFetchInput("http://x/page?_rsc=abc123", undefined);
    expect(target.isRscLike).toBe(true);
  });

  it("recognises an RSC request by the RSC header", () => {
    const target = classifyFetchInput("http://x/page", {
      headers: { RSC: "1" },
    });
    expect(target.isRscLike).toBe(true);
  });

  it("recognises an RSC request by the router state-tree header", () => {
    const target = classifyFetchInput("http://x/page", {
      headers: { "Next-Router-State-Tree": "%5B%22%22%2C%7B%7D%5D" },
    });
    expect(target.isRscLike).toBe(true);
  });

  it("reads headers off a Request when init carries none", () => {
    const target = classifyFetchInput(
      new Request("http://x/page", { headers: { RSC: "1" } }),
      undefined,
    );
    expect(target.isRscLike).toBe(true);
  });

  it("does not mistake an ordinary POST for an RSC request", () => {
    const target = classifyFetchInput(SIGNUP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(target.isRscLike).toBe(false);
  });

  // Whatever arrives, the wrapper's job is to hand the call to the real fetch
  // rather than throw into the caller.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an empty object", {}],
    ["an object whose href is not a string", { href: 7 }],
  ])("classifies %s without throwing", (_label, input) => {
    const target = classifyFetchInput(input, undefined);
    expect(target).toEqual({ url: "", isRscLike: false });
  });

  it("survives a header bag it cannot read", () => {
    const hostile = {
      get headers() {
        throw new Error("no");
      },
    };
    expect(() =>
      classifyFetchInput("http://x/p?_rsc=1", hostile),
    ).not.toThrow();
    expect(classifyFetchInput("http://x/p?_rsc=1", hostile).isRscLike).toBe(
      true,
    );
  });

  // `installNavInstrumentation` serializes this function into the page with
  // toString(), so a closure over anything in this module would arrive in the
  // browser as a ReferenceError — the same shape of failure this file exists
  // to close.
  it("is self-contained enough to serialize into the page", () => {
    const source = classifyFetchInput.toString();
    expect(source).not.toMatch(/\bimport\b|\brequire\(/);
    expect(source.startsWith("function")).toBe(true);
  });
});
