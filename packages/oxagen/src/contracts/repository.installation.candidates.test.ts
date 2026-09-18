import { describe, expect, it } from "vitest";
import { repositoryInstallationCandidates } from "./repository.installation.candidates";

const INSTALLATION = {
  installationId: "424242",
  accountLogin: "acme",
  accountType: "Organization",
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  repositorySelection: "all",
};

describe("list_github_installations contract", () => {
  it("is a scoped settings read, Owner/Admin, that takes no input at all", () => {
    expect(repositoryInstallationCandidates.scoped).toBe(true);
    expect(repositoryInstallationCandidates.mutates).toBe(false);
    expect(repositoryInstallationCandidates.noBillingGate).toBe(true);
    expect(repositoryInstallationCandidates.sensitivity).toBe("high");
    expect(repositoryInstallationCandidates.defaultEffect).toBe("deny");
    expect(repositoryInstallationCandidates.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    expect(repositoryInstallationCandidates.input.parse({})).toEqual({});
    // Whose installations these are is the workspace's stored authorization,
    // never a caller's choice: the input is strict so there is nothing to name.
    expect(
      repositoryInstallationCandidates.input.safeParse({ accountLogin: "acme" })
        .success,
    ).toBe(false);
  });

  it("answers the reachable installations, and an empty list is a valid answer", () => {
    const out = { installations: [INSTALLATION] };
    expect(repositoryInstallationCandidates.output.parse(out)).toEqual(out);
    // An account that has authorized Oxagen and installed the App nowhere is
    // not a refusal — it is this, and the surface answers it with the install
    // door rather than a picker with nothing in it.
    expect(
      repositoryInstallationCandidates.output.parse({ installations: [] }),
    ).toEqual({ installations: [] });
  });

  it("takes the three optional facts as null rather than dropping them", () => {
    const sparse = {
      ...INSTALLATION,
      accountType: null,
      avatarUrl: null,
      repositorySelection: null,
    };
    expect(
      repositoryInstallationCandidates.output.parse({
        installations: [sparse],
      }),
    ).toEqual({ installations: [sparse] });
    for (const key of [
      "accountType",
      "avatarUrl",
      "repositorySelection",
    ] as const) {
      const partial: Record<string, unknown> = { ...INSTALLATION };
      delete partial[key];
      expect(
        repositoryInstallationCandidates.output.safeParse({
          installations: [partial],
        }).success,
      ).toBe(false);
    }
  });

  it("requires an account login the picker can name", () => {
    expect(
      repositoryInstallationCandidates.output.safeParse({
        installations: [{ ...INSTALLATION, accountLogin: "" }],
      }).success,
    ).toBe(false);
    expect(
      repositoryInstallationCandidates.output.safeParse({
        installations: [{ ...INSTALLATION, accountLogin: null }],
      }).success,
    ).toBe(false);
  });

  // The id is what `attach_github_installation` takes back, and what
  // `installationIdOf` reads out of a stored connection. A shape either of them
  // would refuse must not leave here looking like a choice a person can make.
  it("refuses an installation id that is not a plain positive integer", () => {
    for (const bad of ["0", "-1", "12.5", "abc", "", " 42", "42 "]) {
      expect(
        repositoryInstallationCandidates.output.safeParse({
          installations: [{ ...INSTALLATION, installationId: bad }],
        }).success,
      ).toBe(false);
    }
  });

  it("refuses an installation element carrying anything else, and a non-URL avatar", () => {
    expect(
      repositoryInstallationCandidates.output.safeParse({
        installations: [{ ...INSTALLATION, accessToken: "ghu_secret" }],
      }).success,
    ).toBe(false);
    expect(
      repositoryInstallationCandidates.output.safeParse({
        installations: [{ ...INSTALLATION, avatarUrl: "acme.png" }],
      }).success,
    ).toBe(false);
  });
});
