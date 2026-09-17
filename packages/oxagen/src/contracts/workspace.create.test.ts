import { describe, expect, it } from "vitest";
import { workspaceCreate } from "./workspace.create";

describe("workspace.create capability", () => {
  it("is a settings write, never a governed action (INV-28), with no e2e layer", () => {
    expect(workspaceCreate.noBillingGate).toBe(true);
    expect(workspaceCreate.mutates).toBe(true);
    expect(workspaceCreate.layers).not.toContain("e2e");
  });

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
