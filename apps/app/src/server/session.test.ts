import { beforeEach, describe, expect, it, vi } from "vitest";

const { api, route, requestHeaders } = vi.hoisted(() => ({
  api: {
    getSession: vi.fn(),
  },
  route: vi.fn(),
  requestHeaders: new Headers({ cookie: "better-auth.session_token=abc" }),
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(requestHeaders),
}));
vi.mock("@oxagen/auth/server", () => ({ auth: { api } }));
vi.mock("@oxagen/auth/route", () => ({ handleAuthRequest: route }));

import * as session from "./session";
import { getAuthUser, getSession, handleAuthRequest } from "./session";

beforeEach(() => {
  for (const fn of [...Object.values(api), route]) fn.mockReset();
});

describe("getSession", () => {
  it("returns the Better Auth user, normalised", async () => {
    api.getSession.mockResolvedValue({
      user: {
        id: "u1",
        email: "a@b.c",
        name: "",
        image: undefined,
        emailVerified: true,
        twoFactorEnabled: true,
      },
      session: { id: "s1" },
    });
    await expect(getSession()).resolves.toEqual({
      // A session older than auth_method records none.
      authMethod: null,
      user: {
        id: "u1",
        email: "a@b.c",
        name: null,
        image: null,
        emailVerified: true,
        twoFactorEnabled: true,
      },
    });
    expect(api.getSession).toHaveBeenCalledWith({ headers: requestHeaders });
  });

  it("carries how the session was established, for the require-SSO gate", async () => {
    api.getSession.mockResolvedValue({
      user: {
        id: "u1",
        email: "a@acme.example",
        name: "A",
        image: null,
        emailVerified: true,
      },
      session: { id: "s1", authMethod: "sso:acme-okta" },
    });
    await expect(getSession()).resolves.toMatchObject({
      authMethod: "sso:acme-okta",
    });
  });

  it("returns null when Better Auth has no session (negative)", async () => {
    api.getSession.mockResolvedValue(null);
    await expect(getSession()).resolves.toBeNull();
  });
});

describe("getAuthUser", () => {
  it("narrows the session to the person the flows show, a nameless account as an empty name", async () => {
    api.getSession.mockResolvedValue({
      user: {
        id: "u2",
        email: "m@acme.example",
        name: null,
        image: "x",
        emailVerified: false,
      },
    });
    await expect(getAuthUser()).resolves.toEqual({
      id: "u2",
      email: "m@acme.example",
      name: "",
      // Better Auth maps `image` to auth.users.avatar_url; the Account dialog
      // draws it, so the shell's viewer carries it.
      avatarUrl: "x",
      emailVerified: false,
      // The twoFactor plugin's column, absent until the person enrols.
      twoFactorEnabled: false,
    });
  });

  it("carries a null avatar rather than an empty one, so the dialog draws initials (negative)", async () => {
    api.getSession.mockResolvedValue({
      user: {
        id: "u3",
        email: "d@acme.example",
        name: "Dana",
        image: null,
        emailVerified: true,
        twoFactorEnabled: null,
      },
    });
    await expect(getAuthUser()).resolves.toEqual({
      id: "u3",
      email: "d@acme.example",
      name: "Dana",
      avatarUrl: null,
      emailVerified: true,
      twoFactorEnabled: false,
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

  it("sends no reset or verification mail, which would skip Better Auth's rate limiter (#4042)", () => {
    expect(Object.keys(session).sort()).toEqual([
      "getAuthUser",
      "getSession",
      "handleAuthRequest",
    ]);
  });
});
