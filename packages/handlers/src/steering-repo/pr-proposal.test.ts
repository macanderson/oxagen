// steering-repo/pr-proposal.ts: who a steering PR's proposal row names as
// its author (#5122, ADR-265). The author is the person the merge's
// separation of duties compares against, so a PR a key opened names the
// key's creator.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveActingUserId: vi.fn() }));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: mocks.resolveActingUserId,
}));

import { actingAuthor, authorOf } from "./pr-proposal";

beforeEach(() => {
  mocks.resolveActingUserId.mockReset();
});

describe("authorOf", () => {
  it("names the signed-in person", () => {
    expect(authorOf({ userId: "u_1", apiKeyId: null }, "u_1")).toEqual({
      userId: "u_1",
      source: "user:u_1",
    });
  });

  it("names the key's creator as the author of a call made with an API key, and the key as its source", () => {
    expect(authorOf({ userId: null, apiKeyId: "key_1" }, "u_key_owner")).toEqual({
      userId: "u_key_owner",
      source: "api_key:key_1",
    });
  });

  it("keeps the key as the source when the key resolves to no person", () => {
    expect(authorOf({ userId: null, apiKeyId: "key_1" }, null)).toEqual({
      userId: null,
      source: "api_key:key_1",
    });
  });

  it("names Oxagen when the call carried no credential", () => {
    expect(authorOf({ userId: null, apiKeyId: null }, null)).toEqual({
      userId: null,
      source: "oxagen",
    });
  });
});

describe("actingAuthor", () => {
  it("resolves the key's creator before it names the author", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_key_owner");
    const ctx = { orgId: "org_1", userId: null, apiKeyId: "key_1" };

    await expect(actingAuthor(ctx)).resolves.toEqual({
      userId: "u_key_owner",
      source: "api_key:key_1",
    });
    expect(mocks.resolveActingUserId).toHaveBeenCalledWith(ctx);
  });
});
