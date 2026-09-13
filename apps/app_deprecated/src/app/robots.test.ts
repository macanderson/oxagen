import { describe, expect, it } from "vitest";

import robots from "./robots";

describe("app robots route", () => {
  it("disallows all crawling of the authed dashboard shell", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", disallow: "/" },
    });
  });
});
