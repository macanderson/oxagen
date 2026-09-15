import { describe, expect, it } from "vitest";
import { repositoryMainBind } from "./repository.main.bind";

describe("bind_main_repository contract", () => {
  it("is a scoped settings write, Owner/Admin, that names the repository and never an installation", () => {
    expect(repositoryMainBind.scoped).toBe(true);
    expect(repositoryMainBind.mutates).toBe(true);
    expect(repositoryMainBind.noBillingGate).toBe(true);
    expect(repositoryMainBind.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    expect(Object.keys(repositoryMainBind.input.shape)).toEqual([
      "owner",
      "name",
    ]);
    expect(
      repositoryMainBind.input.safeParse({
        owner: "acme",
        name: "widgets",
        installationId: "424242",
      }).success,
    ).toBe(false);
  });

  it("accepts GitHub owner and repository names and refuses what GitHub would", () => {
    expect(
      repositoryMainBind.input.parse({ owner: "my-org", name: "my.repo_v2" }),
    ).toEqual({ owner: "my-org", name: "my.repo_v2" });
    for (const bad of [
      { owner: "-acme", name: "widgets" },
      { owner: "acme", name: "wid gets" },
      { owner: "acme/x", name: "widgets" },
      { owner: "", name: "widgets" },
    ]) {
      expect(repositoryMainBind.input.safeParse(bad).success).toBe(false);
    }
  });

  it("answers the binding, the connection, the default ref and whether the provisional window closed", () => {
    const out = {
      bindingId: "rpb_0123456789abcdef",
      connectionId: "con_0123456789",
      fullName: "acme/widgets",
      defaultRef: "main",
      boundAt: "2026-09-15T12:06:00.000Z",
      provisionalClosed: true,
    };
    expect(repositoryMainBind.output.parse(out)).toEqual(out);
    expect(
      repositoryMainBind.output.safeParse({ ...out, bindingId: "rpb_XYZ" })
        .success,
    ).toBe(false);
  });
});
