import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@/server/session", () => ({ getSession }));

const { getAuthUser } = await import("./session");

beforeEach(() => {
  getSession.mockReset();
});

describe("getAuthUser", () => {
  it("narrows the session to the person these flows show", async () => {
    getSession.mockResolvedValue({
      source: "better-auth",
      user: {
        id: "u1",
        email: "priya@acme.example",
        name: "Priya",
        image: "https://x/y.png",
      },
    });
    await expect(getAuthUser()).resolves.toEqual({
      id: "u1",
      email: "priya@acme.example",
      name: "Priya",
    });
  });

  it("reads a nameless account as an empty name", async () => {
    getSession.mockResolvedValue({
      source: "fixture",
      user: { id: "u2", email: "m@acme.example", name: null, image: null },
    });
    await expect(getAuthUser()).resolves.toEqual({
      id: "u2",
      email: "m@acme.example",
      name: "",
    });
  });

  it("is null without a session", async () => {
    getSession.mockResolvedValue(null);
    await expect(getAuthUser()).resolves.toBeNull();
  });
});
