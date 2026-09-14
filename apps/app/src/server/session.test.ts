import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, requestHeaders } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  requestHeaders: new Headers({ cookie: "better-auth.session_token=abc" }),
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(requestHeaders),
}));

vi.mock("@oxagen/auth/server", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

import { readSession } from "./session";

beforeEach(() => {
  getSessionMock.mockReset();
});

describe("readSession", () => {
  it("returns the Better Auth user, normalised", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u1", email: "a@b.c", name: "", image: undefined },
      session: { id: "s1" },
    });
    await expect(readSession()).resolves.toEqual({
      user: { id: "u1", email: "a@b.c", name: null, image: null },
    });
    expect(getSessionMock).toHaveBeenCalledWith({ headers: requestHeaders });
  });

  it("returns null when Better Auth has no session", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(readSession()).resolves.toBeNull();
  });
});
