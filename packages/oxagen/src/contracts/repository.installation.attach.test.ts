import { describe, expect, it } from "vitest";
import { repositoryInstallationAttach } from "./repository.installation.attach";

describe("attach_github_installation contract", () => {
  it("is a scoped settings write, Owner/Admin, billed to nobody", () => {
    expect(repositoryInstallationAttach.scoped).toBe(true);
    expect(repositoryInstallationAttach.mutates).toBe(true);
    expect(repositoryInstallationAttach.noBillingGate).toBe(true);
    expect(repositoryInstallationAttach.sensitivity).toBe("high");
    expect(repositoryInstallationAttach.defaultEffect).toBe("deny");
    expect(repositoryInstallationAttach.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    // The picker is a browser surface after a browser OAuth round trip; there
    // is no agent-shaped version of this choice.
    expect(repositoryInstallationAttach.surfaces).toEqual(["api"]);
  });

  it("takes the installation id and nothing else", () => {
    expect(
      repositoryInstallationAttach.input.parse({ installationId: "424242" }),
    ).toEqual({ installationId: "424242" });
    expect(
      repositoryInstallationAttach.input.safeParse({
        installationId: "424242",
        orgId: "org_other",
      }).success,
    ).toBe(false);
    expect(repositoryInstallationAttach.input.safeParse({}).success).toBe(
      false,
    );
  });

  // The pattern is the one `installationIdOf` accepts when the repository
  // capabilities read the id back out of a connection. A value it would
  // silently skip must never reach the row, or the connection looks attached
  // while every reader ignores it.
  it("refuses an installation id that is not a plain positive integer", () => {
    for (const bad of [
      "0",
      "-1",
      "12.5",
      "abc",
      "",
      " 42",
      "42 ",
      "042",
      "999999999999999999999",
    ]) {
      expect(
        repositoryInstallationAttach.input.safeParse({ installationId: bad })
          .success,
      ).toBe(false);
    }
    expect(
      repositoryInstallationAttach.input.safeParse({ installationId: 424242 })
        .success,
    ).toBe(false);
  });

  it("answers the connection it hangs off and the account it settled on", () => {
    const out = { connectionId: "con_abc123", accountLogin: "acme" };
    expect(repositoryInstallationAttach.output.parse(out)).toEqual(out);
    // GitHub reporting an installation without an account is not a reason to
    // refuse an attach reachability has already allowed.
    expect(
      repositoryInstallationAttach.output.parse({
        connectionId: "con_abc123",
        accountLogin: null,
      }),
    ).toEqual({ connectionId: "con_abc123", accountLogin: null });
  });

  // The installation id is deliberately NOT echoed back into a browser beyond
  // what the picker already showed, and no token ever is.
  it("refuses an output carrying anything the surface was not promised", () => {
    expect(
      repositoryInstallationAttach.output.safeParse({
        connectionId: "con_abc123",
        accountLogin: "acme",
        accessToken: "ghu_secret",
      }).success,
    ).toBe(false);
    for (const bad of ["abc123", "conn_abc123", "con_ABC", ""]) {
      expect(
        repositoryInstallationAttach.output.safeParse({
          connectionId: bad,
          accountLogin: "acme",
        }).success,
      ).toBe(false);
    }
  });
});
