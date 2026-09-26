import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { runtimeCreate } from "./runtime.create";

describe("create_runtime contract", () => {
  it("is a settings write on api and mcp: mutates, unmetered, org Owner/Admin", () => {
    expect(getCapability("create_runtime")).toBe(runtimeCreate);
    expect(runtimeCreate.mutates).toBe(true);
    expect(runtimeCreate.noBillingGate).toBe(true);
    expect(runtimeCreate.scoped).toBe(true);
    expect(runtimeCreate.surfaces).toEqual(["api", "mcp"]);
    expect(runtimeCreate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes a name alone and leaves the slug to the server", () => {
    expect(runtimeCreate.input.parse({ name: "  Mac's laptop " })).toEqual({
      name: "Mac's laptop",
    });
  });

  it("refuses an empty name and a slug outside the one spelling", () => {
    expect(runtimeCreate.input.safeParse({ name: "   " }).success).toBe(false);
    for (const slug of [
      "Macs-Laptop",
      "macs--laptop",
      "macs-",
      "a".repeat(41),
    ]) {
      expect(
        runtimeCreate.input.safeParse({ name: "x", slug }).success,
        slug,
      ).toBe(false);
    }
    expect(
      runtimeCreate.input.safeParse({ name: "x", slug: "macs-laptop" }).success,
    ).toBe(true);
  });

  it("answers with the runtime by public id", () => {
    const runtime = {
      id: "rtm_0123456789abcdefghjkmn",
      name: "Mac's laptop",
      slug: "macs-laptop",
    };
    expect(runtimeCreate.output.parse({ runtime })).toEqual({ runtime });
    expect(
      runtimeCreate.output.safeParse({ runtime: { ...runtime, id: "x" } })
        .success,
    ).toBe(false);
  });
});
