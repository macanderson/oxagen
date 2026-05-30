import { describe, expect, it } from "vitest";
import { workspaceCreate } from "./workspace.create.js";

describe("workspace.create capability", () => {
  it("parses a valid input", () => {
    const parsed = workspaceCreate.input.parse({
      name: "Default",
      slug: "default",
    });
    expect(parsed.slug).toBe("default");
  });

  it("rejects an invalid slug", () => {
    expect(() =>
      workspaceCreate.input.parse({ name: "Default", slug: "Has Space" }),
    ).toThrow();
  });

  it("rejects a too-short slug", () => {
    expect(() =>
      workspaceCreate.input.parse({ name: "Default", slug: "a" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = workspaceCreate.output.parse({
      publicId: "wrk_abc",
      name: "Default",
      slug: "default",
      orgSlug: "acme",
      createdAt: new Date().toISOString(),
    });
    expect(parsed.orgSlug).toBe("acme");
  });
});
