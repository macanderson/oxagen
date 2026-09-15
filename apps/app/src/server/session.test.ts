import { beforeEach, describe, expect, it, vi } from "vitest";

const { api, route, requestHeaders } = vi.hoisted(() => ({
  api: {
    getSession: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    sendVerificationEmail: vi.fn(),
  },
  route: vi.fn(),
  requestHeaders: new Headers({ cookie: "better-auth.session_token=abc" }),
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(requestHeaders),
}));
vi.mock("@oxagen/auth/server", () => ({ auth: { api } }));
vi.mock("@oxagen/auth/route", () => ({ handleAuthRequest: route }));

import { routes } from "@/shared/safe-path";
import {
  getAuthUser,
  handleAuthRequest,
  readSession,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
} from "./session";

beforeEach(() => {
  for (const fn of [...Object.values(api), route]) fn.mockReset();
});

describe("readSession", () => {
  it("returns the Better Auth user, normalised", async () => {
    api.getSession.mockResolvedValue({
      user: { id: "u1", email: "a@b.c", name: "", image: undefined },
      session: { id: "s1" },
    });
    await expect(readSession()).resolves.toEqual({
      user: { id: "u1", email: "a@b.c", name: null, image: null },
    });
    expect(api.getSession).toHaveBeenCalledWith({ headers: requestHeaders });
  });

  it("returns null when Better Auth has no session (negative)", async () => {
    api.getSession.mockResolvedValue(null);
    await expect(readSession()).resolves.toBeNull();
  });
});

describe("getAuthUser", () => {
  it("narrows the session to the person the flows show, a nameless account as an empty name", async () => {
    api.getSession.mockResolvedValue({
      user: { id: "u2", email: "m@acme.example", name: null, image: "x" },
    });
    await expect(getAuthUser()).resolves.toEqual({
      id: "u2",
      email: "m@acme.example",
      name: "",
    });
  });

  it("is null without a session (negative)", async () => {
    api.getSession.mockResolvedValue(null);
    await expect(getAuthUser()).resolves.toBeNull();
  });
});

describe("Better Auth server calls", () => {
  it("hands the auth API request to the audited route handler", async () => {
    const response = new Response(null, { status: 204 });
    route.mockResolvedValue(response);
    const request = new Request("http://localhost:3000/api/auth/get-session");
    await expect(handleAuthRequest(request)).resolves.toBe(response);
    expect(route).toHaveBeenCalledWith(request);
  });

  it("sends each call's body with its SafePath destination", async () => {
    await requestPasswordReset({
      email: "m@acme.example",
      redirectTo: routes.resetPassword(),
    });
    expect(api.requestPasswordReset).toHaveBeenCalledWith({
      body: { email: "m@acme.example", redirectTo: "/reset-password" },
    });
    await resetPassword({ token: "rst", newPassword: "pw" });
    expect(api.resetPassword).toHaveBeenCalledWith({
      body: { token: "rst", newPassword: "pw" },
    });
    await sendVerificationEmail({
      email: "m@acme.example",
      callbackURL: routes.newOrganization(),
    });
    expect(api.sendVerificationEmail).toHaveBeenCalledWith({
      body: { email: "m@acme.example", callbackURL: "/new-organization" },
    });
  });
});
